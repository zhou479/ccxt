//! 市场数据存档：在后台持续保存以后做多因子验证要用、但币安不长期提供的数据。
//!
//! - 每 5 分钟：全部合约的标记价、指数价、最新资金费率（一个请求拿全部合约）；
//! - 实时：强平推送 `!forceOrder@arr`。币安对每个合约每秒只推最新一条，行情激烈时会漏，
//!   所以只当作定性参考。连接期间记录会话区间，用来区分「没有爆仓」和「没在接收」；
//! - 每 6 小时：补拉每个合约最近的 5 分钟持仓量、大户持仓多空比和全市场账户多空比
//!   （币安只保留约 30 天，补拉比实时轮询省请求）。
//!
//! 设置 `PLAYGROUND_ARCHIVE=0` 可以关闭。

use std::sync::Arc;
use std::time::Duration;

use futures::{SinkExt, StreamExt};
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;

use crate::binance::{number, Endpoint};
use crate::history::{History, Kind, Liquidation};
use crate::now_ms;
use crate::signals::Fetcher;

const MINUTE: i64 = 60_000;
const SNAPSHOT_MS: i64 = 5 * MINUTE;
const BACKFILL_EVERY: Duration = Duration::from_secs(6 * 3600);
/// The first backfill of a contract reaches this far back; later ones continue from the cache.
const BACKFILL_START_MS: i64 = 2 * 86_400_000;
/// Archive requests are paced slower than scans, so both can run at once within Binance's limits.
const ARCHIVE_GAP: Duration = Duration::from_millis(1_200);
const LIQUIDATION_STREAM: &str = "wss://fstream.binance.com/market/ws/!forceOrder@arr";
/// Binance pings about every three minutes; a quiet connection beyond this is treated as dead.
const STREAM_IDLE: Duration = Duration::from_secs(300);
const FLUSH_EVERY: Duration = Duration::from_secs(5);

pub fn enabled() -> bool {
    std::env::var("PLAYGROUND_ARCHIVE").as_deref() != Ok("0")
}

pub async fn supervise(history: Arc<History>, stop: watch::Receiver<bool>) {
    let fetch = Fetcher::new(Arc::clone(&history), stop.clone(), ARCHIVE_GAP);
    tokio::join!(
        snapshots(&fetch, stop.clone()),
        backfill(&fetch, stop.clone()),
        liquidations(&history, stop),
    );
}

async fn wait(stop: &mut watch::Receiver<bool>, duration: Duration) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(duration) => !*stop.borrow(),
        _ = stop.changed() => false,
    }
}

/// Saves mark price, index price and funding of every contract at each five-minute boundary.
async fn snapshots(fetch: &Fetcher, mut stop: watch::Receiver<bool>) {
    loop {
        let now = now_ms();
        let next = (now.div_euclid(SNAPSHOT_MS) + 1) * SNAPSHOT_MS;
        if !wait(&mut stop, Duration::from_millis((next - now) as u64)).await {
            return;
        }
        if let Ok(rows) = fetch.get::<Vec<Value>>(Endpoint::PremiumIndex, json!({})).await {
            let _ = fetch.history().save_premium(next, &premium_rows(&rows));
        }
    }
}

fn premium_rows(rows: &[Value]) -> Vec<(String, f64, Option<f64>, Option<f64>)> {
    rows.iter()
        .filter_map(|row| {
            let mark = number(&row["markPrice"]).filter(|mark| *mark > 0.0)?;
            Some((
                row["symbol"].as_str()?.to_owned(),
                mark,
                number(&row["indexPrice"]).filter(|index| *index > 0.0),
                number(&row["lastFundingRate"]),
            ))
        })
        .collect()
}

/// Tops up open interest and long/short ratios for every listed contract.
async fn backfill(fetch: &Fetcher, mut stop: watch::Receiver<bool>) {
    // Let the service and any scan start first.
    if !wait(&mut stop, Duration::from_secs(120)).await {
        return;
    }
    loop {
        if let Ok(symbols) = fetch.listed().await {
            for symbol in symbols {
                if fetch.stopped() {
                    return;
                }
                let now = now_ms();
                let _ = fetch.cached_points(&symbol, Kind::OpenInterest, now - BACKFILL_START_MS, now).await;
                for (endpoint, kind, long, short) in [
                    (Endpoint::PositionRatio, "top-position", "longPosition", "shortPosition"),
                    (Endpoint::AccountRatio, "global-account", "longAccount", "shortAccount"),
                ] {
                    let query = json!({"symbol": symbol, "period": "5m", "limit": 500});
                    if let Ok(rows) = fetch.get::<Vec<Value>>(endpoint, query).await {
                        let _ = fetch.history().save_long_short(&symbol, kind, &ratio_points(&rows, long, short));
                    }
                }
            }
        }
        if !wait(&mut stop, BACKFILL_EVERY).await {
            return;
        }
    }
}

/// Long share of positions or accounts, 0–1, every five minutes.
fn ratio_points(rows: &[Value], long: &str, short: &str) -> Vec<(i64, f64)> {
    rows.iter()
        .filter_map(|row| {
            let (time, long, short) = (row["timestamp"].as_i64()?, number(&row[long])?, number(&row[short])?);
            (long + short > 0.0).then(|| (time, long / (long + short)))
        })
        .collect()
}

/// Receives every forced liquidation while connected and records the connected periods.
async fn liquidations(history: &History, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        let connected = tokio::time::timeout(Duration::from_secs(10), crate::monitor::connect_stream(LIQUIDATION_STREAM)).await;
        if let Ok(Ok(mut socket)) = connected {
            let Ok(session) = history.start_session(now_ms()) else {
                return;
            };
            let mut pending = Vec::new();
            let mut flush = tokio::time::interval(FLUSH_EVERY);
            loop {
                tokio::select! {
                    frame = tokio::time::timeout(STREAM_IDLE, socket.next()) => {
                        let Ok(Some(Ok(frame))) = frame else { break };
                        match frame {
                            Message::Text(text) => pending.extend(parse_liquidation(&text)),
                            Message::Ping(_) => {
                                if socket.flush().await.is_err() {
                                    break;
                                }
                            }
                            Message::Close(_) => break,
                            _ => {}
                        }
                    }
                    _ = flush.tick() => {
                        if history.save_liquidations(&pending).is_ok() {
                            pending.clear();
                        }
                        let _ = history.touch_session(session, now_ms());
                    }
                    _ = stop.changed() => break,
                }
            }
            let _ = history.save_liquidations(&pending);
            let _ = history.touch_session(session, now_ms());
        }
        if !wait(&mut stop, Duration::from_secs(5)).await {
            return;
        }
    }
}

fn parse_liquidation(text: &str) -> Option<Liquidation> {
    let event: Value = serde_json::from_str(text).ok()?;
    if event["e"] != "forceOrder" {
        return None;
    }
    let order = &event["o"];
    let price = number(&order["ap"]).filter(|price| *price > 0.0).or_else(|| number(&order["p"]))?;
    let quantity = number(&order["z"]).filter(|quantity| *quantity > 0.0).or_else(|| number(&order["q"]))?;
    let side = order["S"].as_str().filter(|side| matches!(*side, "BUY" | "SELL"))?;
    if price <= 0.0 || quantity <= 0.0 {
        return None;
    }
    Some(Liquidation {
        time: order["T"].as_i64().or_else(|| event["E"].as_i64())?,
        symbol: order["s"].as_str()?.to_owned(),
        side: side.to_owned(),
        price,
        quantity,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_liquidation_orders_and_ratios() {
        let text = r#"{"e":"forceOrder","E":1568014460893,"o":{"s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC",
            "q":"0.014","p":"9910","ap":"9900","X":"FILLED","l":"0.014","z":"0.012","T":1568014460890}}"#;
        let liquidation = parse_liquidation(text).unwrap();
        assert_eq!((liquidation.side.as_str(), liquidation.price, liquidation.quantity), ("SELL", 9900.0, 0.012));
        assert_eq!(liquidation.time, 1568014460890);
        assert!(parse_liquidation(r#"{"e":"aggTrade"}"#).is_none());

        let ratios = ratio_points(&[json!({"longPosition": "0.6", "shortPosition": "0.4", "timestamp": 5})], "longPosition", "shortPosition");
        assert_eq!(ratios, vec![(5, 0.6)]);
        let premium = premium_rows(&[json!({"symbol": "BTCUSDT", "markPrice": "100", "indexPrice": "99.9", "lastFundingRate": "0.0001"})]);
        assert_eq!(premium, vec![("BTCUSDT".to_owned(), 100.0, Some(99.9), Some(0.0001))]);
    }
}

//! 研究数据集：检验中低频策略（资金费率、趋势）用的小时K线和资金费率。
//!
//! - 合约全集包含已下架合约，减少只看「今天还活着的币」带来的幸存者偏差。已下架合约来自
//!   交易所列表里的 SETTLING 合约，以及币安公开数据仓库（data.binance.vision）里有、交易所列表里已经没有的合约。
//! - 下架后币安仍返回成交额为 0 的平盘K线，读取时截掉。
//! - 行情阶段按 BTC 日收盘价和 200 日均线划分，只用当天及以前的数据，次日起生效。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use crate::binance::Endpoint;
use crate::history::{Bar, Contract, History, Kind};
use crate::now_ms;
use crate::signals::Fetcher;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// 币安用这个交割日期标记永不交割的永续合约。
const NO_DELIVERY: i64 = 4_133_404_800_000;
const MIN_DAYS: i64 = 30;
const MAX_DAYS: i64 = 1_095;
/// 1 分钟K线和持仓量只下载成交额最靠前的这么多个合约。
const MINUTE_TOP: usize = 100;
const MINUTE_MAX_DAYS: i64 = 30;
/// 币安的持仓量历史只保留约 30 天。
const OPEN_INTEREST_DAYS: i64 = 29;
/// 区分牛熊的 BTC 均线天数。
const REGIME_AVERAGE: usize = 200;
/// 均线上升或下降：和这么多天前的均线值比较。
const REGIME_SLOPE: usize = 20;
/// 当天小时K线至少有这么多根才算一个完整交易日。
const MIN_DAY_BARS: usize = 20;
/// 资金费率历史接口每个 IP 每 5 分钟约 500 次，请求间隔留在这个限制以下。
const DATASET_GAP: Duration = Duration::from_millis(700);
const ARCHIVE_LIST: &str = "https://s3-ap-northeast-1.amazonaws.com/data.binance.vision";
const ARCHIVE_PREFIX: &str = "data/futures/um/monthly/klines/";
const MAX_ARCHIVE_PAGES: usize = 10;
const MAX_FAILED_SHOWN: usize = 20;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Regime {
    Bull,
    Bear,
    Range,
}

impl Regime {
    pub fn key(self) -> &'static str {
        match self {
            Regime::Bull => "bull",
            Regime::Bear => "bear",
            Regime::Range => "range",
        }
    }
}

/// 研究数据的种类。`All` 是旧的「一起下载」：合约列表 + 小时K线 + 资金费率。
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DataKind {
    #[default]
    All,
    Contracts,
    Hourly,
    Funding,
    Minute,
    OpenInterest,
    Premium,
    Liquidation,
    LongShort,
}

impl DataKind {
    pub fn key(self) -> &'static str {
        match self {
            DataKind::All => "all",
            DataKind::Contracts => "contracts",
            DataKind::Hourly => "hourly",
            DataKind::Funding => "funding",
            DataKind::Minute => "minute",
            DataKind::OpenInterest => "openInterest",
            DataKind::Premium => "premium",
            DataKind::Liquidation => "liquidation",
            DataKind::LongShort => "longShort",
        }
    }

    fn label(self) -> &'static str {
        match self {
            DataKind::All => "研究数据",
            DataKind::Contracts => "合约列表",
            DataKind::Hourly => "小时K线",
            DataKind::Funding => "资金费率",
            DataKind::Minute => "1 分钟K线",
            DataKind::OpenInterest => "持仓量",
            DataKind::Premium => "资金费率快照",
            DataKind::Liquidation => "强平单",
            DataKind::LongShort => "多空比",
        }
    }

    /// 存档类数据由程序运行时自动记录，不能手动「更新」。
    fn updatable(self) -> bool {
        !matches!(self, DataKind::Premium | DataKind::Liquidation | DataKind::LongShort)
    }

    /// 删除这类数据要执行的语句（连同「已下载区间」一起删，下次更新会重新下载）。
    fn delete_statements(self) -> &'static [&'static str] {
        match self {
            DataKind::All => &[],
            DataKind::Contracts => &["DELETE FROM contract_list"],
            DataKind::Hourly => &["DELETE FROM kline_1h", "DELETE FROM coverage WHERE kind = 'kline_1h'"],
            DataKind::Funding => &["DELETE FROM funding", "DELETE FROM coverage WHERE kind = 'funding'"],
            DataKind::Minute => &["DELETE FROM kline_1m", "DELETE FROM coverage WHERE kind = 'kline_1m'"],
            DataKind::OpenInterest => &["DELETE FROM open_interest_5m", "DELETE FROM coverage WHERE kind = 'open_interest_5m'"],
            DataKind::Premium => &["DELETE FROM premium_5m"],
            DataKind::Liquidation => &["DELETE FROM liquidation", "DELETE FROM stream_session"],
            DataKind::LongShort => &["DELETE FROM long_short_5m"],
        }
    }
}

fn default_days() -> i64 {
    730
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct PrepareParams {
    #[serde(default = "default_days")]
    pub days: i64,
    #[serde(default)]
    pub kind: DataKind,
}

impl PrepareParams {
    fn validate(self) -> Result<Self, String> {
        if !self.kind.updatable() {
            return Err(format!("{}由程序运行时自动记录，不能手动更新。", self.kind.label()));
        }
        let range = if self.kind == DataKind::Minute { 1..=MINUTE_MAX_DAYS } else { MIN_DAYS..=MAX_DAYS };
        if matches!(self.kind, DataKind::All | DataKind::Hourly | DataKind::Funding | DataKind::Minute) && !range.contains(&self.days) {
            return Err(format!("数据天数需在 {}–{} 天之间。", range.start(), range.end()));
        }
        Ok(self)
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct DeleteParams {
    pub kind: DataKind,
}

pub struct Dataset {
    fetch: Fetcher,
    client: reqwest::Client,
    state: Mutex<Value>,
    /// 用户点了「停止下载」：下载完当前合约就停下，已下载的部分保留，下次接着下。
    cancel: AtomicBool,
}

const STOPPED_MESSAGE: &str = "已取消更新。已下载的部分保留在本地，再点「更新」会接着下。";

impl Dataset {
    pub fn new(history: Arc<History>, stop: watch::Receiver<bool>) -> crate::store::Result<Self> {
        let client = reqwest::Client::builder()
            .user_agent(crate::HTTP_USER_AGENT)
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            fetch: Fetcher::new(history, stop, DATASET_GAP),
            client,
            state: Mutex::new(json!({"status": "idle"})),
            cancel: AtomicBool::new(false),
        })
    }

    pub async fn snapshot(&self) -> Result<Value, String> {
        let history = self.fetch.history();
        let btc = history.candles(Kind::HourKlines, "BTCUSDT", 0, i64::MAX).map_err(|_| "无法读取本地K线。".to_owned())?;
        let regimes = segments(&regimes(&daily_closes(&btc)));
        Ok(json!({
            "job": self.state.lock().await.clone(),
            "summary": self.fetch.shared_history().status_in_background().await,
            "regimes": regimes,
        }))
    }

    pub async fn start(self: &Arc<Self>, params: PrepareParams) -> Result<Value, String> {
        let params = params.validate()?;
        {
            let mut state = self.state.lock().await;
            if state["status"] == "running" {
                return Err("数据正在下载，请等待完成。".into());
            }
            *state = json!({
                "status": "running", "startedAt": now_ms(), "days": params.days,
                "kind": params.kind.key(), "label": params.kind.label(),
                "done": 0, "total": 0, "skipped": 0, "failed": [], "failedCount": 0,
            });
            self.cancel.store(false, Ordering::Relaxed);
        }
        let dataset = Arc::clone(self);
        tokio::spawn(async move {
            let result = dataset.prepare(params.kind, params.days).await;
            // 更新完马上重新数，页面上的数量不用等一分钟。
            dataset.fetch.history().invalidate_status();
            let mut state = dataset.state.lock().await;
            state["finishedAt"] = json!(now_ms());
            match result {
                Ok(()) => state["status"] = json!("done"),
                Err(error) => {
                    state["status"] = json!(if dataset.cancel.load(Ordering::Relaxed) {
                        "stopped"
                    } else if dataset.fetch.stopped() {
                        "interrupted"
                    } else {
                        "failed"
                    });
                    state["error"] = json!(error);
                }
            }
        });
        Ok(self.state.lock().await.clone())
    }

    /// 停止正在进行的下载：当前合约下载完就停，不会留下半截数据。
    pub async fn cancel(&self) -> Value {
        if self.state.lock().await["status"] == "running" {
            self.cancel.store(true, Ordering::Relaxed);
        }
        self.state.lock().await.clone()
    }

    async fn update(&self, change: impl FnOnce(&mut Value)) {
        change(&mut *self.state.lock().await);
    }

    /// 删除一类数据（连同已下载区间），下次更新会重新下载。正在更新时不能删除。
    pub async fn delete(&self, params: DeleteParams) -> Result<Value, String> {
        if params.kind == DataKind::All {
            return Err("请选择要删除的数据。".into());
        }
        if self.state.lock().await["status"] == "running" {
            return Err("正在更新数据，请先取消更新再删除。".into());
        }
        let history = self.fetch.shared_history();
        let statements = params.kind.delete_statements();
        tokio::task::spawn_blocking(move || history.delete_rows(statements))
            .await
            .map_err(|_| "删除意外中止。".to_owned())?
            .map_err(|_| "删除失败，请稍后重试。".to_owned())?;
        self.fetch.history().invalidate_status();
        Ok(json!({"deleted": params.kind.key()}))
    }

    /// 检查是否该停：服务关闭或用户取消更新。
    fn interrupted(&self) -> Option<String> {
        if self.fetch.stopped() {
            Some("服务正在关闭，更新已停止。".into())
        } else if self.cancel.load(Ordering::Relaxed) {
            Some(STOPPED_MESSAGE.into())
        } else {
            None
        }
    }

    /// 记录一个合约的结果，并推进进度。
    async fn record(&self, index: usize, symbol: &str, result: Result<(), String>) {
        if let Err(error) = result {
            let symbol = symbol.to_owned();
            self.update(|state| {
                state["failedCount"] = json!(state["failedCount"].as_i64().unwrap_or(0) + 1);
                if let Some(failed) = state["failed"].as_array_mut().filter(|list| list.len() < MAX_FAILED_SHOWN) {
                    failed.push(json!({"symbol": symbol, "error": error}));
                }
            })
            .await;
        }
        self.update(|state| state["done"] = json!(index + 1)).await;
    }

    async fn skip(&self) {
        self.update(|state| state["skipped"] = json!(state["skipped"].as_i64().unwrap_or(0) + 1)).await;
    }

    /// 从交易所列表和公开数据仓库重新整理合约全集，并保存。
    async fn refresh_universe(&self) -> Result<Vec<Contract>, String> {
        let info: Value = self.fetch.get(Endpoint::ExchangeInfo, json!({})).await?;
        let archived = match self.archived_symbols().await {
            Ok(symbols) => symbols,
            Err(error) => {
                self.update(|state| state["archiveError"] = json!(error)).await;
                Vec::new()
            }
        };
        let contracts = universe(&info, &archived);
        if contracts.is_empty() {
            return Err("币安合约列表为空。".into());
        }
        self.fetch.history().save_contracts(&contracts).map_err(|_| "无法保存合约列表。".to_owned())?;
        Ok(contracts)
    }

    /// 本地的合约全集；还没有时先整理一次。
    async fn contracts(&self) -> Result<Vec<Contract>, String> {
        let saved = self.fetch.history().contracts().map_err(|_| "无法读取合约列表。".to_owned())?;
        if saved.is_empty() { self.refresh_universe().await } else { Ok(saved) }
    }

    /// 现在 24 小时成交额最靠前的合约（1 分钟K线和持仓量只下载这些）。
    async fn top_contracts(&self, count: usize) -> Result<Vec<String>, String> {
        let listed: HashSet<String> = self.fetch.listed().await?.into_iter().collect();
        let tickers: Vec<Value> = self.fetch.get(Endpoint::Ticker, json!({})).await?;
        let mut ranked: Vec<(String, f64)> = tickers
            .iter()
            .filter_map(|ticker| {
                let symbol = ticker["symbol"].as_str()?;
                listed.contains(symbol).then(|| (symbol.to_owned(), crate::binance::number(&ticker["quoteVolume"]).unwrap_or(0.0)))
            })
            .collect();
        ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
        ranked.truncate(count);
        Ok(ranked.into_iter().map(|(symbol, _)| symbol).collect())
    }

    async fn prepare(&self, kind: DataKind, days: i64) -> Result<(), String> {
        let now = now_ms();
        let from = now - days * DAY;
        match kind {
            DataKind::Contracts => {
                self.update(|state| state["total"] = json!(1)).await;
                self.refresh_universe().await?;
                self.update(|state| state["done"] = json!(1)).await;
                Ok(())
            }
            DataKind::All | DataKind::Hourly | DataKind::Funding => {
                let mut contracts = if kind == DataKind::All { self.refresh_universe().await? } else { self.contracts().await? };
                let total = contracts.len();
                self.update(|state| state["total"] = json!(total)).await;
                if kind != DataKind::Funding {
                    // BTC 要多下载一段，用来计算 200 日均线。
                    let regime_from = from - (REGIME_AVERAGE + REGIME_SLOPE + 10) as i64 * DAY;
                    self.fetch.cached_candles("BTCUSDT", Kind::HourKlines, regime_from, now).await?;
                }
                for index in 0..contracts.len() {
                    if let Some(reason) = self.interrupted() {
                        // 中途取消时也保存已经补上的下架时间。
                        let _ = self.fetch.history().save_contracts(&contracts);
                        return Err(reason);
                    }
                    let contract = contracts[index].clone();
                    let start = contract.onboard.map_or(from, |onboard| from.max(onboard.div_euclid(HOUR) * HOUR));
                    let end = contract.delisted.map_or(now, |delisted| delisted.min(now));
                    if end <= start {
                        self.skip().await;
                        self.record(index, &contract.symbol, Ok(())).await;
                        continue;
                    }
                    let result = self.download(&contract, kind, start, end).await.map(|last_trade| {
                        // 只在公开数据仓库里的合约，以最后一根有成交的K线作为下架时间。
                        if contract.delisted.is_none() && contract.status != "TRADING" && last_trade.is_some() {
                            contracts[index].delisted = last_trade;
                        }
                    });
                    self.record(index, &contract.symbol, result).await;
                }
                self.fetch.history().save_contracts(&contracts).map_err(|_| "无法保存合约列表。".to_owned())
            }
            DataKind::Minute | DataKind::OpenInterest => {
                let symbols = self.top_contracts(MINUTE_TOP).await?;
                let total = symbols.len();
                self.update(|state| state["total"] = json!(total)).await;
                for (index, symbol) in symbols.iter().enumerate() {
                    if let Some(reason) = self.interrupted() {
                        return Err(reason);
                    }
                    let result = if kind == DataKind::Minute {
                        self.fetch.cached_bars(symbol, from, now).await.map(|_| ())
                    } else {
                        self.fetch.cached_points(symbol, Kind::OpenInterest, now - OPEN_INTEREST_DAYS * DAY, now).await.map(|_| ())
                    };
                    self.record(index, symbol, result).await;
                }
                Ok(())
            }
            DataKind::Premium | DataKind::Liquidation | DataKind::LongShort => Err("这类数据不能手动更新。".into()),
        }
    }

    /// 下载一个合约的小时K线和 / 或资金费率，返回合约最后一次有成交的时间。
    /// 只更新资金费率时，用本地已有的小时K线判断最后交易时间，不重新下载K线。
    async fn download(&self, contract: &Contract, kind: DataKind, start: i64, end: i64) -> Result<Option<i64>, String> {
        let bars = if kind == DataKind::Funding {
            self.fetch.history().candles(Kind::HourKlines, &contract.symbol, start, end).map_err(|_| "无法读取本地K线。".to_owned())?
        } else {
            self.fetch.cached_candles(&contract.symbol, Kind::HourKlines, start, end).await?
        };
        let last_trade = trading_bars(&bars, contract.delisted).last().map(|bar| bar.end);
        if kind != DataKind::Hourly {
            let funding_end = last_trade.unwrap_or(end).min(end);
            if funding_end > start {
                self.fetch.cached_points(&contract.symbol, Kind::Funding, start, funding_end).await?;
            }
        }
        Ok(last_trade)
    }

    /// 币安公开数据仓库里的 USDT 永续合约，包括已经从交易所列表移除的合约。
    async fn archived_symbols(&self) -> Result<Vec<String>, String> {
        let mut symbols = Vec::new();
        let mut marker = String::new();
        for _ in 0..MAX_ARCHIVE_PAGES {
            let mut query = vec![("delimiter", "/".to_owned()), ("prefix", ARCHIVE_PREFIX.to_owned())];
            if !marker.is_empty() {
                query.push(("marker", marker.clone()));
            }
            let response = self.client.get(ARCHIVE_LIST).query(&query).send().await;
            let text = match response {
                Ok(response) if response.status().is_success() => response.text().await.map_err(|_| "读取公开数据仓库失败。".to_owned())?,
                _ => return Err("无法访问币安公开数据仓库，已下架合约只包含交易所列表里的。".into()),
            };
            let (page, truncated) = archive_page(&text);
            let Some(last) = page.last().cloned() else {
                break;
            };
            symbols.extend(page);
            if !truncated {
                return Ok(symbols);
            }
            marker = format!("{ARCHIVE_PREFIX}{last}/");
        }
        Ok(symbols)
    }
}

/// 合约全集：交易中和已下架的 USDT 加密永续合约，加上只在公开数据仓库里的合约。
pub fn universe(info: &Value, archived: &[String]) -> Vec<Contract> {
    let symbols = info["symbols"].as_array().map(Vec::as_slice).unwrap_or_default();
    let known: HashSet<&str> = symbols.iter().filter_map(|market| market["symbol"].as_str()).collect();
    let mut contracts: Vec<Contract> = symbols
        .iter()
        .filter_map(|market| {
            let crypto = market["contractType"] == "PERPETUAL"
                && market["quoteAsset"] == "USDT"
                && market["marginAsset"] == "USDT"
                && matches!(market["underlyingType"].as_str(), Some("COIN" | "PREMARKET"));
            let status = market["status"].as_str()?;
            if !crypto || !matches!(status, "TRADING" | "SETTLING" | "CLOSE") {
                return None;
            }
            let delivery = market["deliveryDate"].as_i64().filter(|date| *date < NO_DELIVERY);
            Some(Contract {
                symbol: market["symbol"].as_str()?.to_owned(),
                onboard: market["onboardDate"].as_i64(),
                delisted: if status == "TRADING" { None } else { delivery },
                status: status.to_owned(),
            })
        })
        .collect();
    contracts.extend(
        archived
            .iter()
            .filter(|symbol| symbol.ends_with("USDT") && !symbol.contains('_') && !known.contains(symbol.as_str()))
            .map(|symbol| Contract { symbol: symbol.clone(), onboard: None, delisted: None, status: "ARCHIVED".into() }),
    );
    contracts.sort_by(|left, right| left.symbol.cmp(&right.symbol));
    contracts.dedup_by(|left, right| left.symbol == right.symbol);
    contracts
}

/// 解析公开数据仓库一页 S3 列表里的合约名，并返回是否还有下一页。
fn archive_page(xml: &str) -> (Vec<String>, bool) {
    let mut names = Vec::new();
    for part in xml.split("<Prefix>").skip(1) {
        let Some(prefix) = part.split("</Prefix>").next() else { continue };
        if let Some(name) = prefix.strip_prefix(ARCHIVE_PREFIX).and_then(|rest| rest.strip_suffix('/')) {
            if !name.is_empty() && !name.contains('/') {
                names.push(name.to_owned());
            }
        }
    }
    (names, xml.contains("<IsTruncated>true</IsTruncated>"))
}

/// 只保留合约交易期间的K线：去掉下架之后的部分，以及末尾成交额为 0 的平盘K线。
pub fn trading_bars(bars: &[Bar], delisted: Option<i64>) -> &[Bar] {
    let listed = delisted.map_or(bars.len(), |delisted| bars.partition_point(|bar| bar.time < delisted));
    let active = bars[..listed].iter().rposition(|bar| bar.quote > 0.0).map_or(0, |index| index + 1);
    &bars[..active]
}

/// 每个 UTC 日的收盘价 `(当天开始时间, 收盘价)`，小时K线不够的日子跳过。
pub fn daily_closes(hours: &[Bar]) -> Vec<(i64, f64)> {
    let mut days: Vec<(i64, f64, usize)> = Vec::new();
    for bar in hours {
        let day = bar.time.div_euclid(DAY) * DAY;
        match days.last_mut() {
            Some(last) if last.0 == day => {
                last.1 = bar.close;
                last.2 += 1;
            }
            _ => days.push((day, bar.close, 1)),
        }
    }
    days.into_iter().filter(|day| day.2 >= MIN_DAY_BARS).map(|(day, close, _)| (day, close)).collect()
}

/// 每天的行情阶段，按前一天收盘价和 200 日均线判断：
/// 收盘在上升的均线之上为牛市，在下降的均线之下为熊市，其余为震荡。
pub fn regimes(closes: &[(i64, f64)]) -> Vec<(i64, Regime)> {
    let mut sums = vec![0.0];
    for (_, close) in closes {
        sums.push(sums.last().copied().unwrap_or(0.0) + close);
    }
    let average = |index: usize| (sums[index + 1] - sums[index + 1 - REGIME_AVERAGE]) / REGIME_AVERAGE as f64;
    let mut labels = Vec::new();
    for index in REGIME_AVERAGE - 1 + REGIME_SLOPE..closes.len() {
        // 只用连续的交易日计算均线，缺一天会把窗口拉长。
        if closes[index].0 - closes[index + 1 - REGIME_AVERAGE - REGIME_SLOPE].0 != (REGIME_AVERAGE + REGIME_SLOPE - 1) as i64 * DAY {
            continue;
        }
        let (now, before) = (average(index), average(index - REGIME_SLOPE));
        let close = closes[index].1;
        let regime = if close > now && now > before {
            Regime::Bull
        } else if close < now && now < before {
            Regime::Bear
        } else {
            Regime::Range
        };
        labels.push((closes[index].0 + DAY, regime));
    }
    labels
}

/// 把连续相同阶段的日子合并成区间，供页面显示。
fn segments(labels: &[(i64, Regime)]) -> Vec<Value> {
    let mut runs: Vec<(i64, i64, Regime)> = Vec::new();
    for (day, regime) in labels {
        match runs.last_mut() {
            Some(last) if last.2 == *regime && last.1 == *day => last.1 = day + DAY,
            _ => runs.push((*day, day + DAY, *regime)),
        }
    }
    runs.into_iter().map(|(start, end, regime)| json!({"start": start, "end": end, "regime": regime.key()})).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(time: i64, close: f64, quote: f64) -> Bar {
        Bar { time, end: time + HOUR, open: close, high: close, low: close, close, quote, taker_quote: 0.0 }
    }

    #[test]
    fn the_universe_keeps_delisted_crypto_perpetuals_and_archive_only_contracts() {
        let info = json!({"symbols": [
            {"symbol": "BTCUSDT", "contractType": "PERPETUAL", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "COIN", "status": "TRADING", "onboardDate": 1, "deliveryDate": NO_DELIVERY},
            {"symbol": "OMGUSDT", "contractType": "PERPETUAL", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "COIN", "status": "SETTLING", "onboardDate": 2, "deliveryDate": 50},
            {"symbol": "NEWUSDT", "contractType": "PERPETUAL", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "COIN", "status": "PENDING_TRADING", "onboardDate": 3, "deliveryDate": NO_DELIVERY},
            {"symbol": "BTCDOMUSDT", "contractType": "PERPETUAL", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "INDEX", "status": "TRADING", "onboardDate": 1, "deliveryDate": NO_DELIVERY},
            {"symbol": "TSLAUSDT", "contractType": "TRADIFI_PERPETUAL", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "EQUITY", "status": "TRADING", "onboardDate": 1, "deliveryDate": NO_DELIVERY},
            {"symbol": "BTCUSDT_260327", "contractType": "CURRENT_QUARTER", "quoteAsset": "USDT", "marginAsset": "USDT",
             "underlyingType": "COIN", "status": "TRADING", "onboardDate": 1, "deliveryDate": 99},
        ]});
        let archived = ["SRMUSDT", "BTCDOMUSDT", "BTCUSDT", "ETHBTC", "ETHUSDT_230630"].map(String::from);
        let contracts = universe(&info, &archived);
        let summary: Vec<_> = contracts.iter().map(|c| (c.symbol.as_str(), c.delisted, c.status.as_str())).collect();
        assert_eq!(summary, vec![("BTCUSDT", None, "TRADING"), ("OMGUSDT", Some(50), "SETTLING"), ("SRMUSDT", None, "ARCHIVED")]);
    }

    #[test]
    fn data_kinds_parse_and_only_downloaded_data_can_be_updated() {
        let params: PrepareParams = serde_json::from_value(json!({"kind": "openInterest"})).unwrap();
        assert_eq!((params.kind, params.days), (DataKind::OpenInterest, 730));
        // 不传种类时是旧的「一起下载」。
        assert_eq!(serde_json::from_value::<PrepareParams>(json!({"days": 365})).unwrap().kind, DataKind::All);
        assert!(PrepareParams { days: 730, kind: DataKind::Liquidation }.validate().unwrap_err().contains("自动记录"));
        assert!(PrepareParams { days: 30, kind: DataKind::Minute }.validate().is_ok());
        assert!(PrepareParams { days: 60, kind: DataKind::Minute }.validate().is_err());
        assert!(PrepareParams { days: 10, kind: DataKind::Hourly }.validate().is_err());
    }

    #[tokio::test]
    async fn deleting_clears_one_kind_of_data_and_its_coverage() {
        let (_stop, stopped) = watch::channel(false);
        let history = Arc::new(History::open_memory().unwrap());
        history.save_candles(Kind::HourKlines, "BTCUSDT", &[bar(0, 1.0, 1.0)]).unwrap();
        history.set_coverage("BTCUSDT", Kind::HourKlines, 0, HOUR).unwrap();
        history.save_points("BTCUSDT", Kind::Funding, &[(0, 0.0001)]).unwrap();
        let dataset = Dataset::new(Arc::clone(&history), stopped).unwrap();
        dataset.delete(DeleteParams { kind: DataKind::Hourly }).await.unwrap();
        assert!(history.candles(Kind::HourKlines, "BTCUSDT", 0, HOUR).unwrap().is_empty());
        assert_eq!(history.coverage("BTCUSDT", Kind::HourKlines).unwrap(), None);
        // 其他种类不受影响。
        assert_eq!(history.points("BTCUSDT", Kind::Funding, 0, HOUR).unwrap().len(), 1);
        // 正在更新时不能删除。
        *dataset.state.lock().await = json!({"status": "running"});
        assert!(dataset.delete(DeleteParams { kind: DataKind::Funding }).await.unwrap_err().contains("取消更新"));
        assert!(dataset.delete(DeleteParams { kind: DataKind::All }).await.is_err());
    }

    #[tokio::test]
    async fn stopping_only_flags_a_running_download() {
        let (_stop, stopped) = watch::channel(false);
        let dataset = Dataset::new(Arc::new(History::open_memory().unwrap()), stopped).unwrap();
        // 没在下载时点停止，什么也不做。
        assert_eq!(dataset.cancel().await["status"], "idle");
        assert!(!dataset.cancel.load(Ordering::Relaxed));
        *dataset.state.lock().await = json!({"status": "running"});
        dataset.cancel().await;
        assert!(dataset.cancel.load(Ordering::Relaxed));
    }

    #[test]
    fn archive_listing_pages_yield_contract_names() {
        let xml = "<ListBucketResult><IsTruncated>true</IsTruncated><Prefix>data/futures/um/monthly/klines/</Prefix>\
            <CommonPrefixes><Prefix>data/futures/um/monthly/klines/0GUSDT/</Prefix></CommonPrefixes>\
            <CommonPrefixes><Prefix>data/futures/um/monthly/klines/SRMUSDT/</Prefix></CommonPrefixes></ListBucketResult>";
        assert_eq!(archive_page(xml), (vec!["0GUSDT".to_owned(), "SRMUSDT".to_owned()], true));
        assert!(!archive_page("<IsTruncated>false</IsTruncated>").1);
    }

    #[test]
    fn delisted_contracts_lose_their_flat_zero_volume_tail() {
        let bars = vec![bar(0, 1.0, 5.0), bar(HOUR, 1.0, 0.0), bar(2 * HOUR, 1.0, 3.0), bar(3 * HOUR, 1.0, 0.0), bar(4 * HOUR, 1.0, 0.0)];
        // 中间没有成交的一小时保留，末尾的平盘去掉。
        assert_eq!(trading_bars(&bars, None).len(), 3);
        assert_eq!(trading_bars(&bars, Some(2 * HOUR)).len(), 1);
        assert!(trading_bars(&bars[3..], None).is_empty());
    }

    #[test]
    fn regimes_follow_the_200_day_average_from_the_next_day() {
        let hours = |day: i64, close: f64| (0..24).map(move |hour| bar(day * DAY + hour * HOUR, close, 1.0));
        // 先涨 230 天，再跌 230 天。
        let mut bars: Vec<Bar> = (0..230).flat_map(|day| hours(day, 100.0 + day as f64)).collect();
        bars.extend((230..460).flat_map(|day| hours(day, 330.0 - (day - 230) as f64)));
        let closes = daily_closes(&bars);
        assert_eq!(closes.len(), 460);
        let labels = regimes(&closes);
        assert_eq!(labels[0], (220 * DAY, Regime::Bull));
        assert_eq!(labels.last().unwrap().1, Regime::Bear);
        assert!(labels.iter().any(|(_, regime)| *regime == Regime::Range));
        let runs = segments(&labels);
        assert_eq!(runs.first().unwrap()["regime"], "bull");
        assert_eq!(runs.last().unwrap()["end"], 461 * DAY);
        // 小时K线不足的一天不计入。
        assert_eq!(daily_closes(&bars[..30]).len(), 1);
    }
}

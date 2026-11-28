//! 信号效果统计：回答「异动出现后追进去，扣除成本后能不能赚钱，在什么条件下更容易赚钱」。
//!
//! 样本有两个来源，用同一套计算：
//! - 实时告警（live）：异动监控策略记录的异动，发生 1 小时后自动补算结果；
//! - 历史扫描（scan）：用历史 1 分钟K线按同样思路找出过去的异动，几分钟就能拿到大量样本。
//!
//! 每个样本记录两部分：
//! - 发生时的特征：大盘（BTC）、前 1 小时涨跌、持仓量变化、主动买入占比、资金费率、24 小时成交额；
//! - 之后 60 分钟的走势：各时间点的顺势收益、最大浮盈 / 浮亏，以及多组止损止盈的模拟结果
//!   （顺势追进去和反向操作各算一份）。
//!
//! 这里只记录毛收益，手续费和滑点由页面按选择的成本统一扣除。

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use rusqlite::params;
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use crate::binance::{number, Binance, Endpoint, UpstreamError};
use crate::history::{self, Bar, History, Kind};
use crate::now_ms;
use crate::store::Store;
use crate::strategy::turnover_baseline;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;
const DAY: i64 = 24 * HOUR;
const BEIJING_OFFSET_MS: i64 = 8 * HOUR;
/// Outcomes are followed for four hours after entry (the longest exit plan).
const FOLLOW_MINUTES: i64 = 240;
const HORIZONS: [i64; 7] = [1, 5, 15, 30, 60, 120, 240];
/// The largest favourable and adverse moves are measured over the first hour.
const EXCURSION_MINUTES: i64 = 60;

/// One way of leaving a trade, simulated for every sample on both sides.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Plan {
    /// Fixed stop and take, %.
    Fixed { stop: f64, take: f64, hold: i64 },
    /// Stop and take in multiples of the coin's hourly volatility (σ of one-minute returns × √60).
    Volatility { stop: f64, take: f64, hold: i64 },
    /// Fixed stop and take; once the gain reaches the stop distance, the stop moves to the entry price.
    Breakeven { stop: f64, take: f64, hold: i64 },
    /// No take: the stop trails the best price reached by `stop` %.
    Trailing { stop: f64, hold: i64 },
}

impl Plan {
    fn hold(self) -> i64 {
        match self {
            Plan::Fixed { hold, .. } | Plan::Volatility { hold, .. } | Plan::Breakeven { hold, .. } | Plan::Trailing { hold, .. } => hold,
        }
    }

    fn describe(self) -> Value {
        match self {
            Plan::Fixed { stop, take, hold } => json!({"kind": "fixed", "stop": stop, "take": take, "hold": hold}),
            Plan::Volatility { stop, take, hold } => json!({"kind": "volatility", "stop": stop, "take": take, "hold": hold}),
            Plan::Breakeven { stop, take, hold } => json!({"kind": "breakeven", "stop": stop, "take": take, "hold": hold}),
            Plan::Trailing { stop, hold } => json!({"kind": "trailing", "stop": stop, "take": Value::Null, "hold": hold}),
        }
    }

    /// `sigma_hour` is the coin's hourly volatility, %, needed by volatility plans.
    fn simulate(self, entry: f64, sign: f64, start: i64, path: &[Bar], sigma_hour: Option<f64>) -> Option<Exit> {
        match self {
            Plan::Fixed { stop, take, .. } => barrier(entry, sign, start, path, stop, take, false),
            Plan::Volatility { stop, take, .. } => {
                let unit = sigma_hour.filter(|sigma| *sigma > 0.0)?;
                barrier(entry, sign, start, path, stop * unit, take * unit, false)
            }
            Plan::Breakeven { stop, take, .. } => barrier(entry, sign, start, path, stop, take, true),
            Plan::Trailing { stop, .. } => trailing(entry, sign, start, path, stop),
        }
    }
}

/// Exit plans simulated for every sample. Indexes 0–7 keep their meaning across versions.
/// 6 and 7 are quick exits: a 1% stop with a 0.75% or 1% take, held at most 5 minutes.
pub const PLANS: [Plan; 15] = [
    Plan::Fixed { stop: 1.0, take: 1.0, hold: 60 },
    Plan::Fixed { stop: 1.0, take: 2.0, hold: 60 },
    Plan::Fixed { stop: 1.5, take: 3.0, hold: 60 },
    Plan::Fixed { stop: 2.0, take: 2.0, hold: 60 },
    Plan::Fixed { stop: 2.0, take: 4.0, hold: 60 },
    Plan::Fixed { stop: 3.0, take: 6.0, hold: 60 },
    Plan::Fixed { stop: 1.0, take: 0.75, hold: 5 },
    Plan::Fixed { stop: 1.0, take: 1.0, hold: 5 },
    Plan::Fixed { stop: 2.0, take: 4.0, hold: 240 },
    Plan::Fixed { stop: 3.0, take: 6.0, hold: 240 },
    Plan::Volatility { stop: 1.5, take: 3.0, hold: 60 },
    Plan::Volatility { stop: 2.0, take: 4.0, hold: 240 },
    Plan::Breakeven { stop: 2.0, take: 4.0, hold: 240 },
    Plan::Trailing { stop: 2.0, hold: 240 },
    Plan::Trailing { stop: 3.0, hold: 240 },
];
/// The range before a move covers the 24 hours before its window starts.
const RANGE_LOOKBACK: i64 = 24 * HOUR;
const BASELINE_MINUTES: usize = 60;
/// A symbol is not sampled again within this many minutes, so outcomes rarely overlap.
const SCAN_COOLDOWN: usize = 30;
const KLINE_PAGE: usize = 1_500;
const OPEN_INTEREST_PAGE: usize = 500;
const FUNDING_PAGE: usize = 1_000;
/// K线和资金费率可以拉很多年；超出持仓量保留期（约 30 天）的样本，持仓量变化留空。
const MAX_SCAN_DAYS: i64 = 365;
const TRADE_PAGE: usize = 1_000;
const MAX_TRADE_PAGES: usize = 10;
/// Pause before every request so a scan stays well under Binance's per-IP limits
/// (about 1000 request weight per minute for 1500-row klines, half the allowance).
const REQUEST_GAP: Duration = Duration::from_millis(650);
/// Live samples are evaluated once the follow-up after the alert is complete.
const LIVE_DELAY_MS: i64 = (FOLLOW_MINUTES + 2) * MINUTE;
const LIVE_BATCH: i64 = 10;
const LIVE_ATTEMPTS: u32 = 3;
const SAMPLE_LIMIT: i64 = 10_000;
/// Open interest history only goes back about 30 days.
const OPEN_INTEREST_DAYS: i64 = 29;
/// Cached data this close to the requested end counts as current.
const FRESH_BARS: i64 = 15 * MINUTE;
const FRESH_FUNDING: i64 = HOUR;
/// Liquidations in this window before a signal are recorded as a feature.
const LIQUIDATION_WINDOW: i64 = 5 * MINUTE;
/// Older values are treated as missing rather than as the current state.
const MAX_BAR_AGE: i64 = 2 * MINUTE;
const MAX_OPEN_INTEREST_AGE: i64 = 10 * MINUTE;
/// Funding settles every 8 hours (more often on some contracts).
const MAX_FUNDING_AGE: i64 = 9 * HOUR;

fn parse_bars(rows: &[Vec<Value>], minutes: i64) -> Vec<Bar> {
    rows.iter()
        .filter_map(|row| {
            let time = row.first()?.as_i64()?;
            let bar = Bar {
                time,
                end: time + minutes * MINUTE,
                open: number(row.get(1)?)?,
                high: number(row.get(2)?)?,
                low: number(row.get(3)?)?,
                close: number(row.get(4)?)?,
                quote: number(row.get(7)?)?,
                taker_quote: number(row.get(10)?)?,
            };
            (bar.open > 0.0 && bar.close > 0.0 && bar.low > 0.0 && bar.high >= bar.low && bar.quote >= 0.0)
                .then_some(bar)
        })
        .collect()
}

fn round(value: f64) -> f64 {
    (value * 10_000.0).round() / 10_000.0
}

fn percent(from: Option<f64>, to: Option<f64>) -> Option<f64> {
    let (from, to) = (from?, to?);
    (from > 0.0).then(|| round((to / from - 1.0) * 100.0)).filter(|value| value.is_finite())
}

/// Close of the latest bar that had finished by `time` (never looks ahead), if recent enough.
fn close_before(bars: &[Bar], time: i64) -> Option<f64> {
    let index = bars.partition_point(|bar| bar.end <= time);
    bars.get(index.checked_sub(1)?)
        .filter(|bar| time - bar.end <= MAX_BAR_AGE)
        .map(|bar| bar.close)
}

/// Latest value recorded at or before `time`, unless it is older than `max_age`.
fn value_before(points: &[(i64, f64)], time: i64, max_age: i64) -> Option<f64> {
    let index = points.partition_point(|(at, _)| *at <= time);
    points.get(index.checked_sub(1)?)
        .filter(|(at, _)| time - at <= max_age)
        .map(|(_, value)| *value)
}

/// Result of one simulated trade.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Exit {
    kind: &'static str,
    pnl: f64,
    minutes: i64,
}

impl Exit {
    fn to_value(self) -> Value {
        json!({"exit": self.kind, "pnl": round(self.pnl), "minutes": self.minutes})
    }
}

fn held_minutes(start: i64, bar: &Bar) -> i64 {
    ((bar.end - start) as f64 / MINUTE as f64).ceil() as i64
}

/// Gain, %, and the worst and best gains inside one bar for a position on `sign`'s side.
fn bar_gains(entry: f64, sign: f64, bar: &Bar) -> (f64, f64, f64) {
    let gain = |price: f64| sign * (price / entry - 1.0) * 100.0;
    let (worst, best) = if sign > 0.0 { (gain(bar.low), gain(bar.high)) } else { (gain(bar.high), gain(bar.low)) };
    (gain(bar.open), worst, best)
}

/// Simulates stop-loss / take-profit / time exit on the bars after entry.
/// `sign` is +1 for long and -1 for short. A bar that touches both levels counts as a stop,
/// because the order inside a minute is unknown; a bar opening beyond a level fills at its open.
/// With `breakeven`, the stop moves to the entry price from the bar after the gain first reached
/// the stop distance.
fn barrier(entry: f64, sign: f64, start: i64, path: &[Bar], stop: f64, take: f64, breakeven: bool) -> Option<Exit> {
    let mut floor = -stop;
    for bar in path {
        let (open, worst, best) = bar_gains(entry, sign, bar);
        let minutes = held_minutes(start, bar);
        if open <= floor {
            return Some(Exit { kind: "stop", pnl: open, minutes });
        }
        if open >= take {
            return Some(Exit { kind: "take", pnl: open, minutes });
        }
        if worst <= floor {
            return Some(Exit { kind: "stop", pnl: floor, minutes });
        }
        if best >= take {
            return Some(Exit { kind: "take", pnl: take, minutes });
        }
        if breakeven && best >= stop {
            floor = floor.max(0.0);
        }
    }
    let last = path.last()?;
    Some(Exit { kind: "time", pnl: sign * (last.close / entry - 1.0) * 100.0, minutes: held_minutes(start, last) })
}

/// A stop trailing the best gain by `distance` %. Within a bar the stop is checked before the bar
/// can raise it, so a bar that first rises and then falls back never counts as a gain.
fn trailing(entry: f64, sign: f64, start: i64, path: &[Bar], distance: f64) -> Option<Exit> {
    let mut peak: f64 = 0.0;
    for bar in path {
        let (open, worst, best) = bar_gains(entry, sign, bar);
        let level = peak - distance;
        let minutes = held_minutes(start, bar);
        if open <= level {
            return Some(Exit { kind: "stop", pnl: open, minutes });
        }
        if worst <= level {
            return Some(Exit { kind: "stop", pnl: level, minutes });
        }
        peak = peak.max(best);
    }
    let last = path.last()?;
    Some(Exit { kind: "time", pnl: sign * (last.close / entry - 1.0) * 100.0, minutes: held_minutes(start, last) })
}

/// Price path statistics for one entry; `None` when the follow-up after entry is incomplete.
fn outcome(entry: f64, sign: f64, start: i64, bars: &[Bar], sigma_hour: Option<f64>) -> Option<Value> {
    let deadline = start + FOLLOW_MINUTES * MINUTE;
    let path: Vec<Bar> = bars.iter().copied().filter(|bar| bar.time >= start - MINUTE && bar.time < deadline && bar.end > start).collect();
    if !(entry > 0.0) || path.last()?.end < deadline {
        return None;
    }
    let gain = |price: f64| sign * (price / entry - 1.0) * 100.0;
    let mut returns = serde_json::Map::new();
    for minutes in HORIZONS {
        let bar = path.iter().find(|bar| bar.end >= start + minutes * MINUTE)?;
        returns.insert(minutes.to_string(), json!(round(gain(bar.close))));
    }
    let favorable = |bar: &Bar| if sign > 0.0 { bar.high } else { bar.low };
    let adverse = |bar: &Bar| if sign > 0.0 { bar.low } else { bar.high };
    let first_hour = || path.iter().filter(|bar| bar.time < start + EXCURSION_MINUTES * MINUTE);
    let mfe = first_hour().map(|bar| gain(favorable(bar))).fold(0.0, f64::max);
    let mae = first_hour().map(|bar| gain(adverse(bar))).fold(0.0, f64::min);
    let barriers: Vec<Value> = PLANS
        .iter()
        .map(|plan| {
            let held: Vec<Bar> = path.iter().copied().filter(|bar| bar.time < start + plan.hold() * MINUTE).collect();
            let mut value = plan.describe();
            value["chase"] = json!(plan.simulate(entry, sign, start, &held, sigma_hour).map(Exit::to_value));
            value["fade"] = json!(plan.simulate(entry, -sign, start, &held, sigma_hour).map(Exit::to_value));
            value
        })
        .collect();
    Some(json!({"entry": entry, "returns": returns, "mfe": round(mfe), "mae": round(mae), "barriers": barriers}))
}

struct Inputs<'a> {
    time: i64,
    /// The move over the window, %.
    change: f64,
    /// σ of one-minute returns, %, over the 24 hours before the window.
    sigma: Option<f64>,
    /// +1 for an upward move, -1 for a downward one.
    sign: f64,
    /// Liquidated value before the signal: (closing shorts, closing longs).
    liquidations: Option<(f64, f64)>,
    window_ms: i64,
    bars: &'a [Bar],
    btc: &'a [Bar],
    open_interest: &'a [(i64, f64)],
    funding: &'a [(i64, f64)],
    taker_buy_share: Option<f64>,
    quote_volume_24h: Option<f64>,
}

/// Market conditions at the moment of the signal, from data available at that moment.
fn features(input: Inputs) -> Value {
    let start = input.time - input.window_ms;
    let btc_window = input.window_ms.max(MINUTE);
    let hour = (input.time + BEIJING_OFFSET_MS).rem_euclid(DAY) / HOUR;
    let oi = |time| value_before(input.open_interest, time, MAX_OPEN_INTEREST_AGE);
    json!({
        "pre60": percent(close_before(input.bars, start - HOUR), close_before(input.bars, start)),
        "btcWindow": percent(close_before(input.btc, input.time - btc_window), close_before(input.btc, input.time)),
        "btcPre60": percent(close_before(input.btc, start - HOUR), close_before(input.btc, start)),
        "takerBuyShare": input.taker_buy_share.map(round),
        "oiChange15": percent(oi(input.time - 15 * MINUTE), oi(input.time)),
        "oiChange60": percent(oi(input.time - HOUR), oi(input.time)),
        "fundingRate": value_before(input.funding, input.time, MAX_FUNDING_AGE).map(|rate| round(rate * 100.0)),
        "quoteVolume24h": input.quote_volume_24h.map(f64::round),
        "range24h": range_before(input.bars, start.div_euclid(MINUTE) * MINUTE, RANGE_LOOKBACK),
        "sigma1m": input.sigma.map(round),
        // How unusual the move is for this coin: the change in units of its normal volatility.
        "zScore": input.sigma.filter(|sigma| *sigma > 0.0)
            .map(|sigma| round(input.change / (sigma * (input.window_ms as f64 / MINUTE as f64).sqrt()))),
        // Liquidations pushing the same way as the move: shorts closed on a rise, longs on a fall.
        "liqSame5": input.liquidations.map(|(shorts, longs)| (if input.sign > 0.0 { shorts } else { longs }).round()),
        "liqOpp5": input.liquidations.map(|(shorts, longs)| (if input.sign > 0.0 { longs } else { shorts }).round()),
        "hour": hour,
    })
}

/// High-to-low range, %, of the complete minute bars in the `span` before `end` (a minute boundary).
fn range_before(bars: &[Bar], end: i64, span: i64) -> Option<f64> {
    let start = end - span;
    let from = bars.partition_point(|bar| bar.time < start);
    let to = bars.partition_point(|bar| bar.time < end);
    let window = bars.get(from..to)?;
    if window.len() as i64 != span / MINUTE || window.first()?.time != start {
        return None;
    }
    let high = window.iter().map(|bar| bar.high).fold(f64::MIN, f64::max);
    let low = window.iter().map(|bar| bar.low).fold(f64::MAX, f64::min);
    percent(Some(low), Some(high))
}

/// σ, %, of one-minute close-to-close returns over the complete bars in the `span` before `end`.
fn volatility_before(bars: &[Bar], end: i64, span: i64) -> Option<f64> {
    let start = end - span;
    let from = bars.partition_point(|bar| bar.time < start);
    let to = bars.partition_point(|bar| bar.time < end);
    let window = bars.get(from..to)?;
    if window.len() as i64 != span / MINUTE || window.first()?.time != start {
        return None;
    }
    let returns: Vec<f64> = window.windows(2).map(|pair| (pair[1].close / pair[0].close - 1.0) * 100.0).collect();
    let count = returns.len() as f64;
    let mean = returns.iter().sum::<f64>() / count;
    let variance = returns.iter().map(|value| (value - mean).powi(2)).sum::<f64>() / (count - 1.0);
    Some(variance.sqrt()).filter(|sigma| sigma.is_finite() && *sigma > 0.0)
}

/// Hourly volatility, %, from the one-minute σ.
fn hourly(sigma: f64) -> f64 {
    sigma * 60f64.sqrt()
}

fn taker_share(bars: &[Bar]) -> Option<f64> {
    let total: f64 = bars.iter().map(|bar| bar.quote).sum();
    let buy: f64 = bars.iter().map(|bar| bar.taker_quote).sum();
    (total > 0.0).then(|| buy / total).filter(|share| (0.0..=1.0).contains(share))
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanParams {
    pub days: i64,
    pub top: usize,
    pub percent: f64,
    pub window_minutes: usize,
    /// Also require the move to be this many times the coin's normal volatility (0 = off).
    #[serde(default)]
    pub z_score: f64,
}

impl ScanParams {
    fn validate(self) -> Result<Self, String> {
        if !(1..=MAX_SCAN_DAYS).contains(&self.days) {
            return Err(format!("扫描天数需在 1–{MAX_SCAN_DAYS} 天之间。"));
        }
        if !(10..=300).contains(&self.top) {
            return Err("扫描合约数需在 10–300 个之间。".into());
        }
        if !self.percent.is_finite() || !(1.0..=50.0).contains(&self.percent) {
            return Err("涨跌幅阈值需在 1%–50% 之间。".into());
        }
        if !(1..=15).contains(&self.window_minutes) {
            return Err("时间窗口需在 1–15 分钟之间。".into());
        }
        if !self.z_score.is_finite() || !(self.z_score == 0.0 || (1.0..=30.0).contains(&self.z_score)) {
            return Err("波动率倍数需为 0（不使用）或 1–30 之间。".into());
        }
        Ok(self)
    }
}

#[derive(Debug, PartialEq)]
struct Detection {
    index: usize,
    change: f64,
    multiple: Option<f64>,
}

/// Finds historical spikes: the close moved at least `percent` from the close `window` minutes
/// earlier. The turnover multiple is recorded but not required, so the page can compare
/// high- and low-turnover moves. Bars must be contiguous around each signal.
fn detect(bars: &[Bar], params: &ScanParams, from: i64) -> Vec<Detection> {
    let window = params.window_minutes;
    let hold = FOLLOW_MINUTES as usize;
    let lookback = (RANGE_LOOKBACK / MINUTE) as usize;
    // Rolling sums of one-minute returns for the volatility trigger.
    let (mut sum, mut squares) = (vec![0.0], vec![0.0]);
    if params.z_score > 0.0 {
        for index in 0..bars.len() {
            let value = if index == 0 { 0.0 } else { (bars[index].close / bars[index - 1].close - 1.0) * 100.0 };
            sum.push(sum[index] + value);
            squares.push(squares[index] + value * value);
        }
    }
    let mut found = Vec::new();
    let mut next = 0;
    let first = BASELINE_MINUTES + window;
    let first = if params.z_score > 0.0 { first.max(lookback + window + 1) } else { first };
    for index in first..bars.len().saturating_sub(hold + 1) {
        let bar = bars[index];
        if index < next || bar.end < from {
            continue;
        }
        let base = bars[index - window].close;
        let change = (bar.close / base - 1.0) * 100.0;
        if !change.is_finite() || change.abs() < params.percent {
            continue;
        }
        if params.z_score > 0.0 {
            // Returns of the 24 hours before the window: bars (index-window-lookback, index-window].
            let (to, from_index) = (index - window, index - window - lookback + 1);
            let count = (to + 1 - from_index) as f64;
            let total = sum[to + 1] - sum[from_index];
            let variance = (squares[to + 1] - squares[from_index] - total * total / count) / (count - 1.0);
            let sigma = variance.max(0.0).sqrt();
            if !(sigma > 0.0) || change.abs() < params.z_score * sigma * (window as f64).sqrt() {
                continue;
            }
        }
        let span = (index + hold + 1) - (index - first);
        if bars[index + hold + 1].time - bars[index - first].time != span as i64 * MINUTE {
            continue;
        }
        let turnover: f64 = bars[index + 1 - window..=index].iter().map(|bar| bar.quote).sum();
        let minutes: Vec<_> = bars[index + 1 - first..=index - window].iter().map(|bar| Some(bar.quote)).collect();
        let multiple = turnover_baseline(&minutes, (window * 60) as u32)
            .map(|baseline| round(turnover / baseline))
            .filter(|multiple| multiple.is_finite());
        found.push(Detection { index, change: round(change), multiple });
        next = index + SCAN_COOLDOWN;
    }
    found
}

/// Sum of the quote volume in the 24 hours before `time`, when the bars cover them.
fn quote_volume_24h(bars: &[Bar], sums: &[f64], time: i64) -> Option<f64> {
    if bars.first()?.time > time - DAY {
        return None;
    }
    let from = bars.partition_point(|bar| bar.end <= time - DAY);
    let to = bars.partition_point(|bar| bar.end <= time);
    Some(sums[to] - sums[from])
}

#[derive(Default)]
struct ScanState {
    value: Value,
}

pub struct Signals {
    store: Arc<Store>,
    fetch: Fetcher,
    scan: Mutex<ScanState>,
    attempts: Mutex<HashMap<String, u32>>,
}

impl Signals {
    pub fn new(store: Arc<Store>, history: Arc<History>, stop: watch::Receiver<bool>) -> crate::store::Result<Self> {
        store.db()?.execute_batch(
            "CREATE TABLE IF NOT EXISTS signal_sample (
                id TEXT PRIMARY KEY, source TEXT NOT NULL, symbol TEXT NOT NULL, time INTEGER NOT NULL,
                status TEXT NOT NULL, data TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS signal_sample_source ON signal_sample (source, time);
            CREATE TABLE IF NOT EXISTS signal_scan (key INTEGER PRIMARY KEY CHECK (key = 1), state TEXT NOT NULL);",
        )?;
        let saved: Option<String> = store
            .db()?
            .query_row("SELECT state FROM signal_scan WHERE key = 1", [], |row| row.get(0))
            .ok();
        let mut value = saved
            .and_then(|state| serde_json::from_str::<Value>(&state).ok())
            .unwrap_or_else(|| json!({"status": "idle"}));
        if value["status"] == "running" {
            value["status"] = json!("interrupted");
            value["error"] = json!("服务重启，扫描中断，请重新扫描。");
        }
        let signals = Self {
            store,
            fetch: Fetcher::new(history, stop, REQUEST_GAP),
            scan: Mutex::new(ScanState { value }),
            attempts: Mutex::new(HashMap::new()),
        };
        Ok(signals)
    }

    /// Samples of one source plus the scan state, for the page.
    pub async fn snapshot(&self, source: &str) -> Result<Value, String> {
        let samples = self
            .samples(source)
            .map_err(|_| "无法读取信号样本。".to_owned())?;
        let scan = self.scan.lock().await.value.clone();
        Ok(json!({
            "source": source,
            "samples": samples,
            "scan": scan,
            "barriers": PLANS.iter().map(|plan| plan.describe()).collect::<Vec<_>>(),
            "horizons": HORIZONS,
            "archive": self.fetch.shared_history().status_in_background().await,
        }))
    }

    fn samples(&self, source: &str) -> crate::store::Result<Vec<Value>> {
        let db = self.store.db()?;
        let mut query = db.prepare_cached(
            "SELECT data FROM signal_sample WHERE source = ? AND status = 'done' ORDER BY time DESC LIMIT ?",
        )?;
        let rows = query.query_map(params![source, SAMPLE_LIMIT], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    fn save(&self, sample: &Value, status: &str) -> crate::store::Result<()> {
        self.store.db()?.execute(
            "INSERT INTO signal_sample VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
                status = excluded.status, data = excluded.data",
            params![
                sample["id"].as_str().ok_or("sample id missing")?,
                sample["source"].as_str().ok_or("sample source missing")?,
                sample["symbol"].as_str().unwrap_or_default(),
                sample["time"].as_i64().unwrap_or_default(),
                status,
                sample.to_string(),
            ],
        )?;
        Ok(())
    }

    async fn set_scan(&self, update: impl FnOnce(&mut Value)) {
        let mut scan = self.scan.lock().await;
        update(&mut scan.value);
        if let Ok(db) = self.store.db() {
            let _ = db.execute(
                "INSERT INTO signal_scan VALUES (1, ?) ON CONFLICT(key) DO UPDATE SET state = excluded.state",
                [scan.value.to_string()],
            );
        }
    }

    /// Starts a historical scan in the background, replacing the previous scan's samples.
    pub async fn start_scan(self: &Arc<Self>, params: ScanParams) -> Result<Value, String> {
        let params = params.validate()?;
        {
            let mut scan = self.scan.lock().await;
            if scan.value["status"] == "running" {
                return Err("已有扫描在进行，请等待完成。".into());
            }
            scan.value = json!({
                "status": "running", "startedAt": now_ms(), "done": 0, "total": 0, "samples": 0, "skipped": 0,
                "params": {"days": params.days, "top": params.top, "percent": params.percent, "windowMinutes": params.window_minutes},
            });
        }
        self.set_scan(|_| {}).await;
        let signals = Arc::clone(self);
        tokio::spawn(async move {
            let result = signals.scan(params).await;
            signals
                .set_scan(|state| {
                    state["finishedAt"] = json!(now_ms());
                    match result {
                        Ok(()) => state["status"] = json!("done"),
                        Err(error) => {
                            state["status"] = json!("failed");
                            state["error"] = json!(error);
                        }
                    }
                })
                .await;
        });
        Ok(self.scan.lock().await.value.clone())
    }

    async fn scan(&self, params: ScanParams) -> Result<(), String> {
        let now = now_ms();
        let from = now - params.days * DAY;
        // One extra day for the 24h volume, plus the turnover baseline before the first signal.
        let fetch_from = from - DAY - 2 * HOUR;
        let listed: HashSet<_> = self.fetch.listed().await?.into_iter().collect();
        let tickers: Vec<Value> = self.fetch.get(Endpoint::Ticker, json!({})).await?;
        let mut universe: Vec<(String, f64)> = tickers
            .iter()
            .filter_map(|ticker| {
                let symbol = ticker["symbol"].as_str()?;
                listed.contains(symbol).then(|| (symbol.to_owned(), number(&ticker["quoteVolume"]).unwrap_or(0.0)))
            })
            .collect();
        universe.sort_by(|left, right| right.1.total_cmp(&left.1));
        universe.truncate(params.top);
        self.store
            .db()
            .and_then(|db| Ok(db.execute("DELETE FROM signal_sample WHERE source = 'scan'", [])?))
            .map_err(|_| "无法清理上次的扫描结果。".to_owned())?;
        let total = universe.len();
        self.set_scan(|state| state["total"] = json!(total)).await;
        let btc = self.fetch.cached_bars("BTCUSDT", fetch_from, now).await?;
        let (mut samples, mut skipped) = (0, 0);
        for (done, (symbol, _)) in universe.iter().enumerate() {
            if self.fetch.stopped() {
                return Err("服务正在关闭，扫描已停止。".into());
            }
            match self.scan_symbol(symbol, &params, &btc, from, fetch_from, now).await {
                Ok(found) => {
                    for sample in &found {
                        self.save(sample, "done").map_err(|_| "无法保存扫描结果。".to_owned())?;
                    }
                    samples += found.len();
                }
                Err(_) => skipped += 1,
            }
            self.set_scan(|state| {
                state["done"] = json!(done + 1);
                state["samples"] = json!(samples);
                state["skipped"] = json!(skipped);
            })
            .await;
        }
        Ok(())
    }

    async fn scan_symbol(
        &self,
        symbol: &str,
        params: &ScanParams,
        btc: &[Bar],
        from: i64,
        fetch_from: i64,
        now: i64,
    ) -> Result<Vec<Value>, String> {
        let bars = self.fetch.cached_bars(symbol, fetch_from, now).await?;
        let detections = detect(&bars, params, from);
        let Some(first) = detections.first() else {
            return Ok(Vec::new());
        };
        let earliest = bars[first.index].end - 2 * HOUR;
        let open_interest = self.fetch.cached_points(symbol, Kind::OpenInterest, earliest, now).await.unwrap_or_default();
        let funding = self.fetch.cached_points(symbol, Kind::Funding, earliest - DAY, now).await.unwrap_or_default();
        let mut sums = vec![0.0];
        for bar in &bars {
            sums.push(sums.last().copied().unwrap_or(0.0) + bar.quote);
        }
        let window = params.window_minutes;
        let mut samples = Vec::new();
        for detection in detections {
            let signal = bars[detection.index];
            let entry = bars[detection.index + 1];
            let sign = detection.change.signum();
            let window_start = signal.end - window as i64 * MINUTE;
            let sigma = volatility_before(&bars, window_start, RANGE_LOOKBACK);
            let Some(result) = outcome(entry.open, sign, entry.time, &bars[detection.index + 1..], sigma.map(hourly)) else {
                continue;
            };
            let features = features(Inputs {
                time: signal.end,
                change: detection.change,
                sigma,
                sign,
                liquidations: self.liquidations_before(symbol, signal.end),
                window_ms: window as i64 * MINUTE,
                bars: &bars,
                btc,
                open_interest: &open_interest,
                funding: &funding,
                taker_buy_share: taker_share(&bars[detection.index + 1 - window..=detection.index]),
                quote_volume_24h: quote_volume_24h(&bars, &sums, signal.end),
            });
            samples.push(sample(
                format!("scan:{symbol}:{}", signal.end),
                "scan",
                symbol,
                signal.end,
                detection.change,
                window as i64 * 60,
                Value::Null,
                "scan",
                detection.multiple,
                features,
                result,
            ));
        }
        Ok(samples)
    }

    /// Archived liquidations in the five minutes before a signal, when the stream was running then.
    fn liquidations_before(&self, symbol: &str, time: i64) -> Option<(f64, f64)> {
        self.fetch.history().liquidations(symbol, time - LIQUIDATION_WINDOW, time).ok().flatten()
    }

    /// Evaluates live spikes whose hour of follow-up has finished.
    async fn evaluate_due(&self) {
        let due = match self.due_spikes() {
            Ok(due) => due,
            Err(_) => return,
        };
        for spike in due {
            if self.fetch.stopped() {
                return;
            }
            let id = format!("live:{}", crate::store::spike_id(&spike));
            match self.evaluate(&id, &spike).await {
                Ok(sample) => {
                    let _ = self.save(&sample, "done");
                }
                Err(error) => {
                    let mut attempts = self.attempts.lock().await;
                    let count = attempts.entry(id.clone()).or_default();
                    *count += 1;
                    if *count >= LIVE_ATTEMPTS {
                        attempts.remove(&id);
                        let failed = json!({"id": id, "source": "live", "symbol": spike["symbol"], "time": spike["time"], "error": error});
                        let _ = self.save(&failed, "failed");
                    }
                }
            }
        }
    }

    fn due_spikes(&self) -> crate::store::Result<Vec<Value>> {
        let db = self.store.db()?;
        let mut query = db.prepare_cached(
            "SELECT event FROM monitor_spike WHERE status IN ('alerted', 'below-threshold') AND time <= ?
                AND ('live:' || id) NOT IN (SELECT id FROM signal_sample WHERE source = 'live')
                ORDER BY time LIMIT ?",
        )?;
        let rows = query.query_map(params![now_ms() - LIVE_DELAY_MS, LIVE_BATCH], |row| row.get::<_, String>(0))?;
        rows.map(|row| Ok(serde_json::from_str(&row?)?)).collect()
    }

    async fn evaluate(&self, id: &str, spike: &Value) -> Result<Value, String> {
        let symbol = spike["symbol"].as_str().ok_or("缺少交易对。")?;
        let time = spike["time"].as_i64().ok_or("缺少告警时间。")?;
        let price = number(&spike["price"]).filter(|price| *price > 0.0).ok_or("缺少告警价格。")?;
        let change = number(&spike["change"]).filter(|change| *change != 0.0).ok_or("缺少涨跌幅。")?;
        let seconds = spike["seconds"].as_i64().unwrap_or(60).clamp(1, 900);
        let window_ms = seconds * 1_000;
        let minute = time.div_euclid(MINUTE) * MINUTE;
        let next_minute = minute + MINUTE;
        let range = (minute - RANGE_LOOKBACK - window_ms.div_euclid(MINUTE) * MINUTE - 2 * MINUTE, minute + (FOLLOW_MINUTES + 2) * MINUTE);
        let bars = self.fetch.minute_bars(symbol, range.0, range.1).await?;
        let btc = self.fetch.minute_bars("BTCUSDT", range.0, range.1).await?;
        // Trades give the exact path inside the alert's minute and the taker share in the window.
        let trades = self.fetch.trades(symbol, time - window_ms, next_minute).await.ok();
        let taker_buy_share = trades.as_ref().and_then(|trades| {
            let window: Vec<_> = trades.iter().filter(|trade| trade.0 < time).collect();
            let total: f64 = window.iter().map(|trade| trade.1 * trade.2).sum();
            let buy: f64 = window.iter().filter(|trade| !trade.3).map(|trade| trade.1 * trade.2).sum();
            (total > 0.0).then(|| buy / total)
        });
        let mut path = Vec::new();
        let after: Vec<_> = trades.iter().flatten().filter(|trade| trade.0 >= time).collect();
        if let (Some(first), Some(last)) = (after.first(), after.last()) {
            path.push(Bar {
                time,
                end: next_minute,
                open: first.1,
                high: after.iter().map(|trade| trade.1).fold(f64::MIN, f64::max),
                low: after.iter().map(|trade| trade.1).fold(f64::MAX, f64::min),
                close: last.1,
                quote: 0.0,
                taker_quote: 0.0,
            });
        }
        path.extend(bars.iter().copied().filter(|bar| bar.time >= next_minute));
        let sign = change.signum();
        let sigma = volatility_before(&bars, (time - window_ms).div_euclid(MINUTE) * MINUTE, RANGE_LOOKBACK);
        let result = outcome(price, sign, time, &path, sigma.map(hourly)).ok_or("告警后的K线还不完整。")?;
        let open_interest = self.fetch.open_interest_at(symbol, time).await.unwrap_or_default();
        let funding = self.fetch.funding(symbol, time - DAY, time).await.unwrap_or_default();
        let quote_volume_24h = self.fetch.quote_volume_24h(symbol, time).await.ok().flatten();
        let features = features(Inputs {
            time,
            change,
            sigma,
            sign,
            liquidations: self.liquidations_before(symbol, time),
            window_ms,
            bars: &bars,
            btc: &btc,
            open_interest: &open_interest,
            funding: &funding,
            taker_buy_share,
            quote_volume_24h,
        });
        let mut result = result;
        if trades.is_none() {
            // Without trades the alert's own minute is skipped, so the path starts slightly late.
            result["approximate"] = json!(true);
        }
        Ok(sample(
            id.to_owned(),
            "live",
            symbol,
            time,
            round(change),
            seconds,
            spike["level"].clone(),
            spike["status"].as_str().unwrap_or("alerted"),
            number(&spike["volume"]["multiple"]).map(round),
            features,
            result,
        ))
    }

}

/// Paced Binance requests with a local cache for historical data. Each user (scan, archive) owns one,
/// with its own client so long downloads never queue behind the page's market requests.
pub(crate) struct Fetcher {
    binance: Binance,
    history: Arc<History>,
    stop: watch::Receiver<bool>,
    gap: Duration,
}

impl Fetcher {
    pub(crate) fn new(history: Arc<History>, stop: watch::Receiver<bool>, gap: Duration) -> Self {
        Self { binance: Binance::new(), history, stop, gap }
    }

    pub(crate) fn stopped(&self) -> bool {
        *self.stop.borrow()
    }

    pub(crate) fn history(&self) -> &History {
        &self.history
    }

    pub(crate) fn shared_history(&self) -> Arc<History> {
        Arc::clone(&self.history)
    }

    pub(crate) async fn listed(&self) -> Result<Vec<String>, String> {
        let directory = self.binance.directory(60_000).await.map_err(|_| "无法读取币安合约列表。".to_owned())?;
        Ok(directory.contracts.into_iter().map(|contract| contract.id).collect())
    }

    /// One-minute bars in `[start, end)`, downloading only what the cache does not have yet.
    pub(crate) async fn cached_bars(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<Bar>, String> {
        self.cached_candles(symbol, Kind::Klines, start, end).await
    }

    /// `[start, end)` 的 1 分钟或 1 小时K线，只下载本地缓存还没有的部分。
    pub(crate) async fn cached_candles(&self, symbol: &str, kind: Kind, start: i64, end: i64) -> Result<Vec<Bar>, String> {
        let (interval, length, fresh) = match kind {
            Kind::Klines => ("1m", MINUTE, FRESH_BARS),
            Kind::HourKlines => ("1h", HOUR, HOUR),
            _ => return Err("只能缓存K线。".into()),
        };
        let end = end.min(now_ms().div_euclid(length) * length);
        let coverage = self.history.coverage(symbol, kind).map_err(cache_error)?;
        for (from, to) in history::missing(coverage, start, fresh_end(coverage, end, fresh)) {
            let bars = self.candles(symbol, interval, length, from, to).await?;
            self.history.save_candles(kind, symbol, &bars).map_err(cache_error)?;
            self.extend(symbol, kind, from, to)?;
        }
        self.history.candles(kind, symbol, start, end).map_err(cache_error)
    }

    /// Open interest or funding in `[start, end]`, downloading only what the cache does not have yet.
    /// Open interest older than Binance's 30-day window comes from the cache alone.
    pub(crate) async fn cached_points(&self, symbol: &str, kind: Kind, start: i64, end: i64) -> Result<Vec<(i64, f64)>, String> {
        let now = now_ms();
        let end = end.min(now);
        let fetch_start = match kind {
            Kind::OpenInterest => start.max(now - OPEN_INTEREST_DAYS * DAY),
            _ => start,
        };
        let coverage = self.history.coverage(symbol, kind).map_err(cache_error)?;
        let tolerance = if kind == Kind::Funding { FRESH_FUNDING } else { FRESH_BARS };
        for (from, to) in history::missing(coverage, fetch_start, fresh_end(coverage, end, tolerance)) {
            let points = match kind {
                Kind::OpenInterest => self.open_interest(symbol, from, to).await?,
                Kind::Funding => self.funding(symbol, from, to).await?,
                Kind::Klines | Kind::HourKlines => return Err("K线请使用 cached_candles。".into()),
            };
            self.history.save_points(symbol, kind, &points).map_err(cache_error)?;
            self.extend(symbol, kind, from, to)?;
        }
        self.history.points(symbol, kind, start, end).map_err(cache_error)
    }

    fn extend(&self, symbol: &str, kind: Kind, from: i64, to: i64) -> Result<(), String> {
        let (start, end) = self.history.coverage(symbol, kind).map_err(cache_error)?.unwrap_or((from, to));
        self.history.set_coverage(symbol, kind, start.min(from), end.max(to)).map_err(cache_error)
    }

    pub(crate) async fn get<T: serde::de::DeserializeOwned>(&self, endpoint: Endpoint, query: Value) -> Result<T, String> {
        for attempt in 0..3 {
            if self.stopped() {
                return Err("服务正在关闭。".into());
            }
            tokio::time::sleep(self.gap).await;
            match self.binance.get(endpoint, query.clone()).await {
                Ok(value) => return Ok(value),
                Err(UpstreamError::Missing) => return Err("币安没有这个合约的数据。".into()),
                Err(UpstreamError::RateLimit) => tokio::time::sleep(Duration::from_secs(60)).await,
                Err(UpstreamError::Unavailable) if attempt < 2 => tokio::time::sleep(Duration::from_secs(3)).await,
                Err(UpstreamError::Unavailable) => break,
            }
        }
        Err("币安数据暂时不可用。".into())
    }

    /// Finished one-minute bars in `[start, end)`.
    pub(crate) async fn minute_bars(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<Bar>, String> {
        self.candles(symbol, "1m", MINUTE, start, end).await
    }

    /// `[start, end)` 内已收盘、每根 `length` 毫秒的K线。
    async fn candles(&self, symbol: &str, interval: &str, length: i64, start: i64, end: i64) -> Result<Vec<Bar>, String> {
        let end = end.min(now_ms());
        let mut bars: Vec<Bar> = Vec::new();
        let mut cursor = start;
        while cursor < end {
            let rows: Vec<Vec<Value>> = self
                .get(Endpoint::Klines, json!({
                    "symbol": symbol, "interval": interval, "startTime": cursor, "endTime": end - 1, "limit": KLINE_PAGE,
                }))
                .await?;
            let page = parse_bars(&rows, length / MINUTE);
            let Some(last) = page.last() else {
                break;
            };
            cursor = last.time + length;
            bars.extend(page);
            if rows.len() < KLINE_PAGE {
                break;
            }
        }
        bars.retain(|bar| bar.end <= end);
        bars.dedup_by_key(|bar| bar.time);
        Ok(bars)
    }

    /// Open interest (contracts) every five minutes, oldest first.
    pub(crate) async fn open_interest(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<(i64, f64)>, String> {
        let start = start.max(now_ms() - OPEN_INTEREST_DAYS * DAY);
        let mut points = Vec::new();
        let mut cursor = end;
        while cursor > start {
            let rows: Vec<Value> = self
                .get(Endpoint::OpenInterestHistory, json!({
                    "symbol": symbol, "period": "5m", "endTime": cursor, "limit": OPEN_INTEREST_PAGE,
                }))
                .await?;
            let page = open_interest_points(&rows);
            let Some(first) = page.first().map(|point| point.0) else {
                break;
            };
            let full = rows.len() >= OPEN_INTEREST_PAGE;
            points.extend(page);
            if !full {
                break;
            }
            cursor = first - 1;
        }
        points.sort_by_key(|point| point.0);
        points.dedup_by_key(|point| point.0);
        Ok(points)
    }

    pub(crate) async fn open_interest_at(&self, symbol: &str, time: i64) -> Result<Vec<(i64, f64)>, String> {
        if time < now_ms() - OPEN_INTEREST_DAYS * DAY {
            return Ok(Vec::new());
        }
        let rows: Vec<Value> = self
            .get(Endpoint::OpenInterestHistory, json!({"symbol": symbol, "period": "5m", "endTime": time, "limit": 13}))
            .await?;
        Ok(open_interest_points(&rows))
    }

    /// `[start, end]` 的资金费结算记录，按时间从早到晚；每小时结算的合约需要分多页下载。
    pub(crate) async fn funding(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<(i64, f64)>, String> {
        let mut points = Vec::new();
        let mut cursor = start;
        while cursor <= end {
            let rows: Vec<Value> = self
                .get(Endpoint::FundingHistory, json!({
                    "symbol": symbol, "startTime": cursor, "endTime": end, "limit": FUNDING_PAGE,
                }))
                .await?;
            let mut page: Vec<_> = rows
                .iter()
                .filter_map(|row| Some((row["fundingTime"].as_i64()?, number(&row["fundingRate"])?)))
                .collect();
            page.sort_by_key(|point| point.0);
            let Some(last) = page.last().map(|point| point.0) else {
                break;
            };
            points.extend(page);
            if rows.len() < FUNDING_PAGE {
                break;
            }
            cursor = last + 1;
        }
        points.sort_by_key(|point| point.0);
        points.dedup_by_key(|point| point.0);
        Ok(points)
    }

    pub(crate) async fn quote_volume_24h(&self, symbol: &str, time: i64) -> Result<Option<f64>, String> {
        let rows: Vec<Vec<Value>> = self
            .get(Endpoint::Klines, json!({
                "symbol": symbol, "interval": "1h", "startTime": time - DAY - HOUR, "endTime": time, "limit": 26,
            }))
            .await?;
        let hours: Vec<_> = parse_bars(&rows, 60).into_iter().filter(|bar| bar.end <= time).collect();
        Ok((hours.len() >= 24).then(|| hours[hours.len() - 24..].iter().map(|bar| bar.quote).sum()))
    }

    /// Aggregate trades in `[start, end)` as (time, price, quantity, buyer is maker).
    pub(crate) async fn trades(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<(i64, f64, f64, bool)>, String> {
        let mut trades = Vec::new();
        let mut from_id: Option<i64> = None;
        for _ in 0..MAX_TRADE_PAGES {
            let query = match from_id {
                None => json!({"symbol": symbol, "startTime": start, "endTime": end - 1, "limit": TRADE_PAGE}),
                Some(id) => json!({"symbol": symbol, "fromId": id, "limit": TRADE_PAGE}),
            };
            let page: Vec<Value> = self.get(Endpoint::AggregateTrades, query).await?;
            for trade in &page {
                let (Some(time), Some(price), Some(quantity)) =
                    (trade["T"].as_i64(), number(&trade["p"]), number(&trade["q"]))
                else {
                    return Err("成交数据格式无效。".into());
                };
                if (start..end).contains(&time) {
                    trades.push((time, price, quantity, trade["m"].as_bool().unwrap_or(false)));
                }
            }
            let last = page.last();
            if page.len() < TRADE_PAGE || last.and_then(|trade| trade["T"].as_i64()).is_some_and(|time| time >= end) {
                return Ok(trades);
            }
            from_id = Some(last.and_then(|trade| trade["a"].as_i64()).ok_or("成交数据格式无效。")? + 1);
        }
        Err("告警附近成交过多，改用K线估算。".into())
    }
}

/// A cache that reaches to within `tolerance` of `end` is used as it is, so repeated scans skip
/// a round of requests just for the last few minutes.
fn fresh_end(coverage: Option<(i64, i64)>, end: i64, tolerance: i64) -> i64 {
    match coverage {
        Some((_, covered)) if covered < end && end - covered <= tolerance => covered,
        _ => end,
    }
}

fn cache_error(_: Box<dyn std::error::Error + Send + Sync>) -> String {
    "无法读写本地历史数据缓存。".to_owned()
}

fn open_interest_points(rows: &[Value]) -> Vec<(i64, f64)> {
    let mut points: Vec<_> = rows
        .iter()
        .filter_map(|row| Some((row["timestamp"].as_i64()?, number(&row["sumOpenInterest"])?)))
        .filter(|point| point.1 > 0.0)
        .collect();
    points.sort_by_key(|point| point.0);
    points
}

#[allow(clippy::too_many_arguments)]
fn sample(
    id: String,
    source: &str,
    symbol: &str,
    time: i64,
    change: f64,
    window_seconds: i64,
    level: Value,
    status: &str,
    multiple: Option<f64>,
    features: Value,
    outcome: Value,
) -> Value {
    let mut sample = json!({
        "id": id, "source": source, "symbol": symbol, "time": time,
        "direction": if change > 0.0 { "up" } else { "down" },
        "change": change, "windowSeconds": window_seconds, "level": level, "status": status,
        "turnoverMultiple": multiple, "features": features,
    });
    if let (Some(sample), Some(outcome)) = (sample.as_object_mut(), outcome.as_object()) {
        sample.extend(outcome.clone());
    }
    sample
}

/// Background loop: evaluates finished live alerts once a minute until shutdown.
pub async fn supervise(signals: Arc<Signals>, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        signals.evaluate_due().await;
        tokio::select! {
            _ = tokio::time::sleep(Duration::from_secs(60)) => {}
            _ = stop.changed() => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(time: i64, open: f64, high: f64, low: f64, close: f64) -> Bar {
        Bar { time, end: time + MINUTE, open, high, low, close, quote: 100.0, taker_quote: 60.0 }
    }

    fn flat(start: i64, count: usize, price: f64) -> Vec<Bar> {
        (0..count).map(|index| bar(start + index as i64 * MINUTE, price, price, price, price)).collect()
    }

    #[test]
    fn a_minute_touching_both_levels_counts_as_a_stop() {
        let path = vec![bar(0, 100.0, 103.0, 98.0, 101.0)];
        let exit = barrier(100.0, 1.0, 0, &path, 1.0, 2.0, false).unwrap();
        assert_eq!((exit.kind, exit.pnl, exit.minutes), ("stop", -1.0, 1));
        let short = barrier(100.0, -1.0, 0, &[bar(0, 100.0, 100.5, 97.0, 98.0)], 1.0, 2.0, false).unwrap();
        assert_eq!((short.kind, short.pnl), ("take", 2.0));
    }

    #[test]
    fn a_gap_past_the_stop_fills_at_the_open_and_unfinished_trades_exit_on_time() {
        let path = vec![bar(0, 100.0, 100.5, 99.5, 100.0), bar(MINUTE, 97.0, 97.5, 96.0, 97.0)];
        let exit = barrier(100.0, 1.0, 0, &path, 1.0, 2.0, false).unwrap();
        assert_eq!((exit.kind, exit.minutes), ("stop", 2));
        assert!((exit.pnl + 3.0).abs() < 1e-9);
        let timed = barrier(100.0, 1.0, 0, &flat(0, 60, 100.5), 1.0, 2.0, false).unwrap();
        assert_eq!((timed.kind, timed.minutes), ("time", 60));
        assert!((timed.pnl - 0.5).abs() < 1e-9);
    }

    #[test]
    fn outcomes_need_the_full_follow_up_and_measure_returns_in_the_signal_direction() {
        let mut path = flat(0, 240, 100.0);
        path[4].close = 102.0;
        path[10] = bar(10 * MINUTE, 100.0, 104.0, 99.0, 100.0);
        let long = outcome(100.0, 1.0, 0, &path, None).unwrap();
        assert_eq!(long["returns"]["5"], json!(2.0));
        assert_eq!(long["mfe"], json!(4.0));
        assert_eq!(long["mae"], json!(-1.0));
        // The five-minute exits only look at the first five bars.
        assert_eq!(long["barriers"][7]["chase"]["exit"], "time");
        assert_eq!(long["barriers"][7]["chase"]["minutes"], 5);
        let short = outcome(100.0, -1.0, 0, &path, None).unwrap();
        assert_eq!(short["returns"]["5"], json!(-2.0));
        assert_eq!(short["barriers"][0]["fade"], long["barriers"][0]["chase"]);
        assert_eq!(long["returns"]["240"], json!(0.0));
        // Volatility plans need the coin's volatility.
        assert_eq!(long["barriers"][10]["chase"], Value::Null);
        assert!(outcome(100.0, 1.0, 0, &path, Some(1.0)).unwrap()["barriers"][10]["chase"].is_object());
        assert!(outcome(100.0, 1.0, 0, &path[..239], None).is_none());
    }

    #[test]
    fn features_only_use_data_finished_before_the_signal() {
        let mut bars = flat(0, 200, 100.0);
        for bar in &mut bars[130..] {
            bar.close = 120.0;
        }
        let time = 130 * MINUTE;
        let value = features(Inputs {
            time, change: -3.0, sigma: Some(0.2), window_ms: 5 * MINUTE, bars: &bars, btc: &bars,
            open_interest: &[(0, 1.0), (time - HOUR, 10.0), (time - 30 * MINUTE, 10.5), (time, 11.0), (time + 1, 99.0)],
            funding: &[(0, 0.0001)], taker_buy_share: Some(0.6), quote_volume_24h: None,
            sign: -1.0, liquidations: Some((100.0, 300.0)),
        });
        assert_eq!((value["liqSame5"].clone(), value["liqOpp5"].clone()), (json!(300.0), json!(100.0)));
        assert_eq!(value["pre60"], json!(0.0));
        assert_eq!(value["oiChange60"], json!(10.0));
        // The nearest value before 15 minutes earlier is 15 minutes older still: missing, not stale.
        assert_eq!(value["oiChange15"], Value::Null);
        // A gap in the bars makes the earlier price missing too.
        let gapped: Vec<_> = bars.iter().copied().filter(|bar| !(50 * MINUTE..70 * MINUTE).contains(&bar.time)).collect();
        assert_eq!(close_before(&gapped, 65 * MINUTE), None);
        assert_eq!(value["fundingRate"], json!(0.01));
        // 200 minutes of bars cannot cover the 24 hours before the move.
        assert_eq!(value["range24h"], Value::Null);
        let day: Vec<_> = (0..1500).map(|index| bar(index * MINUTE, 100.0, 101.0, 99.0, 100.0)).collect();
        let range = range_before(&day, 1450 * MINUTE, RANGE_LOOKBACK).unwrap();
        assert!((range - 2.0202).abs() < 1e-3);
        // One missing minute makes the range unknown: only complete history counts.
        let gapped: Vec<_> = day.iter().copied().filter(|bar| bar.time != 700 * MINUTE).collect();
        assert_eq!(range_before(&gapped, 1450 * MINUTE, RANGE_LOOKBACK), None);
        assert_eq!(value["hour"], json!(10));
        // -3% in 5 minutes for a coin moving 0.2% a minute: 3 / (0.2 × √5) ≈ 6.7 σ.
        assert_eq!(value["zScore"], json!(-6.7082));
    }

    #[test]
    fn breakeven_moves_the_stop_to_entry_and_trailing_follows_the_best_price() {
        // Up 2.5% in the first minute, then back below the entry: the breakeven stop exits at zero.
        let path = vec![bar(0, 100.0, 102.5, 99.5, 102.0), bar(MINUTE, 101.0, 101.0, 98.5, 99.0)];
        let exit = barrier(100.0, 1.0, 0, &path, 2.0, 4.0, true).unwrap();
        assert_eq!((exit.kind, exit.pnl, exit.minutes), ("stop", 0.0, 2));
        assert_eq!(barrier(100.0, 1.0, 0, &path, 2.0, 4.0, false).unwrap().kind, "time");
        // Trailing 2%: the peak of +5% lets the trade keep +3% when the price falls back.
        let path = vec![bar(0, 100.0, 105.0, 99.5, 104.0), bar(MINUTE, 104.0, 104.5, 102.0, 102.5)];
        let exit = trailing(100.0, 1.0, 0, &path, 2.0).unwrap();
        assert_eq!((exit.kind, exit.minutes), ("stop", 2));
        assert!((exit.pnl - 3.0).abs() < 1e-9);
        // Within one bar the stop is checked before the bar can raise it.
        let exit = trailing(100.0, 1.0, 0, &[bar(0, 100.0, 105.0, 97.0, 104.0)], 2.0).unwrap();
        assert_eq!((exit.kind, exit.pnl), ("stop", -2.0));
    }

    #[test]
    fn volatility_uses_the_day_before_and_can_gate_detection() {
        let mut bars: Vec<Bar> = (0..2000)
            .map(|index| {
                let price = if index % 2 == 0 { 100.0 } else { 100.1 };
                bar(index as i64 * MINUTE, price, price, price, price)
            })
            .collect();
        let sigma = volatility_before(&bars, 1500 * MINUTE, RANGE_LOOKBACK).unwrap();
        assert!((sigma - 0.1).abs() < 0.001);
        for bar in &mut bars[1600..] {
            bar.close = 103.2;
        }
        let params = |z_score| ScanParams { days: 1, top: 10, percent: 3.0, window_minutes: 1, z_score };
        // A 3% jump is about 30 σ here: it passes a 10 σ gate but not a 40 σ one.
        assert_eq!(detect(&bars, &params(10.0), 0).first().map(|found| found.index), Some(1600));
        assert!(detect(&bars, &params(40.0), 0).is_empty());
    }

    #[test]
    fn detection_records_turnover_and_waits_before_sampling_a_symbol_again() {
        let mut bars = flat(0, 500, 100.0);
        for bar in &mut bars[100..] {
            bar.close = 103.0;
            bar.open = 103.0;
            bar.high = 103.0;
            bar.low = 103.0;
        }
        bars[100].quote = 500.0;
        for bar in &mut bars[140..] {
            bar.close = 106.5;
        }
        let params = ScanParams { days: 1, top: 10, percent: 3.0, window_minutes: 1, z_score: 0.0 };
        let found = detect(&bars, &params, 0);
        assert_eq!(found[0], Detection { index: 100, change: 3.0, multiple: Some(5.0) });
        assert_eq!(found[1].index, 140);
        // A missing minute inside the hour around a signal makes it unusable.
        let mut gap = bars.clone();
        gap.remove(120);
        assert!(detect(&gap, &params, 0).is_empty());
    }

    #[test]
    fn a_nearly_current_cache_is_used_without_downloading_the_last_minutes() {
        assert_eq!(fresh_end(Some((0, 100 * MINUTE)), 110 * MINUTE, FRESH_BARS), 100 * MINUTE);
        assert_eq!(fresh_end(Some((0, 100 * MINUTE)), 130 * MINUTE, FRESH_BARS), 130 * MINUTE);
        assert_eq!(fresh_end(None, 130 * MINUTE, FRESH_BARS), 130 * MINUTE);
    }

    #[tokio::test]
    async fn live_spikes_are_evaluated_once_and_scan_samples_are_listed_by_source() {
        let store = Arc::new(Store::open_memory().unwrap());
        let (_stop, stopped) = watch::channel(false);
        let signals = Signals::new(Arc::clone(&store), Arc::new(History::open_memory().unwrap()), stopped).unwrap();
        let old = now_ms() - 5 * HOUR;
        for (time, status) in [(old, "alerted"), (old + 1, "below-threshold"), (old + 2, "pending"), (now_ms(), "alerted")] {
            store.record_spike(&json!({"symbol": "BTCUSDT", "time": time, "threshold": 2.0, "status": status})).unwrap();
        }
        let due = signals.due_spikes().unwrap();
        assert_eq!(due.len(), 2);
        let id = format!("live:{}", crate::store::spike_id(&due[0]));
        signals.save(&json!({"id": id, "source": "live", "symbol": "BTCUSDT", "time": old}), "done").unwrap();
        assert_eq!(signals.due_spikes().unwrap().len(), 1);
        signals.save(&json!({"id": "scan:x", "source": "scan", "symbol": "X", "time": 1}), "done").unwrap();
        let live = signals.snapshot("live").await.unwrap();
        assert_eq!(live["samples"].as_array().unwrap().len(), 1);
        assert_eq!(live["scan"]["status"], "idle");
        assert!(ScanParams { days: 180, top: 10, percent: 3.0, window_minutes: 1, z_score: 0.0 }.validate().is_ok());
        assert!(ScanParams { days: 366, top: 10, percent: 3.0, window_minutes: 1, z_score: 0.0 }.validate().is_err());
        assert!(ScanParams { days: 7, top: 10, percent: 3.0, window_minutes: 1, z_score: 0.5 }.validate().is_err());
    }
}

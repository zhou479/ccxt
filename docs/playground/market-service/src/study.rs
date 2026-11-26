//! 中低频策略检验：资金费率极端值。
//!
//! 只读研究数据集（小时K线 + 资金费率 + 含已下架合约的合约全集），不下载。每次结算时按当时的流动性
//! 选出前 N 个合约；费率从常态进入极端时记一个信号，然后在下一根小时K线开盘进场，对做多和做空分别
//! 模拟每种出场方式。盈亏分成价格和资金费两部分，交易成本在页面上按流动性扣除。

use std::collections::HashMap;
use std::sync::Arc;

use serde::Deserialize;
use serde_json::{json, Value};
use tokio::sync::{watch, Mutex};

use crate::dataset::{daily_closes, regimes, trading_bars, Regime};
use crate::history::{Bar, Contract, History, Kind};
use crate::now_ms;

const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// 费率按每 8 小时口径比较：±0.1% 约为常态 0.01% 的 10 倍。
const EXTREME: f64 = 0.001;
/// 费率回到每 8 小时 ±0.01% 以内，视为拥挤结束、恢复正常。
const NORMAL: f64 = 0.0001;
/// 同一合约在这段时间内只取一个信号。
const SIGNAL_COOLDOWN: i64 = 72 * HOUR;
/// 流动性按结算前 7 天的成交额排名。
const RANK_HOURS: usize = 7 * 24;
const MIN_VOLUME_24H: f64 = 2e7;
/// 结算后的第一根K线必须在这段时间内开始，否则跳过这个信号。
const MAX_ENTRY_DELAY: i64 = 2 * HOUR;
/// 同方向、相隔不超过这个时间的信号算同一轮结算。
const ROUND_WINDOW: i64 = HOUR;
/// 检验区间之前多读的历史，用于计算涨跌、排名和第一次结算。
const LEAD: i64 = 8 * DAY;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Exit {
    /// 资金费率恢复正常就平仓。
    Normal { hold: i64, stop: f64 },
    Fixed { hold: i64, stop: Option<f64> },
}

/// 出场方式，第一次检验前定好；第 0 种为主判据。
pub const PLANS: [Exit; 6] = [
    Exit::Normal { hold: 72, stop: 8.0 },
    Exit::Fixed { hold: 8, stop: Some(8.0) },
    Exit::Fixed { hold: 24, stop: Some(8.0) },
    Exit::Fixed { hold: 72, stop: Some(8.0) },
    Exit::Normal { hold: 168, stop: 15.0 },
    Exit::Fixed { hold: 24, stop: None },
];

impl Exit {
    fn hold(self) -> i64 {
        match self {
            Exit::Normal { hold, .. } | Exit::Fixed { hold, .. } => hold,
        }
    }

    fn stop(self) -> Option<f64> {
        match self {
            Exit::Normal { stop, .. } => Some(stop),
            Exit::Fixed { stop, .. } => stop,
        }
    }

    fn describe(self) -> Value {
        match self {
            Exit::Normal { hold, stop } => json!({"kind": "normal", "hold": hold, "stop": stop}),
            Exit::Fixed { hold, stop } => json!({"kind": "fixed", "hold": hold, "stop": stop}),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
pub struct StudyParams {
    pub days: i64,
    pub top: usize,
}

impl StudyParams {
    fn validate(self) -> Result<Self, String> {
        if !(30..=1_095).contains(&self.days) {
            return Err("检验天数需在 30–1095 天之间。".into());
        }
        if !(10..=300).contains(&self.top) {
            return Err("流动性前 N 名需在 10–300 之间。".into());
        }
        Ok(self)
    }
}

/// 一次资金费结算及其结算间隔。
#[derive(Clone, Copy, Debug, PartialEq)]
struct Settlement {
    time: i64,
    rate: f64,
    /// 换算成每 8 小时口径，每 1 小时、4 小时结算的合约才能和其他合约比较。
    rate_8h: f64,
    hours: i64,
}

fn settlements(points: &[(i64, f64)]) -> Vec<Settlement> {
    let mut previous: Option<i64> = None;
    points
        .iter()
        .map(|&(time, rate)| {
            let hours = previous
                .map(|before| ((time - before) as f64 / HOUR as f64).round() as i64)
                .filter(|hours| (1..=8).contains(hours))
                .unwrap_or(8);
            previous = Some(time);
            Settlement { time, rate, rate_8h: rate * 8.0 / hours as f64, hours }
        })
        .collect()
}

fn extreme_side(rate_8h: f64) -> i8 {
    if rate_8h >= EXTREME {
        1
    } else if rate_8h <= -EXTREME {
        -1
    } else {
        0
    }
}

/// 费率从常态进入极端的结算（`from` 之后，冷却期内只取一次）。
fn crossings(settled: &[Settlement], from: i64) -> Vec<usize> {
    let mut found = Vec::new();
    let mut last: Option<i64> = None;
    for index in 1..settled.len() {
        let side = extreme_side(settled[index].rate_8h);
        let entered = side != 0 && side != extreme_side(settled[index - 1].rate_8h);
        let rested = last.map_or(true, |time| settled[index].time - time >= SIGNAL_COOLDOWN);
        if entered && rested && settled[index].time >= from {
            found.push(index);
            last = Some(settled[index].time);
        }
    }
    found
}

/// 按小时累计的成交额，任意时间之前的成交额只需做一次减法。
struct Volume {
    start: i64,
    sums: Vec<f64>,
}

impl Volume {
    fn new(bars: &[Bar], start: i64, hours: usize) -> Self {
        let mut hourly = vec![0.0; hours];
        for bar in bars {
            let index = (bar.time - start).div_euclid(HOUR);
            if (0..hours as i64).contains(&index) {
                hourly[index as usize] += bar.quote;
            }
        }
        let mut sums = Vec::with_capacity(hours + 1);
        sums.push(0.0);
        for value in hourly {
            sums.push(sums.last().copied().unwrap_or(0.0) + value);
        }
        Self { start, sums }
    }

    /// `time` 之前 `hours` 个完整小时的成交额。
    fn before(&self, time: i64, hours: usize) -> f64 {
        let end = ((time - self.start).div_euclid(HOUR)).clamp(0, self.sums.len() as i64 - 1) as usize;
        self.sums[end] - self.sums[end.saturating_sub(hours)]
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Outcome {
    pub exit: &'static str,
    pub hours: f64,
    /// 按持仓方向计算的价格收益，%。
    pub price: f64,
    /// 收到（正）或付出（负）的资金费，占开仓金额的 %。
    pub funding: f64,
}

/// 从 `bars[0].open` 开一笔仓位，`side` 为 +1 表示做多；`settled` 为信号之后的结算。
/// 合约仍在交易、但持仓期超出已有数据时返回 `None`。
fn simulate(bars: &[Bar], settled: &[Settlement], side: f64, signal: i64, plan: Exit, delisted: bool) -> Option<Outcome> {
    let entry_bar = bars.first()?;
    let (entry, entry_time) = (entry_bar.open, entry_bar.time);
    let direction = extreme_side(settled.iter().find(|s| s.time == signal)?.rate_8h) as f64;
    let deadline = entry_time + plan.hold() * HOUR;
    let stop = plan.stop().map(|stop| entry * (1.0 - side * stop / 100.0));
    let mut next = settled.partition_point(|s| s.time <= signal);
    let mut exit: Option<(f64, i64, &'static str)> = None;
    for bar in bars {
        if bar.time >= deadline {
            exit = Some((bar.open, bar.time, "time"));
            break;
        }
        // 费率在结算时才确定，和进场一样在下一根K线开盘时再行动。
        let mut normal = false;
        while next < settled.len() && settled[next].time < bar.time {
            let rate = settled[next].rate_8h;
            normal |= if direction > 0.0 { rate <= NORMAL } else { rate >= -NORMAL };
            next += 1;
        }
        if normal && matches!(plan, Exit::Normal { .. }) && bar.time > entry_time {
            exit = Some((bar.open, bar.time, "normal"));
            break;
        }
        if let Some(stop) = stop {
            let hit = if side > 0.0 { bar.low <= stop } else { bar.high >= stop };
            if hit {
                let gapped = if side > 0.0 { bar.open <= stop } else { bar.open >= stop };
                exit = Some((if gapped { bar.open } else { stop }, bar.end, "stop"));
                break;
            }
        }
    }
    let (price, time, reason) = match exit {
        Some(exit) => exit,
        // 数据用完：已下架的合约按最后成交价平仓，仍在交易的视为持仓期未结束。
        None if delisted => {
            let last = bars.last()?;
            (last.close, last.end, "delisted")
        }
        None => return None,
    };
    let funding: f64 = settled
        .iter()
        .filter_map(|s| {
            let at = s.time.div_euclid(1_000) * 1_000;
            let paid = -side * s.rate * 100.0;
            // 做多付正费率。正好在开仓或平仓那一刻的结算，只在对我们不利时计入。
            let inside = at > entry_time && at < time;
            let edge = (at == entry_time || at == time) && paid < 0.0;
            (inside || edge).then_some(paid)
        })
        .sum();
    Some(Outcome { exit: reason, hours: (time - entry_time) as f64 / HOUR as f64, price: side * (price / entry - 1.0) * 100.0, funding })
}

struct Loaded {
    contract: Contract,
    settled: Vec<Settlement>,
    volume: Volume,
}

struct Candidate {
    contract: usize,
    settlement: usize,
}

fn percent_change(bars: &[Bar], time: i64, hours: i64) -> Option<f64> {
    let close_at = |at: i64| {
        let index = bars.partition_point(|bar| bar.end <= at);
        (index > 0).then(|| bars[index - 1]).filter(|bar| at - bar.end < 2 * HOUR).map(|bar| bar.close)
    };
    let (now, before) = (close_at(time)?, close_at(time - hours * HOUR)?);
    Some(((now / before - 1.0) * 100.0 * 100.0).round() / 100.0)
}

fn outcome_json(outcome: Option<Outcome>) -> Value {
    outcome.map_or(Value::Null, |o| {
        let round = |value: f64| (value * 10_000.0).round() / 10_000.0;
        json!({"exit": o.exit, "hours": round(o.hours), "price": round(o.price), "funding": round(o.funding)})
    })
}

/// 在本地研究数据集上运行资金费率检验。
pub fn run(history: &History, params: StudyParams, now: i64, stopped: impl Fn() -> bool) -> Result<Value, String> {
    let read = |_| "无法读取研究数据集。".to_owned();
    let contracts = history.contracts().map_err(read)?;
    if contracts.is_empty() {
        return Err("还没有研究数据，请先下载数据集。".into());
    }
    let from = now - params.days * DAY;
    let grid_start = (from - LEAD).div_euclid(HOUR) * HOUR;
    let hours = ((now - grid_start) / HOUR + 1) as usize;
    let btc = history.candles(Kind::HourKlines, "BTCUSDT", from - 260 * DAY, now).map_err(read)?;
    let regime: HashMap<i64, Regime> = regimes(&daily_closes(&btc)).into_iter().collect();
    // 第一遍：计算每个合约的成交额和信号；K线用完就丢，控制内存。
    let mut loaded = Vec::new();
    let mut candidates = Vec::new();
    for contract in contracts {
        if stopped() {
            return Err("服务正在关闭，检验已停止。".into());
        }
        let bars = history.candles(Kind::HourKlines, &contract.symbol, grid_start, now).map_err(read)?;
        let bars = trading_bars(&bars, contract.delisted);
        let points = history.points(&contract.symbol, Kind::Funding, grid_start, now).map_err(read)?;
        let settled = settlements(&points);
        for settlement in crossings(&settled, from) {
            candidates.push(Candidate { contract: loaded.len(), settlement });
        }
        loaded.push(Loaded { volume: Volume::new(bars, grid_start, hours), settled, contract });
    }
    // 每个信号当时的流动性：在当时所有交易中的合约里排名。
    let mut accepted = Vec::new();
    for candidate in candidates {
        let one = &loaded[candidate.contract];
        let time = one.settled[candidate.settlement].time;
        let own = one.volume.before(time, RANK_HOURS);
        let volume_24h = one.volume.before(time, 24);
        if own <= 0.0 || volume_24h < MIN_VOLUME_24H {
            continue;
        }
        let rank = 1 + loaded.iter().filter(|other| other.volume.before(time, RANK_HOURS) > own).count();
        if rank <= params.top {
            accepted.push((candidate, rank, volume_24h));
        }
    }
    let sides: Vec<(i64, i8)> = accepted
        .iter()
        .map(|(c, ..)| {
            let s = loaded[c.contract].settled[c.settlement];
            (s.time, extreme_side(s.rate_8h))
        })
        .collect();
    // 第二遍：读取对应合约的K线，模拟每个信号。
    let mut by_contract: HashMap<usize, Vec<usize>> = HashMap::new();
    for (index, (candidate, ..)) in accepted.iter().enumerate() {
        by_contract.entry(candidate.contract).or_default().push(index);
    }
    let mut samples = Vec::new();
    let mut unfinished = 0;
    for (contract_index, indexes) in by_contract {
        if stopped() {
            return Err("服务正在关闭，检验已停止。".into());
        }
        let one = &loaded[contract_index];
        let all = history.candles(Kind::HourKlines, &one.contract.symbol, grid_start, now).map_err(read)?;
        let bars = trading_bars(&all, one.contract.delisted);
        // 按交易所列表的状态判断：仍在交易的合约数据不够就算持仓期未结束，不当作下架。
        let delisted = one.contract.delisted.is_some() || one.contract.status != "TRADING";
        for index in indexes {
            let (candidate, rank, volume_24h) = &accepted[index];
            let settlement = one.settled[candidate.settlement];
            let start = bars.partition_point(|bar| bar.time <= settlement.time);
            let Some(entry) = bars.get(start).filter(|bar| bar.time - settlement.time <= MAX_ENTRY_DELAY) else {
                continue;
            };
            let follow = &bars[start..];
            let later = &one.settled[candidate.settlement..];
            let plans: Vec<Value> = PLANS
                .iter()
                .map(|plan| {
                    json!({
                        "long": outcome_json(simulate(follow, later, 1.0, settlement.time, *plan, delisted)),
                        "short": outcome_json(simulate(follow, later, -1.0, settlement.time, *plan, delisted)),
                    })
                })
                .collect();
            if plans.iter().all(|plan| plan["long"].is_null()) {
                unfinished += 1;
                continue;
            }
            let side = extreme_side(settlement.rate_8h);
            let concurrent = sides.iter().filter(|(time, s)| *s == side && (time - settlement.time).abs() <= ROUND_WINDOW).count();
            let day = settlement.time.div_euclid(DAY) * DAY;
            samples.push(json!({
                "id": format!("funding:{}:{}", one.contract.symbol, settlement.time),
                "symbol": one.contract.symbol,
                "time": settlement.time,
                "entryTime": entry.time,
                "entry": entry.open,
                "direction": if side > 0 { "positive" } else { "negative" },
                "delisted": one.contract.delisted.is_some() || one.contract.status != "TRADING",
                "features": {
                    "rate": (settlement.rate * 1e6).round() / 1e4,
                    "rate8h": (settlement.rate_8h * 1e6).round() / 1e4,
                    "intervalHours": settlement.hours,
                    "ret24h": percent_change(bars, settlement.time, 24),
                    "ret72h": percent_change(bars, settlement.time, 72),
                    "btcRet24h": percent_change(&btc, settlement.time, 24),
                    "volume24h": volume_24h.round(),
                    "rank": rank,
                    "concurrent": concurrent,
                    "regime": regime.get(&day).map(|regime| regime.key()),
                },
                "plans": plans,
            }));
        }
    }
    samples.sort_by_key(|sample| sample["time"].as_i64().unwrap_or(0));
    Ok(json!({
        "params": {"days": params.days, "top": params.top},
        "from": from,
        "to": now,
        "plans": PLANS.iter().map(|plan| plan.describe()).collect::<Vec<_>>(),
        "unfinished": unfinished,
        "samples": samples,
    }))
}

pub struct Study {
    history: Arc<History>,
    stop: watch::Receiver<bool>,
    state: Mutex<Value>,
}

impl Study {
    pub fn new(history: Arc<History>, stop: watch::Receiver<bool>) -> Self {
        Self { history, stop, state: Mutex::new(json!({"status": "idle"})) }
    }

    pub async fn snapshot(&self) -> Value {
        self.state.lock().await.clone()
    }

    pub async fn start(self: &Arc<Self>, params: StudyParams) -> Result<Value, String> {
        let params = params.validate()?;
        {
            let mut state = self.state.lock().await;
            if state["status"] == "running" {
                return Err("检验正在进行，请等待完成。".into());
            }
            *state = json!({"status": "running", "startedAt": now_ms(), "params": {"days": params.days, "top": params.top}});
        }
        let study = Arc::clone(self);
        tokio::spawn(async move {
            let history = Arc::clone(&study.history);
            let stop = study.stop.clone();
            let result = tokio::task::spawn_blocking(move || run(&history, params, now_ms(), || *stop.borrow()))
                .await
                .unwrap_or_else(|_| Err("检验意外中止。".into()));
            let mut state = study.state.lock().await;
            state["finishedAt"] = json!(now_ms());
            match result {
                Ok(result) => {
                    state["status"] = json!("done");
                    state["result"] = result;
                }
                Err(error) => {
                    state["status"] = json!("failed");
                    state["error"] = json!(error);
                }
            }
        });
        Ok(self.state.lock().await.clone())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bar(time: i64, open: f64, high: f64, low: f64, close: f64) -> Bar {
        Bar { time, end: time + HOUR, open, high, low, close, quote: 1e8, taker_quote: 0.0 }
    }

    fn flat(from: i64, count: i64, price: f64) -> Vec<Bar> {
        (0..count).map(|index| bar(from + index * HOUR, price, price, price, price)).collect()
    }

    fn settle(points: &[(i64, f64)]) -> Vec<Settlement> {
        settlements(points)
    }

    #[test]
    fn rates_are_compared_per_eight_hours_and_signal_once_on_entering_an_extreme() {
        let points = [(0, 0.0001), (8 * HOUR, -0.0012), (16 * HOUR, -0.002), (17 * HOUR, 0.0001), (18 * HOUR, -0.0002)];
        let settled = settle(&points);
        assert_eq!(settled.iter().map(|s| s.hours).collect::<Vec<_>>(), vec![8, 8, 8, 1, 1]);
        // 每小时 −0.02% 相当于每 8 小时 −0.16%。
        assert!((settled[4].rate_8h + 0.0016).abs() < 1e-12);
        // 第 1 次进入极端；第 2 次仍是极端；第 4 次再次进入，但在冷却期内。
        assert_eq!(crossings(&settled, 0), vec![1]);
        let later = settle(&[(0, 0.0), (8 * HOUR, 0.0015), (16 * HOUR, 0.0), (100 * HOUR, 0.0011)]);
        assert_eq!(crossings(&later, 0), vec![1, 3]);
        assert_eq!(crossings(&later, 9 * HOUR), vec![3]);
    }

    #[test]
    fn a_long_after_negative_funding_collects_funding_until_the_rate_normalises() {
        let signal = 8 * HOUR;
        let settled = settle(&[(0, 0.0001), (signal, -0.002), (16 * HOUR, -0.0015), (24 * HOUR, 0.0001), (32 * HOUR, 0.0001)]);
        let mut bars = flat(9 * HOUR, 30, 100.0);
        for bar in &mut bars[10..] {
            *bar = bar_at(bar.time, 102.0);
        }
        let outcome = simulate(&bars, &settled[1..], 1.0, signal, PLANS[0], false).unwrap();
        // 第 24 小时费率恢复正常，在 25:00 开盘平仓；第 16 小时收到 0.15%，第 24 小时付出 0.01%。
        assert_eq!(outcome.exit, "normal");
        assert_eq!(outcome.hours, 16.0);
        assert!((outcome.price - 2.0).abs() < 1e-9);
        assert!((outcome.funding - 0.14).abs() < 1e-9);
        let short = simulate(&bars, &settled[1..], -1.0, signal, PLANS[0], false).unwrap();
        assert!((short.funding + 0.14).abs() < 1e-9);
    }

    fn bar_at(time: i64, price: f64) -> Bar {
        bar(time, price, price, price, price)
    }

    #[test]
    fn stops_gaps_holds_and_delisting() {
        let signal = 0;
        let settled = settle(&[(signal, 0.002)]);
        let mut bars = flat(HOUR, 10, 100.0);
        bars[2] = bar(3 * HOUR, 100.0, 109.0, 99.0, 100.0);
        // 止损 8% 的空单在K线内部以 108 止损。
        let short = simulate(&bars, &settled, -1.0, signal, PLANS[1], false).unwrap();
        assert_eq!((short.exit, short.hours), ("stop", 3.0));
        assert!((short.price + 8.0).abs() < 1e-9);
        // 开盘就越过止损价，按开盘价成交。
        bars[2] = bar(3 * HOUR, 120.0, 121.0, 119.0, 120.0);
        assert!((simulate(&bars, &settled, -1.0, signal, PLANS[1], false).unwrap().price + 20.0).abs() < 1e-9);
        // 第 5 种不设止损、持仓 24 小时，超出了仍在交易的合约的已有数据。
        assert_eq!(simulate(&bars, &settled, -1.0, signal, PLANS[5], false), None);
        let gone = simulate(&bars, &settled, -1.0, signal, PLANS[5], true).unwrap();
        assert_eq!((gone.exit, gone.hours), ("delisted", 10.0));
        let fixed = simulate(&flat(HOUR, 30, 100.0), &settled, 1.0, signal, PLANS[1], false).unwrap();
        assert_eq!((fixed.exit, fixed.hours, fixed.price), ("time", 8.0, 0.0));
    }

    #[test]
    fn funding_at_the_exact_entry_or_exit_counts_only_against_the_position() {
        let settled = settle(&[(0, 0.001), (HOUR, 0.001), (5 * HOUR, 0.001), (9 * HOUR, 0.001)]);
        let bars = flat(HOUR, 20, 100.0);
        // 做多，1:00 到 9:00 固定 8 小时：在 1:00、9:00（两端）和 5:00 付资金费。
        let long = simulate(&bars, &settled, 1.0, 0, PLANS[1], false).unwrap();
        assert!((long.funding + 0.3).abs() < 1e-9);
        // 做空只收到中间 5:00 那一次。
        let short = simulate(&bars, &settled, -1.0, 0, PLANS[1], false).unwrap();
        assert!((short.funding - 0.1).abs() < 1e-9);
    }

    #[test]
    fn volume_before_a_time_uses_full_hours_only() {
        let bars = flat(0, 48, 1.0);
        let volume = Volume::new(&bars, 0, 60);
        assert_eq!(volume.before(24 * HOUR + 5, 24), 24.0 * 1e8);
        assert_eq!(volume.before(10 * HOUR, 24), 10.0 * 1e8);
        assert_eq!(percent_change(&[bar_at(0, 100.0), bar_at(HOUR, 110.0)], 2 * HOUR, 1), Some(10.0));
    }

    #[test]
    fn the_study_ranks_liquidity_at_each_signal_and_keeps_delisted_contracts() {
        let history = History::open_memory().unwrap();
        let now = 40 * DAY;
        let start = 0;
        let mut contracts = Vec::new();
        for (symbol, volume, delisted) in [("BIGUSDT", 5e8, None), ("SMALLUSDT", 1e5, None), ("GONEUSDT", 3e8, Some(33 * DAY))] {
            let end = delisted.unwrap_or(now);
            let bars: Vec<Bar> = (0..(end - start) / HOUR)
                .map(|index| Bar { quote: volume, ..bar_at(start + index * HOUR, if symbol == "GONEUSDT" && index > 31 * 24 + 5 { 50.0 } else { 100.0 }) })
                .collect();
            history.save_candles(Kind::HourKlines, symbol, &bars).unwrap();
            let funding: Vec<(i64, f64)> = (0..(end - start) / (8 * HOUR))
                .map(|index| (index * 8 * HOUR, if index == 3 * 31 { -0.003 } else { 0.0001 }))
                .collect();
            history.save_points(symbol, Kind::Funding, &funding).unwrap();
            contracts.push(Contract { symbol: symbol.into(), onboard: Some(0), delisted, status: if delisted.is_some() { "SETTLING" } else { "TRADING" }.into() });
        }
        history.save_contracts(&contracts).unwrap();
        let result = run(&history, StudyParams { days: 30, top: 2 }, now, || false).unwrap();
        let samples = result["samples"].as_array().unwrap();
        // SMALLUSDT 的 24 小时成交额不够；另外两个在第 31 天出现信号。
        let symbols: Vec<_> = samples.iter().map(|s| s["symbol"].as_str().unwrap()).collect();
        assert_eq!(symbols.len(), 2);
        assert!(symbols.contains(&"BIGUSDT") && symbols.contains(&"GONEUSDT"));
        let gone = samples.iter().find(|s| s["symbol"] == "GONEUSDT").unwrap();
        assert_eq!(gone["delisted"], true);
        assert_eq!(gone["features"]["concurrent"], 2);
        assert_eq!(gone["features"]["rank"], 2);
        // 按第 5 种出场持有到期的多单，在暴跌中亏掉一半。
        assert!((gone["plans"][5]["long"]["price"].as_f64().unwrap() + 50.0).abs() < 1e-6);
        assert_eq!(result["plans"].as_array().unwrap().len(), PLANS.len());
    }
}

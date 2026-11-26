//! 交易保护：每日亏损上限、手动暂停开仓（一键全平之后）、单币冷却、对账和交易通知的内容。
//!
//! - 每日亏损：按北京时间当天平仓的交易计算已实现盈亏，手续费按普通用户 Taker 费率估算；
//!   成交记录不完整时用记录的开平仓价估算，再不行就按触发止损估算（偏保守）。
//! - 对账：把本地进行中的交易和币安账户里的实际持仓、普通挂单、条件单逐一比对。
//!   止损单缺失是严重问题，会暂停开新仓；其他不一致只报警，交给人工处理。

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::{Mode, Side, Trade};
use crate::binance::number;

/// 和页面「下单记录」相同的手续费估算：普通用户 Taker 费率 0.05%。
const TAKER_FEE_RATE: f64 = 0.0005;
const HOUR: i64 = 3_600_000;
const DAY: i64 = 24 * HOUR;
/// 北京时间相对 UTC 的偏移。
const BEIJING_OFFSET: i64 = 8 * HOUR;
/// 刚开仓的交易可能还在挂保护单，这段时间内不对账。
const SETTLING_MS: i64 = 30_000;
/// 持仓数量和记录相差超过这个比例才算不一致。
const AMOUNT_TOLERANCE: f64 = 0.01;

/// 手动暂停开仓的原因和时间，保存在本地文件里，服务重启后仍然有效。
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pause {
    pub at: i64,
    pub reason: String,
}

pub fn load_pause(path: &Path) -> Option<Pause> {
    std::fs::read(path).ok().and_then(|content| serde_json::from_slice(&content).ok())
}

pub fn save_pause(path: &Path, pause: Option<&Pause>) -> crate::store::Result<()> {
    match pause {
        Some(pause) => crate::store::write_private_json(path, pause),
        None => match std::fs::remove_file(path) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => Err(error.into()),
            _ => Ok(()),
        },
    }
}

/// 北京时间当天 0 点（UTC 毫秒）。
pub fn beijing_day_start(now: i64) -> i64 {
    (now + BEIJING_OFFSET).div_euclid(DAY) * DAY - BEIJING_OFFSET
}

/// 一笔已结束交易的已实现盈亏（USDT，扣除估算手续费）。
pub fn realized_pnl(trade: &Trade) -> f64 {
    let (mut entry_filled, mut entry_quote, mut exit_filled, mut exit_quote) = (0.0, 0.0, 0.0, 0.0);
    for order in &trade.orders {
        let Some(execution) = order.execution.as_ref().filter(|e| e.filled > 0.0 && e.quote > 0.0) else { continue };
        if order.kind == "entry" {
            entry_filled += execution.filled;
            entry_quote += execution.quote;
        } else {
            exit_filled += execution.filled;
            exit_quote += execution.quote;
        }
    }
    let sign = trade.side.sign();
    let fee = |quote: f64| quote * TAKER_FEE_RATE;
    if entry_filled > 0.0 && (entry_filled - exit_filled).abs() <= entry_filled.max(exit_filled) * 1e-8 {
        return (exit_quote - entry_quote) * sign - fee(entry_quote) - fee(exit_quote);
    }
    if let (Some(entry), Some(exit)) = (trade.entry_price, trade.exit_price) {
        let amount = trade.amount;
        return (exit - entry) * amount * sign - fee(entry * amount) - fee(exit * amount);
    }
    // 没有任何开仓成交：交易在开仓前就失败了，没有盈亏。
    if entry_filled == 0.0 && trade.entry_price.is_none() {
        return 0.0;
    }
    // 只知道开了仓、不知道怎么平的：按触发止损估算。
    -(trade.notional * trade.stop_loss_percent / 100.0) - 2.0 * fee(trade.notional)
}

/// `since` 之后平仓的交易合计亏了多少（USDT，赚钱时为 0）。
pub fn loss_since<'a>(trades: impl IntoIterator<Item = &'a Trade>, since: i64) -> f64 {
    let total: f64 = trades
        .into_iter()
        .filter(|trade| matches!(trade.status.as_str(), "closed" | "failed"))
        .filter(|trade| trade.closed_at.is_some_and(|closed| closed >= since))
        .map(realized_pnl)
        .sum();
    (-total).max(0.0)
}

/// 同一个币上一笔交易平仓后还要冷却多久（毫秒），不用冷却时为 `None`。
pub fn cooldown_remaining<'a>(trades: impl IntoIterator<Item = &'a Trade>, symbol: &str, now: i64, cooldown: i64) -> Option<i64> {
    trades
        .into_iter()
        .filter(|trade| trade.symbol == symbol && trade.status == "closed")
        .filter_map(|trade| trade.closed_at)
        .map(|closed| closed + cooldown - now)
        .filter(|rest| *rest > 0)
        .max()
}

/// 切换逐仓时，这些错误表示「已经是逐仓」。
pub fn already_isolated(error: &str) -> bool {
    error.contains("-4046") || error.contains("No need to change margin type")
}

fn side_label(side: Side) -> &'static str {
    match side {
        Side::Long => "做多",
        Side::Short => "做空",
    }
}

fn price(value: Option<f64>) -> String {
    value.map_or_else(|| "—".to_owned(), |value| format!("{value}"))
}

/// 钉钉交易通知的正文：账户、策略、方向、金额和价格。
pub fn trade_lines(trade: &Trade) -> Vec<String> {
    let mode = if trade.mode == Mode::Live { "实盘" } else { "模拟盘" };
    vec![
        format!("{mode} · {}", trade.strategy.name),
        format!("{} {} {:.2} USDT · {} 倍杠杆", trade.symbol, side_label(trade.side), trade.notional, trade.leverage),
        format!("开仓价 {} · 止损 {} · 止盈 {}", price(trade.entry_price), price(trade.stop_loss), price(trade.take_profit)),
    ]
}

/// 平仓通知多一行：原因、平仓价和估算盈亏。
pub fn close_lines(trade: &Trade) -> Vec<String> {
    let mut lines = trade_lines(trade);
    let pnl = if trade.exit_price.is_some() || trade.orders.iter().any(|order| order.kind != "entry" && order.execution.is_some()) {
        format!("{:+.2} USDT（含估算手续费）", realized_pnl(trade))
    } else {
        "待核实".to_owned()
    };
    lines.push(format!("原因：{} · 平仓价 {} · 盈亏 {pnl}", trade.exit_reason.as_deref().unwrap_or("—"), price(trade.exit_price)));
    lines
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    /// critical：会暂停开新仓；warning：只报警。
    pub level: &'static str,
    pub kind: &'static str,
    pub symbol: String,
    pub position_side: String,
    pub message: String,
}

impl Issue {
    pub fn key(&self) -> String {
        format!("{}:{}:{}", self.kind, self.symbol, self.position_side)
    }
}

fn text(value: &Value) -> &str {
    value.as_str().unwrap_or_default()
}

fn order_type(order: &Value) -> &str {
    order["orderType"].as_str().or_else(|| order["type"].as_str()).unwrap_or_default()
}

/// 比对本地进行中的交易和交易所的持仓、普通挂单、条件单（algo order），返回所有不一致。
pub fn reconcile(trades: &[Trade], positions: &[Value], orders: &[Value], algos: &[Value], now: i64) -> Vec<Issue> {
    let mut issues = Vec::new();
    let leg = |trade: &Trade| (trade.symbol.clone(), if trade.hedged { trade.side.position_side() } else { "BOTH" }.to_owned());
    let tracked: Vec<(String, String)> = trades.iter().map(leg).collect();
    let pending: Vec<&Value> = orders.iter().chain(algos).collect();
    for trade in trades.iter().filter(|trade| trade.status == "open" && now - trade.opened_at >= SETTLING_MS) {
        let (symbol, side) = leg(trade);
        let held: f64 = positions
            .iter()
            .filter(|row| text(&row["symbol"]) == symbol && text(&row["positionSide"]) == side)
            .filter_map(|row| number(&row["positionAmt"]))
            .sum::<f64>()
            .abs();
        // 仓位已经没了：后台检查会处理止损止盈触发，这里不重复报警。
        if held == 0.0 {
            continue;
        }
        let issue = |level, kind, message: String| Issue { level, kind, symbol: symbol.clone(), position_side: side.clone(), message };
        if (held - trade.amount).abs() > trade.amount * AMOUNT_TOLERANCE {
            issues.push(issue("warning", "amount", format!("{symbol} 交易所持仓 {held}，本地记录 {}。", trade.amount)));
        }
        let own: Vec<&&Value> = pending.iter().filter(|order| text(&order["symbol"]) == symbol && text(&order["positionSide"]) == side).collect();
        let has_take = own.iter().any(|order| order_type(order).contains("TAKE_PROFIT"));
        let has_stop = own.iter().any(|order| { let kind = order_type(order); kind.contains("STOP") && !kind.contains("TAKE_PROFIT") });
        if !has_stop {
            issues.push(issue("critical", "missing-stop", format!("{symbol} 有持仓但交易所里找不到止损单，已暂停开新仓，请立即核对。")));
        }
        if !has_take {
            issues.push(issue("warning", "missing-take", format!("{symbol} 有持仓但交易所里找不到止盈单。")));
        }
    }
    for row in positions {
        let (symbol, side) = (text(&row["symbol"]).to_owned(), text(&row["positionSide"]).to_owned());
        if number(&row["positionAmt"]).unwrap_or(0.0).abs() > 0.0 && !tracked.contains(&(symbol.clone(), side.clone())) {
            issues.push(Issue {
                level: "warning", kind: "untracked-position", message: format!("{symbol} 有不是策略开的持仓（{side}），可能是手动下的单。"),
                symbol, position_side: side,
            });
        }
    }
    let mut seen = Vec::new();
    for order in &pending {
        let (symbol, side) = (text(&order["symbol"]).to_owned(), text(&order["positionSide"]).to_owned());
        if !tracked.contains(&(symbol.clone(), side.clone())) && !seen.contains(&(symbol.clone(), side.clone())) {
            seen.push((symbol.clone(), side.clone()));
            issues.push(Issue {
                level: "warning", kind: "untracked-order", message: format!("{symbol} 有不属于策略交易的挂单（{side}）。"),
                symbol, position_side: side,
            });
        }
    }
    issues
}

/// 对账结果，供页面显示。
pub fn report(time: i64, issues: &[Issue], error: Option<&str>) -> Value {
    json!({
        "time": time,
        "ok": error.is_none() && issues.is_empty(),
        "error": error,
        "issues": issues,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(overrides: Value) -> Trade {
        let mut base = json!({
            "id": "t", "strategy": {"id": "test", "name": "测试"}, "mode": "demo", "symbol": "BTCUSDT",
            "unifiedSymbol": "BTC/USDT:USDT", "side": "long", "hedged": true, "amount": 0.01, "notional": 1000.0,
            "leverage": 1, "entryPrice": null, "stopLoss": null, "takeProfit": null, "stopLossPercent": 2.0,
            "takeProfitPercent": 4.0, "deadline": 0, "status": "closed", "openedAt": 0, "closedAt": 10, "exitPrice": null,
            "exitReason": null, "error": null, "note": "", "orders": [],
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    fn order(kind: &str, filled: f64, quote: f64) -> Value {
        json!({"kind": kind, "side": "buy", "amount": filled, "triggerPrice": null, "exchangeId": "1", "average": null,
            "execution": {"filled": filled, "quote": quote}, "status": "filled", "error": null, "time": 0})
    }

    #[test]
    fn beijing_days_start_at_16_00_utc() {
        let now = 1_795_600_000_000; // 2026-11-25 07:46:40 UTC = 15:46:40 北京时间
        let start = beijing_day_start(now);
        assert_eq!((start + BEIJING_OFFSET) % DAY, 0);
        assert!(now - start < DAY && now >= start);
        assert_eq!(beijing_day_start(start), start);
        assert_eq!(beijing_day_start(start - 1), start - DAY);
    }

    #[test]
    fn realized_pnl_prefers_executions_then_prices_then_the_stop() {
        // 做多 0.01 个，1000 买入、990 卖出：亏 10 和两边手续费 0.5 + 0.495。
        let filled = trade(json!({"orders": [order("entry", 0.01, 1000.0), order("exit", 0.01, 990.0)]}));
        assert!((realized_pnl(&filled) + 10.995).abs() < 1e-9);
        let short = trade(json!({"side": "short", "orders": [order("entry", 0.01, 1000.0), order("stop-loss", 0.01, 990.0)]}));
        assert!((realized_pnl(&short) - 9.005).abs() < 1e-9);
        let priced = trade(json!({"entryPrice": 100000.0, "exitPrice": 101000.0}));
        assert!((realized_pnl(&priced) - (10.0 - 0.5 - 0.505)).abs() < 1e-9);
        assert_eq!(realized_pnl(&trade(json!({"status": "failed"}))), 0.0);
        // 只有开仓成交：按止损 2% 估算，亏 20 和两边手续费。
        let unknown = trade(json!({"orders": [order("entry", 0.01, 1000.0)]}));
        assert!((realized_pnl(&unknown) + 21.0).abs() < 1e-9);
    }

    #[test]
    fn daily_loss_counts_only_trades_closed_since_the_day_start() {
        let losing = trade(json!({"closedAt": 100, "orders": [order("entry", 0.01, 1000.0), order("exit", 0.01, 990.0)]}));
        let winning = trade(json!({"closedAt": 100, "entryPrice": 100000.0, "exitPrice": 100500.0}));
        let yesterday = trade(json!({"closedAt": 10, "orders": [order("entry", 0.01, 1000.0), order("exit", 0.01, 900.0)]}));
        let open = trade(json!({"status": "open", "closedAt": null}));
        let loss = loss_since([&losing, &winning, &yesterday, &open], 50);
        assert!((loss - (10.995 - (5.0 - 0.5 - 0.5025))).abs() < 1e-9);
        assert_eq!(loss_since([&winning], 50), 0.0);
    }

    #[test]
    fn reconciliation_flags_missing_protection_and_untracked_positions() {
        let open = trade(json!({"status": "open", "openedAt": 0}));
        let fresh = trade(json!({"id": "fresh", "symbol": "ETHUSDT", "status": "open", "openedAt": 90_000}));
        let positions = vec![
            json!({"symbol": "BTCUSDT", "positionSide": "LONG", "positionAmt": "0.01"}),
            json!({"symbol": "ETHUSDT", "positionSide": "LONG", "positionAmt": "0.5"}),
            json!({"symbol": "SOLUSDT", "positionSide": "SHORT", "positionAmt": "-3"}),
            json!({"symbol": "XRPUSDT", "positionSide": "LONG", "positionAmt": "0"}),
        ];
        let algos = vec![json!({"symbol": "BTCUSDT", "positionSide": "LONG", "orderType": "TAKE_PROFIT_MARKET"})];
        let orders = vec![json!({"symbol": "DOGEUSDT", "positionSide": "LONG", "type": "LIMIT"})];
        let issues = reconcile(&[open.clone(), fresh], &positions, &orders, &algos, 100_000);
        let kinds: Vec<_> = issues.iter().map(|issue| (issue.kind, issue.symbol.as_str())).collect();
        // 刚开仓的 ETHUSDT 还在挂保护单，不报警。
        assert_eq!(kinds, vec![("missing-stop", "BTCUSDT"), ("untracked-position", "SOLUSDT"), ("untracked-order", "DOGEUSDT")]);
        assert_eq!(issues[0].level, "critical");
        // 止损在、数量对：没有问题。
        let protected = vec![algos[0].clone(), json!({"symbol": "BTCUSDT", "positionSide": "LONG", "orderType": "STOP_MARKET"})];
        assert!(reconcile(&[open.clone()], &positions[..1], &[], &protected, 100_000).is_empty());
        // 数量差太多。
        let bigger = vec![json!({"symbol": "BTCUSDT", "positionSide": "LONG", "positionAmt": "0.02"})];
        let issues = reconcile(&[open], &bigger, &[], &protected, 100_000);
        assert_eq!(issues.iter().map(|issue| issue.kind).collect::<Vec<_>>(), vec!["amount"]);
        assert_eq!(report(1, &issues, None)["ok"], false);
    }

    #[test]
    fn cooldown_counts_from_the_latest_close_of_the_same_symbol() {
        let minute = 60_000;
        let old = trade(json!({"closedAt": 0}));
        let recent = trade(json!({"id": "r", "closedAt": 20 * minute}));
        let other = trade(json!({"id": "o", "symbol": "ETHUSDT", "closedAt": 29 * minute}));
        let failed = trade(json!({"id": "f", "status": "failed", "closedAt": 29 * minute}));
        let trades = [&old, &recent, &other, &failed];
        assert_eq!(cooldown_remaining(trades, "BTCUSDT", 30 * minute, 30 * minute), Some(20 * minute));
        assert_eq!(cooldown_remaining(trades, "BTCUSDT", 50 * minute, 30 * minute), None);
        assert_eq!(cooldown_remaining(trades, "SOLUSDT", 30 * minute, 30 * minute), None);
        assert!(already_isolated("No need to change margin type.（-4046）"));
        assert!(!already_isolated("Margin type cannot be changed if there exists position.（-4048）"));
    }

    #[test]
    fn trade_messages_show_the_account_side_and_result() {
        let open = trade(json!({"status": "open", "closedAt": null, "entryPrice": 100.0, "stopLoss": 98.0, "takeProfit": 104.0}));
        let lines = trade_lines(&open);
        assert_eq!(lines[0], "模拟盘 · 测试");
        assert_eq!(lines[1], "BTCUSDT 做多 1000.00 USDT · 1 倍杠杆");
        assert_eq!(lines[2], "开仓价 100 · 止损 98 · 止盈 104");
        let closed = trade(json!({"mode": "live", "entryPrice": 100000.0, "exitPrice": 102000.0, "exitReason": "止盈触发"}));
        let lines = close_lines(&closed);
        assert!(lines[0].starts_with("实盘"));
        assert_eq!(lines[3], "原因：止盈触发 · 平仓价 102000 · 盈亏 +18.99 USDT（含估算手续费）");
        let pending = trade(json!({"exitReason": "仓位已在交易所平掉"}));
        assert!(close_lines(&pending)[3].ends_with("盈亏 待核实"));
    }

    #[test]
    fn a_pause_survives_on_disk_until_cleared() {
        let path = std::env::temp_dir().join(format!("guard-{}.json", uuid::Uuid::new_v4()));
        assert_eq!(load_pause(&path), None);
        let pause = Pause { at: 5, reason: "一键全平".into() };
        save_pause(&path, Some(&pause)).unwrap();
        assert_eq!(load_pause(&path), Some(pause));
        save_pause(&path, None).unwrap();
        save_pause(&path, None).unwrap();
        assert_eq!(load_pause(&path), None);
    }
}

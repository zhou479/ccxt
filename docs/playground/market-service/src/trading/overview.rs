//! 工作台「总览」页的数据：账户资金、当前持仓（含浮动盈亏）和已实现盈亏曲线。
//!
//! 只做数据整理，不访问交易所；交易所返回的原始数据由 `Trader::overview` 读取后传进来。

use serde_json::{json, Value};

use super::guard::realized_pnl;
use super::Trade;
use crate::binance::number;

/// 盈亏曲线最多保留这么多个点（最近的交易）。
const MAX_CURVE_POINTS: usize = 1_000;

fn round(value: f64, digits: i32) -> f64 {
    let scale = 10f64.powi(digits);
    (value * scale).round() / scale
}

/// 账户资金，来自币安 `/fapi/v3/account`：权益 = 钱包余额 + 全部未实现盈亏（全仓和逐仓都算）。
pub fn account_summary(account: &Value, now: i64) -> Value {
    let field = |name: &str| number(&account[name]).map(|value| round(value, 4));
    match (field("totalMarginBalance"), field("totalWalletBalance")) {
        (Some(equity), Some(wallet)) => json!({
            "equity": equity,
            "wallet": wallet,
            "available": field("availableBalance"),
            "unrealized": field("totalUnrealizedProfit"),
            "time": now,
        }),
        _ => json!({"error": "无法解析账户资金。"}),
    }
}

/// 交易是否真的开了仓（有开仓成交或开仓价）。开仓前就失败的交易不进盈亏统计。
fn has_entry(trade: &Trade) -> bool {
    trade.entry_price.is_some()
        || trade.orders.iter().any(|order| order.kind == "entry" && order.execution.as_ref().is_some_and(|e| e.filled > 0.0))
}

/// 交易所里的全部持仓，和本地进行中的策略交易对应起来；对不上的标记为「非策略持仓」。
pub fn positions(rows: &[Value], active: &[Trade]) -> Vec<Value> {
    rows.iter()
        .filter_map(|row| {
            let amount = number(&row["positionAmt"])?;
            if amount == 0.0 {
                return None;
            }
            let symbol = row["symbol"].as_str()?;
            let position_side = row["positionSide"].as_str().unwrap_or("BOTH");
            let trade = active.iter().find(|trade| {
                trade.symbol == symbol && (if trade.hedged { trade.side.position_side() } else { "BOTH" }) == position_side
            });
            let side = if position_side == "SHORT" || (position_side == "BOTH" && amount < 0.0) { "short" } else { "long" };
            let isolated = number(&row["isolatedMargin"]).is_some_and(|margin| margin > 0.0)
                || row["marginType"].as_str().is_some_and(|kind| kind.eq_ignore_ascii_case("isolated"));
            Some(json!({
                "symbol": symbol,
                "side": side,
                "amount": amount.abs(),
                "entryPrice": number(&row["entryPrice"]),
                "markPrice": number(&row["markPrice"]),
                "notional": number(&row["notional"]).map(|value| round(value.abs(), 4)),
                "unrealized": number(&row["unRealizedProfit"]).map(|value| round(value, 4)),
                "liquidationPrice": number(&row["liquidationPrice"]).filter(|price| *price > 0.0),
                "isolated": isolated,
                "tradeId": trade.map(|trade| trade.id.clone()),
                "strategy": trade.map(|trade| trade.strategy.name.clone()),
                "stopLoss": trade.and_then(|trade| trade.stop_loss),
                "takeProfit": trade.and_then(|trade| trade.take_profit),
                "openedAt": trade.map(|trade| trade.opened_at),
                "deadline": trade.map(|trade| trade.deadline),
            }))
        })
        .collect()
}

/// 已结束交易的已实现盈亏：今天、累计、胜率，以及按平仓时间累加的曲线。
pub fn pnl_summary(trades: &[Trade], day_start: i64) -> Value {
    let mut finished: Vec<(&Trade, i64, f64)> = trades
        .iter()
        .filter(|trade| matches!(trade.status.as_str(), "closed" | "failed") && has_entry(trade))
        .filter_map(|trade| trade.closed_at.map(|closed| (trade, closed, realized_pnl(trade))))
        .collect();
    finished.sort_by_key(|(_, closed, _)| *closed);
    let total: f64 = finished.iter().map(|(_, _, pnl)| pnl).sum();
    let today: f64 = finished.iter().filter(|(_, closed, _)| *closed >= day_start).map(|(_, _, pnl)| pnl).sum();
    let wins = finished.iter().filter(|(_, _, pnl)| *pnl > 0.0).count();
    let mut cumulative = 0.0;
    let mut curve: Vec<Value> = finished
        .iter()
        .map(|(trade, closed, pnl)| {
            cumulative += pnl;
            json!({"time": closed, "pnl": round(*pnl, 4), "cumulative": round(cumulative, 4), "symbol": trade.symbol})
        })
        .collect();
    if curve.len() > MAX_CURVE_POINTS {
        curve.drain(..curve.len() - MAX_CURVE_POINTS);
    }
    json!({
        "today": round(today, 4),
        "total": round(total, 4),
        "trades": finished.len(),
        "wins": wins,
        "curve": curve,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn trade(overrides: Value) -> Trade {
        let mut base = json!({
            "id": "t", "strategy": {"id": "test", "name": "测试策略"}, "mode": "demo", "symbol": "BTCUSDT",
            "unifiedSymbol": "BTC/USDT:USDT", "side": "long", "hedged": true, "amount": 0.01, "notional": 1000.0,
            "leverage": 1, "entryPrice": 100000.0, "stopLoss": 98000.0, "takeProfit": 104000.0, "stopLossPercent": 2.0,
            "takeProfitPercent": 4.0, "deadline": 9, "status": "closed", "openedAt": 1, "closedAt": 10, "exitPrice": 101000.0,
            "exitReason": null, "error": null, "note": "", "orders": [],
        });
        for (key, value) in overrides.as_object().unwrap() {
            base[key] = value.clone();
        }
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn account_equity_includes_unrealized_profit() {
        let account = json!({"totalMarginBalance": "5012.4", "totalWalletBalance": "5014.25", "availableBalance": "4960.1",
            "totalUnrealizedProfit": "-1.85"});
        let summary = account_summary(&account, 7);
        assert_eq!(summary["equity"], 5012.4);
        assert_eq!(summary["unrealized"], -1.85);
        assert_eq!(summary["time"], 7);
        assert!(account_summary(&json!({}), 7)["error"].is_string());
    }

    #[test]
    fn positions_are_matched_with_strategy_trades() {
        let open = trade(json!({"status": "open", "closedAt": null}));
        let rows = vec![
            json!({"symbol": "BTCUSDT", "positionSide": "LONG", "positionAmt": "0.01", "entryPrice": "100000", "markPrice": "99800",
                "notional": "998", "unRealizedProfit": "-2", "liquidationPrice": "0", "isolatedMargin": "500"}),
            json!({"symbol": "ETHUSDT", "positionSide": "SHORT", "positionAmt": "-0.5", "entryPrice": "3000", "markPrice": "2990",
                "notional": "-1495", "unRealizedProfit": "5", "liquidationPrice": "4100", "isolatedMargin": "0"}),
            json!({"symbol": "XRPUSDT", "positionSide": "LONG", "positionAmt": "0"}),
        ];
        let list = positions(&rows, &[open]);
        assert_eq!(list.len(), 2);
        assert_eq!(list[0]["tradeId"], "t");
        assert_eq!(list[0]["strategy"], "测试策略");
        assert_eq!(list[0]["stopLoss"], 98000.0);
        assert_eq!(list[0]["isolated"], true);
        assert_eq!(list[0]["liquidationPrice"], Value::Null);
        // 手动下的空单：没有对应的策略交易。
        assert_eq!(list[1]["side"], "short");
        assert_eq!(list[1]["amount"], 0.5);
        assert_eq!(list[1]["notional"], 1495.0);
        assert_eq!(list[1]["tradeId"], Value::Null);
        assert_eq!(list[1]["isolated"], false);
    }

    #[test]
    fn the_pnl_curve_accumulates_finished_trades_in_closing_order() {
        let win = trade(json!({"id": "w", "closedAt": 30}));
        let loss = trade(json!({"id": "l", "closedAt": 20, "exitPrice": 99000.0}));
        let never_opened = trade(json!({"id": "n", "status": "failed", "entryPrice": null, "exitPrice": null, "closedAt": 25}));
        let open = trade(json!({"id": "o", "status": "open", "closedAt": null}));
        let summary = pnl_summary(&[win, loss, never_opened, open], 25);
        assert_eq!(summary["trades"], 2);
        assert_eq!(summary["wins"], 1);
        let curve = summary["curve"].as_array().unwrap();
        // 先平仓的亏损排在前面：-10 - 0.5 - 0.495 = -10.995，再加 +10 - 0.5 - 0.505 = 8.995。
        assert_eq!(curve[0]["cumulative"], -10.995);
        assert_eq!(curve[1]["cumulative"], -2.0);
        assert_eq!(summary["total"], -2.0);
        // 只有 30 那一笔在今天开始（25）之后平仓。
        assert_eq!(summary["today"], 8.995);
    }
}

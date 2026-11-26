/** Mirrors `market-service/src/trading.rs`. */
export type TradingMode = "off" | "demo" | "live";
export type TradeSide = "long" | "short";
export type TradeStatus = "opening" | "open" | "closing" | "closed" | "failed";
export const STANDARD_TAKER_FEE_RATE = 0.0005;

export type TradeExecution = { filled: number; quote: number };

export type TradeOrder = {
  kind: "entry" | "stop-loss" | "take-profit" | "exit";
  side: "buy" | "sell";
  amount: number;
  triggerPrice: number | null;
  exchangeId: string | null;
  average: number | null;
  execution?: TradeExecution | null;
  status: "placed" | "filled" | "canceled" | "triggered" | "failed";
  error: string | null;
  time: number;
};

export type Trade = {
  id: string;
  strategy: { id: string; name: string };
  mode: TradingMode;
  symbol: string;
  unifiedSymbol: string;
  side: TradeSide;
  amount: number;
  notional: number;
  leverage: number;
  entryPrice: number | null;
  stopLoss: number | null;
  takeProfit: number | null;
  stopLossPercent: number;
  takeProfitPercent: number;
  deadline: number;
  status: TradeStatus;
  openedAt: number;
  closedAt: number | null;
  exitPrice: number | null;
  exitReason: string | null;
  error: string | null;
  note: string;
  orders: TradeOrder[];
};

export type TradingBalance = {
  asset: "USDT";
  available: number | null;
  total: number | null;
  unrealizedPnl: number | null;
  time: number;
} | { error: string };

/** 对账发现的一处不一致。critical 会暂停开新仓，warning 只提醒。 */
export type ReconciliationIssue = {
  level: "critical" | "warning";
  kind: "missing-stop" | "missing-take" | "amount" | "untracked-position" | "untracked-order";
  symbol: string;
  positionSide: string;
  message: string;
};

export type TradingGuard = {
  /** 一键全平之后的手动暂停。 */
  pause: { at: number; reason: string } | null;
  /** 北京时间今天已实现的亏损（USDT，赚钱时为 0）。 */
  dailyLoss: number;
  /** 现在不能开新仓的原因，可以开仓时为 null。 */
  blocked: string | null;
  reconciliation: { time: number; ok: boolean; error: string | null; issues: ReconciliationIssue[] } | null;
};

export type TradingStatus = {
  mode: TradingMode;
  accountRevision: string;
  enabled: boolean;
  problem: string | null;
  limits: {
    maxNotional: number; maxOpenTrades: number; maxLeverage: number; dailyLossLimit: number;
    /** 开仓前切换为逐仓。 */
    isolatedMargin: boolean;
    /** 同一个币平仓后多少分钟内不再开仓，0 表示不冷却。 */
    symbolCooldownMinutes: number;
  };
  guard: TradingGuard;
  balance: TradingBalance | null;
  trades: Trade[];
};

export type TestOrderRequest = {
  symbol: string;
  accountRevision: string;
  direction: TradeSide;
  notional: number;
  leverage: number;
  stopLossPercent: number;
  takeProfitPercent: number;
  holdMinutes: number;
};

export type TradingLoginMode = Exclude<TradingMode, "off">;

export type TradingAccountRequest = {
  action: "login";
  mode: TradingLoginMode;
  apiKey: string;
  secret: string;
  confirmLive: boolean;
} | { action: "logout"; accountRevision: string };

export const tradingModeLabels: Record<TradingMode, string> = { off: "未开启", demo: "模拟盘", live: "实盘" };

export function isTradeActive(trade: Pick<Trade, "status">) {
  return trade.status === "opening" || trade.status === "open" || trade.status === "closing";
}

export function tradeExecution(trade: Pick<Trade, "side" | "orders">) {
  const entry = { filled: 0, quote: 0 };
  const exit = { filled: 0, quote: 0 };
  for (const order of trade.orders) {
    const execution = order.execution;
    if (!execution || !Number.isFinite(execution.filled) || !Number.isFinite(execution.quote) ||
        execution.filled <= 0 || execution.quote <= 0) continue;
    const leg = order.kind === "entry" ? entry : exit;
    leg.filled += execution.filled;
    leg.quote += execution.quote;
  }
  const entryFee = entry.filled > 0 ? entry.quote * STANDARD_TAKER_FEE_RATE : null;
  const exitFee = exit.filled > 0 ? exit.quote * STANDARD_TAKER_FEE_RATE : null;
  const sign = trade.side === "long" ? 1 : -1;
  const complete = Math.abs(entry.filled - exit.filled) <= Math.max(entry.filled, exit.filled) * 1e-8;
  return {
    entryPrice: entry.filled > 0 ? entry.quote / entry.filled : null,
    exitPrice: exit.filled > 0 ? exit.quote / exit.filled : null,
    entryFee,
    exitFee,
    netPnl: complete && entryFee !== null && exitFee !== null
      ? (exit.quote - entry.quote) * sign - entryFee - exitFee : null,
  };
}

/** 工作台总览：账户资金（币安 /fapi/v3/account）。权益 = 钱包余额 + 全部未实现盈亏。 */
export type OverviewFunds = {
  equity: number;
  wallet: number;
  available: number | null;
  unrealized: number | null;
  time: number;
} | { error: string };

/** 交易所里的一个持仓；tradeId 为空表示不是策略开的（手动下的单）。 */
export type OverviewPosition = {
  symbol: string;
  side: TradeSide;
  amount: number;
  entryPrice: number | null;
  markPrice: number | null;
  notional: number | null;
  unrealized: number | null;
  liquidationPrice: number | null;
  isolated: boolean;
  tradeId: string | null;
  strategy: string | null;
  stopLoss: number | null;
  takeProfit: number | null;
  openedAt: number | null;
  deadline: number | null;
};

/** 一笔已结束交易在盈亏曲线上的点：平仓时间、这笔盈亏、累计盈亏（USDT，含估算手续费）。 */
export type PnlPoint = { time: number; pnl: number; cumulative: number; symbol: string };

export type TradingOverview = {
  mode: TradingMode;
  enabled: boolean;
  account: OverviewFunds | null;
  positions: OverviewPosition[];
  pnl: { today: number; total: number; trades: number; wins: number; curve: PnlPoint[] };
};

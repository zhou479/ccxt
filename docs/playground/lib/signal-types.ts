/** Signal statistics: samples come from live alerts or a historical scan (market-service/src/signals.rs). */

export type SignalSource = "live" | "scan";

export type SignalExit = { exit: "stop" | "take" | "time"; pnl: number; minutes: number };

export type PlanKind = "fixed" | "volatility" | "breakeven" | "trailing";

/** An exit plan. Volatility plans measure stop and take in σ of hourly moves; trailing plans have no take. */
export type SignalPlan = { kind?: PlanKind; stop: number; take: number | null; hold?: number };

export type SignalBarrier = SignalPlan & { chase: SignalExit | null; fade: SignalExit | null };

export type SignalFeatures = {
  /** Price change in the hour before the move, %. */
  pre60: number | null;
  /** BTC change over the same window, %. */
  btcWindow: number | null;
  btcPre60: number | null;
  /** Share of taker buys in the window's turnover, 0–1. */
  takerBuyShare: number | null;
  oiChange15: number | null;
  oiChange60: number | null;
  /** Latest settled funding rate, %. */
  fundingRate: number | null;
  quoteVolume24h: number | null;
  /** Beijing hour, 0–23. */
  hour: number;
  /** High-to-low range of the 24 hours before the move, %, from complete one-minute bars. */
  range24h?: number | null;
  /** σ of one-minute returns over the 24 hours before, %. */
  sigma1m?: number | null;
  /** The move in units of the coin's normal volatility over the window. */
  zScore?: number | null;
  /** Liquidated USDT in the 5 minutes before, pushing with the move (shorts on a rise, longs on a fall). */
  liqSame5?: number | null;
  /** Liquidated USDT in the 5 minutes before, against the move. */
  liqOpp5?: number | null;
};

export type SignalSample = {
  id: string;
  source: SignalSource;
  symbol: string;
  time: number;
  direction: "up" | "down";
  change: number;
  windowSeconds: number;
  level: number | null;
  status: "alerted" | "below-threshold" | "scan";
  turnoverMultiple: number | null;
  features: SignalFeatures;
  entry: number;
  /** Return in the move's direction after N minutes, %, before costs. */
  returns: Record<string, number>;
  mfe: number;
  mae: number;
  barriers: SignalBarrier[];
  approximate?: boolean;
};

export type ScanParams = { days: number; top: number; percent: number; windowMinutes: number; zScore?: number };

export type SignalScan = {
  status: "idle" | "running" | "done" | "failed" | "interrupted";
  startedAt?: number;
  finishedAt?: number;
  done?: number;
  total?: number;
  samples?: number;
  skipped?: number;
  error?: string;
  params?: ScanParams;
};

export type ArchiveStatus = {
  premiumSnapshots: number;
  premiumAt: number | null;
  liquidations: number;
  liquidationAt: number | null;
  longShortSymbols: number;
  longShortAt: number | null;
  cachedBars: number;
  streamAt: number | null;
};

export type SignalSnapshot = {
  source: SignalSource;
  samples: SignalSample[];
  scan: SignalScan;
  barriers: SignalPlan[];
  horizons: number[];
  archive?: ArchiveStatus | null;
};

/** Signal statistics: samples come from live alerts or a historical scan (market-service/src/signals.rs). */

export type SignalSource = "live" | "scan";

export type SignalExit = { exit: "stop" | "take" | "time"; pnl: number; minutes: number };

export type SignalBarrier = { stop: number; take: number; chase: SignalExit | null; fade: SignalExit | null };

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

export type ScanParams = { days: number; top: number; percent: number; windowMinutes: number };

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

export type SignalSnapshot = {
  source: SignalSource;
  samples: SignalSample[];
  scan: SignalScan;
  barriers: { stop: number; take: number }[];
  horizons: number[];
};

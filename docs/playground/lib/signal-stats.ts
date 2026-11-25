import type { SignalExit, SignalSample } from "./signal-types";

/** Groups with fewer samples than this are flagged: the numbers are mostly noise. */
export const MIN_SAMPLES = 30;
/** Round-trip cost per trade, %: taker fees on both sides plus slippage. */
export const COST_OPTIONS = [0.1, 0.15, 0.2, 0.3] as const;
export const DEFAULT_COST = 0.2;

export type SampleFilter = { direction: "all" | "up" | "down"; minMultiple: number; alertedOnly: boolean };

export function filterSamples(samples: readonly SignalSample[], filter: SampleFilter): SignalSample[] {
  return samples.filter((sample) =>
    (filter.direction === "all" || sample.direction === filter.direction) &&
    (filter.minMultiple <= 0 || (sample.turnoverMultiple ?? -Infinity) >= filter.minMultiple) &&
    (!filter.alertedOnly || sample.status !== "below-threshold"));
}

function mean(values: readonly number[]): number | null {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values: readonly number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

export type TradeStats = {
  count: number;
  winRate: number | null;
  /** Average net result per trade, %. */
  average: number | null;
  total: number;
  /** Average win divided by average loss; null without both. */
  payoff: number | null;
  takes: number;
  stops: number;
  times: number;
};

export function tradeStats(exits: readonly (SignalExit | null | undefined)[], cost: number): TradeStats {
  const valid = exits.filter((exit): exit is SignalExit => Boolean(exit));
  const net = valid.map((exit) => exit.pnl - cost);
  const wins = net.filter((value) => value > 0);
  const losses = net.filter((value) => value <= 0);
  const averageWin = mean(wins);
  const averageLoss = mean(losses.map((value) => -value));
  return {
    count: valid.length,
    winRate: valid.length ? wins.length / valid.length : null,
    average: mean(net),
    total: net.reduce((sum, value) => sum + value, 0),
    payoff: averageWin !== null && averageLoss ? averageWin / averageLoss : null,
    takes: valid.filter((exit) => exit.exit === "take").length,
    stops: valid.filter((exit) => exit.exit === "stop").length,
    times: valid.filter((exit) => exit.exit === "time").length,
  };
}

export type BarrierRow = { stop: number; take: number; chase: TradeStats; fade: TradeStats };

/** Simulated results per stop-loss / take-profit pair, chasing the move and fading it. */
export function barrierStats(samples: readonly SignalSample[], barriers: readonly { stop: number; take: number }[],
  cost: number): BarrierRow[] {
  return barriers.map(({ stop, take }, index) => ({
    stop, take,
    chase: tradeStats(samples.map((sample) => sample.barriers[index]?.chase), cost),
    fade: tradeStats(samples.map((sample) => sample.barriers[index]?.fade), cost),
  }));
}

export type HorizonRow = { minutes: number; count: number; average: number | null; median: number | null; continued: number | null };

/** Gross return in the move's direction N minutes after entry. */
export function horizonStats(samples: readonly SignalSample[], horizons: readonly number[]): HorizonRow[] {
  return horizons.map((minutes) => {
    const values = samples.map((sample) => sample.returns[String(minutes)]).filter(Number.isFinite);
    return {
      minutes, count: values.length, average: mean(values), median: median(values),
      continued: values.length ? values.filter((value) => value > 0).length / values.length : null,
    };
  });
}

export function excursionStats(samples: readonly SignalSample[]) {
  return { mfe: median(samples.map((sample) => sample.mfe)), mae: median(samples.map((sample) => sample.mae)) };
}

/** A feature expressed in the move's direction: positive means "the same way as the move". */
function aligned(sample: SignalSample, value: number | null) {
  return value === null ? null : sample.direction === "up" ? value : -value;
}

type Bucket = (sample: SignalSample) => string | null;

function ranges(value: number | null, edges: readonly [number, string][], below: string) {
  if (value === null || !Number.isFinite(value)) return null;
  let label = below;
  for (const [edge, name] of edges) if (value >= edge) label = name;
  return label;
}

export type SignalGroup = { id: string; label: string; order: readonly string[]; bucket: Bucket };

export const SIGNAL_GROUPS: readonly SignalGroup[] = [
  { id: "direction", label: "异动方向", order: ["上涨异动（追多）", "下跌异动（追空）"],
    bucket: (sample) => sample.direction === "up" ? "上涨异动（追多）" : "下跌异动（追空）" },
  { id: "change", label: "窗口涨跌幅", order: ["<2%", "2–3%", "3–5%", "5–10%", "≥10%"],
    bucket: (sample) => ranges(Math.abs(sample.change), [[2, "2–3%"], [3, "3–5%"], [5, "5–10%"], [10, "≥10%"]], "<2%") },
  { id: "turnover", label: "成交额倍数", order: ["<2 倍", "2–3 倍", "3–5 倍", "5–10 倍", "≥10 倍", "未知"],
    bucket: (sample) => ranges(sample.turnoverMultiple, [[2, "2–3 倍"], [3, "3–5 倍"], [5, "5–10 倍"], [10, "≥10 倍"]], "<2 倍") ?? "未知" },
  { id: "btc", label: "BTC 同期走势", order: ["BTC 反向 ≥0.3%", "BTC 平稳", "BTC 同向 ≥0.3%", "未知"],
    bucket: (sample) => ranges(aligned(sample, sample.features.btcWindow),
      [[-0.3, "BTC 平稳"], [0.3, "BTC 同向 ≥0.3%"]], "BTC 反向 ≥0.3%") ?? "未知" },
  { id: "pre60", label: "前 1 小时走势", order: ["反向 >1%", "平稳 ±1%", "同向 1–5%", "同向 >5%", "未知"],
    bucket: (sample) => ranges(aligned(sample, sample.features.pre60),
      [[-1, "平稳 ±1%"], [1, "同向 1–5%"], [5, "同向 >5%"]], "反向 >1%") ?? "未知" },
  { id: "oi", label: "15 分钟持仓量变化", order: ["减少 >1%", "持平 ±1%", "增加 1–5%", "增加 >5%", "未知"],
    bucket: (sample) => ranges(sample.features.oiChange15, [[-1, "持平 ±1%"], [1, "增加 1–5%"], [5, "增加 >5%"]], "减少 >1%") ?? "未知" },
  { id: "taker", label: "顺向主动成交占比", order: ["<50%", "50–60%", "60–70%", "≥70%", "未知"],
    bucket: (sample) => {
      const share = sample.features.takerBuyShare;
      if (share === null) return "未知";
      const same = sample.direction === "up" ? share : 1 - share;
      return ranges(same * 100, [[50, "50–60%"], [60, "60–70%"], [70, "≥70%"]], "<50%");
    } },
  { id: "funding", label: "资金费率", order: ["负费率", "0–0.03%", "≥0.03%", "未知"],
    bucket: (sample) => ranges(sample.features.fundingRate, [[0, "0–0.03%"], [0.03, "≥0.03%"]], "负费率") ?? "未知" },
  { id: "liquidity", label: "24 小时成交额", order: ["<2000 万", "2000 万–1 亿", "1–5 亿", "≥5 亿", "未知"],
    bucket: (sample) => ranges(sample.features.quoteVolume24h,
      [[2e7, "2000 万–1 亿"], [1e8, "1–5 亿"], [5e8, "≥5 亿"]], "<2000 万") ?? "未知" },
  { id: "hour", label: "北京时间", order: ["0–6 点", "6–12 点", "12–18 点", "18–24 点"],
    bucket: (sample) => ["0–6 点", "6–12 点", "12–18 点", "18–24 点"][Math.floor(sample.features.hour / 6)] ?? null },
  { id: "status", label: "成交额核验（实时告警）", order: ["已告警", "成交额不足"],
    bucket: (sample) => sample.status === "alerted" ? "已告警" : sample.status === "below-threshold" ? "成交额不足" : null },
];

export type GroupRow = { bucket: string; chase: TradeStats; fade: TradeStats };

export function groupStats(samples: readonly SignalSample[], groupId: string, barrier: number, cost: number): GroupRow[] {
  const group = SIGNAL_GROUPS.find(({ id }) => id === groupId);
  if (!group) return [];
  const buckets = new Map<string, SignalSample[]>();
  for (const sample of samples) {
    const bucket = group.bucket(sample);
    if (bucket === null) continue;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), sample]);
  }
  return group.order.filter((bucket) => buckets.has(bucket)).map((bucket) => {
    const rows = buckets.get(bucket) ?? [];
    return {
      bucket,
      chase: tradeStats(rows.map((sample) => sample.barriers[barrier]?.chase), cost),
      fade: tradeStats(rows.map((sample) => sample.barriers[barrier]?.fade), cost),
    };
  });
}

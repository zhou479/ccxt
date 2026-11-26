import type { SignalExit, SignalPlan, SignalSample } from "./signal-types";

/** Groups with fewer samples than this are flagged: the numbers are mostly noise. */
export const MIN_SAMPLES = 30;
/** A result counts as credible only with this many independent events behind it. */
export const MIN_EVENTS = 50;
/** Credible results must clear this net average per trade, %, leaving room for live slippage. */
export const MIN_EDGE = 0.15;
/** Credible results must win at least this many times what they lose. */
export const MIN_PROFIT_FACTOR = 1.2;
/** Credible results must survive removing this many best trades. */
export const TRIMMED_TRADES = 2;
export function barrierLabel({ kind = "fixed", stop, take, hold }: SignalPlan) {
  const time = !hold || hold === 60 ? "" : hold % 60 === 0 ? ` · ${hold / 60} 小时` : ` · ${hold} 分钟`;
  switch (kind) {
    case "volatility": return `${stop}σ / ${take}σ（按波动率）${time}`;
    case "breakeven": return `${stop}% / ${take}% 保本${time}`;
    case "trailing": return `移动止损 ${stop}%${time}`;
    default: return `${stop}% / ${take}%${time}`;
  }
}

/** Liquidity floor options: 24h turnover before the signal, USDT. */
export const LIQUIDITY_OPTIONS = [0, 2e7, 1e8] as const;
/** Round-trip cost per trade, %: taker fees on both sides plus slippage, or tiered by liquidity. */
export const COST_OPTIONS = [0.1, 0.15, 0.2, 0.3, "tiered"] as const;
export type CostModel = number | "tiered";
export const DEFAULT_COST: CostModel = "tiered";
/**
 * Tiered cost by the 24h turnover before the signal: 0.1% taker fees plus slippage on both sides,
 * wider for thinner contracts. Unknown turnover gets the thinnest tier.
 */
export const COST_TIERS: readonly [number, number][] = [[5e8, 0.14], [1e8, 0.2], [2e7, 0.3], [0, 0.5]];

export function costFor(sample: SignalSample, model: CostModel): number {
  if (model !== "tiered") return model;
  const volume = sample.features.quoteVolume24h ?? 0;
  return COST_TIERS.find(([floor]) => volume >= floor)?.[1] ?? 0.5;
}
/** Symbols that moved during this much time before a signal count as moving with it. */
export const CONCURRENCY_WINDOW_MS = 5 * 60_000;
/** Samples closer than this in time belong to the same market event. */
export const EVENT_GAP_MS = 15 * 60_000;
/** A symbol is sampled at most once per this interval (the historical scan already does this). */
export const SYMBOL_COOLDOWN_MS = 30 * 60_000;

export type MarketKind = "single" | "mixed" | "market";

/** How many symbols moved together decides whether a move was the coin's own or the whole market's. */
export function marketKind(concurrent: number): MarketKind {
  return concurrent <= 3 ? "single" : concurrent >= 10 ? "market" : "mixed";
}

export type SampleContext = {
  /**
   * Symbols (including this one) with a sample in the CONCURRENCY_WINDOW_MS before it. Only the past
   * counts, exactly as a live strategy would see it: the first coin of a market-wide move looks alone.
   */
  concurrent: number;
  /** The move minus BTC's move over the same window, % (null without BTC data). */
  excess: number | null;
  /** Samples sharing an event id happened in one burst of market activity. */
  event: number;
  /** 0 for the earlier half of the period, 1 for the later half. */
  half: 0 | 1;
  /** Same symbol sampled again within SYMBOL_COOLDOWN_MS. */
  repeat: boolean;
};

export type StudySample = SignalSample & { context: SampleContext };

/**
 * Adds cross-sample context. Always computed on the whole source, before any filter,
 * so that filtering never changes a sample's concurrency, event or half.
 */
export function prepareSamples(samples: readonly SignalSample[]): StudySample[] {
  const sorted = [...samples].sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const middle = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)].time : 0;
  const lastBySymbol = new Map<string, number>();
  let event = 0;
  let start = 0;
  return sorted.map((sample, index) => {
    // Events group samples for statistics only, so they may look both ways.
    if (index > 0 && sample.time - sorted[index - 1].time > EVENT_GAP_MS) event += 1;
    while (sorted[start].time < sample.time - CONCURRENCY_WINDOW_MS) start += 1;
    // Samples with the very same timestamp closed on the same bar, which a strategy acting at the
    // bar's close (as the scan's entries do) would already have seen.
    let end = index;
    while (end + 1 < sorted.length && sorted[end + 1].time === sample.time) end += 1;
    const symbols = new Set(sorted.slice(start, end + 1).map(({ symbol }) => symbol));
    const previous = lastBySymbol.get(sample.symbol);
    const repeat = previous !== undefined && sample.time - previous < SYMBOL_COOLDOWN_MS;
    if (!repeat) lastBySymbol.set(sample.symbol, sample.time);
    const btc = sample.features.btcWindow;
    return {
      ...sample,
      context: {
        concurrent: symbols.size,
        excess: btc === null ? null : Math.round((sample.change - btc) * 10_000) / 10_000,
        event,
        half: sample.time <= middle ? 0 : 1,
        repeat,
      },
    };
  });
}

export type SampleFilter = {
  direction: "all" | "up" | "down";
  minMultiple: number;
  alertedOnly: boolean;
  market: "all" | MarketKind;
  /** Minimum 24h turnover before the signal, USDT; 0 keeps samples without the figure. */
  minVolume: number;
};

export function filterSamples(samples: readonly StudySample[], filter: SampleFilter): StudySample[] {
  return samples.filter((sample) =>
    !sample.context.repeat &&
    (filter.direction === "all" || sample.direction === filter.direction) &&
    (filter.minMultiple <= 0 || (sample.turnoverMultiple ?? -Infinity) >= filter.minMultiple) &&
    (!filter.alertedOnly || sample.status !== "below-threshold") &&
    (filter.market === "all" || marketKind(sample.context.concurrent) === filter.market) &&
    (filter.minVolume <= 0 || (sample.features.quoteVolume24h ?? 0) >= filter.minVolume));
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

export type OutcomeStats = TradeStats & {
  /** Independent market events behind the trades. */
  events: number;
  /** Share of events whose trades made money on average. */
  eventWinRate: number | null;
  /** Average net result in the earlier and the later half of the period. */
  halves: [number | null, number | null];
  /** Total net gains divided by total net losses; null without losses. */
  profitFactor: number | null;
  /** Average net result without the TRIMMED_TRADES best trades. */
  trimmed: number | null;
  /** Clears MIN_EDGE and MIN_PROFIT_FACTOR, positive in both halves and after trimming, with enough events. */
  credible: boolean;
};

type Side = "chase" | "fade";

/** Trade statistics that also look at independent events and at both halves of the period. */
export function outcomeStats(samples: readonly StudySample[], barrier: number, side: Side, cost: CostModel): OutcomeStats {
  const trades = samples.flatMap((sample) => {
    const exit = sample.barriers[barrier]?.[side];
    return exit ? [{ sample, exit, net: exit.pnl - costFor(sample, cost) }] : [];
  });
  const base = tradeStats(trades.map(({ exit, net }) => ({ ...exit, pnl: net })), 0);
  const byEvent = new Map<number, number[]>();
  for (const { sample, net } of trades) byEvent.set(sample.context.event, [...(byEvent.get(sample.context.event) ?? []), net]);
  const eventMeans = [...byEvent.values()].map((values) => mean(values) ?? 0);
  const halves = ([0, 1] as const).map((half) =>
    mean(trades.filter(({ sample }) => sample.context.half === half).map(({ net }) => net))) as [number | null, number | null];
  const nets = trades.map(({ net }) => net).sort((a, b) => a - b);
  const gains = nets.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -nets.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const profitFactor = losses > 0 ? gains / losses : null;
  const trimmed = mean(nets.slice(0, Math.max(0, nets.length - TRIMMED_TRADES)));
  return {
    ...base,
    events: byEvent.size,
    eventWinRate: eventMeans.length ? eventMeans.filter((value) => value > 0).length / eventMeans.length : null,
    halves,
    profitFactor,
    trimmed,
    credible: (base.average ?? 0) >= MIN_EDGE && halves.every((value) => value !== null && value > 0) &&
      (profitFactor === null || profitFactor >= MIN_PROFIT_FACTOR) && (trimmed ?? 0) > 0 && byEvent.size >= MIN_EVENTS,
  };
}

export type BarrierRow = SignalPlan & { chase: OutcomeStats; fade: OutcomeStats };

/** Simulated results per exit plan, chasing the move and fading it. */
export function barrierStats(samples: readonly StudySample[], barriers: readonly SignalPlan[], cost: CostModel): BarrierRow[] {
  return barriers.map((plan, index) => ({
    ...plan,
    chase: outcomeStats(samples, index, "chase", cost),
    fade: outcomeStats(samples, index, "fade", cost),
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

type Bucket = (sample: StudySample) => string | null;

function ranges(value: number | null, edges: readonly [number, string][], below: string) {
  if (value === null || !Number.isFinite(value)) return null;
  let label = below;
  for (const [edge, name] of edges) if (value >= edge) label = name;
  return label;
}

/** Liquidations are only known while the archive's stream was connected. */
function liquidationBucket(value: number | null | undefined) {
  if (value === null || value === undefined) return "未接收";
  return value === 0 ? "无爆仓" : ranges(value, [[1e5, "10–100 万"], [1e6, "≥100 万"]], "<10 万");
}

export type SignalGroup = { id: string; label: string; order: readonly string[]; bucket: Bucket };

export const SIGNAL_GROUPS: readonly SignalGroup[] = [
  { id: "market", label: "同时异动币数", order: ["个币独立（≤3 个）", "中间（4–9 个）", "全市场（≥10 个）"],
    bucket: (sample) => ({ single: "个币独立（≤3 个）", mixed: "中间（4–9 个）", market: "全市场（≥10 个）" })[marketKind(sample.context.concurrent)] },
  { id: "excess", label: "相对 BTC 的超额涨跌", order: ["<2%", "2–3%", "3–5%", "5–10%", "≥10%", "未知"],
    bucket: (sample) => ranges(aligned(sample, sample.context.excess), [[2, "2–3%"], [3, "3–5%"], [5, "5–10%"], [10, "≥10%"]], "<2%") ?? "未知" },
  { id: "zScore", label: "波动率倍数（异动是平时波动的几倍）", order: ["<3σ", "3–5σ", "5–8σ", "8–12σ", "≥12σ", "未知"],
    bucket: (sample) => ranges(sample.features.zScore === null || sample.features.zScore === undefined ? null : Math.abs(sample.features.zScore),
      [[3, "3–5σ"], [5, "5–8σ"], [8, "8–12σ"], [12, "≥12σ"]], "<3σ") ?? "未知" },
  { id: "range24h", label: "前 24 小时振幅", order: ["≤3%", "3–5%", "5–10%", "10–20%", ">20%", "未知"],
    bucket: (sample) => ranges(sample.features.range24h ?? null, [[3, "3–5%"], [5, "5–10%"], [10, "10–20%"], [20, ">20%"]], "≤3%") ?? "未知" },
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
  { id: "liqSame", label: "前 5 分钟顺向爆仓", order: ["无爆仓", "<10 万", "10–100 万", "≥100 万", "未接收"],
    bucket: (sample) => liquidationBucket(sample.features.liqSame5) },
  { id: "liqOpp", label: "前 5 分钟反向爆仓", order: ["无爆仓", "<10 万", "10–100 万", "≥100 万", "未接收"],
    bucket: (sample) => liquidationBucket(sample.features.liqOpp5) },
  { id: "hour", label: "北京时间", order: ["0–6 点", "6–12 点", "12–18 点", "18–24 点"],
    bucket: (sample) => ["0–6 点", "6–12 点", "12–18 点", "18–24 点"][Math.floor(sample.features.hour / 6)] ?? null },
  { id: "status", label: "成交额核验（实时告警）", order: ["已告警", "成交额不足"],
    bucket: (sample) => sample.status === "alerted" ? "已告警" : sample.status === "below-threshold" ? "成交额不足" : null },
];

export type GroupRow = { bucket: string; chase: OutcomeStats; fade: OutcomeStats };

export function groupStats(samples: readonly StudySample[], groupId: string, barrier: number, cost: CostModel): GroupRow[] {
  const group = SIGNAL_GROUPS.find(({ id }) => id === groupId);
  if (!group) return [];
  const buckets = new Map<string, StudySample[]>();
  for (const sample of samples) {
    const bucket = group.bucket(sample);
    if (bucket === null) continue;
    buckets.set(bucket, [...(buckets.get(bucket) ?? []), sample]);
  }
  return group.order.filter((bucket) => buckets.has(bucket)).map((bucket) => {
    const rows = buckets.get(bucket) ?? [];
    return {
      bucket,
      chase: outcomeStats(rows, barrier, "chase", cost),
      fade: outcomeStats(rows, barrier, "fade", cost),
    };
  });
}

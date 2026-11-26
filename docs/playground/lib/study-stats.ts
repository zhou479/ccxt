import type { FundingSample, Regime, StudyOutcome, StudyPlan, StudySide } from "./study-types";

/** 通过标准，第一次检验前定好（见 README「中低频策略检验」）。 */
export const STUDY_MIN_EVENTS = 50;
/** 持仓几小时到几天，门槛比分钟级信号的 0.15% 高。 */
export const STUDY_MIN_EDGE = 0.3;
export const STUDY_MIN_PROFIT_FACTOR = 1.2;
export const STUDY_TRIMMED = 2;
/** 任何一个行情阶段的每笔平均都不能低于这个值。 */
export const STUDY_REGIME_FLOOR = -0.5;
/** 交易笔数少于这个值的行情阶段只显示、不判断。 */
export const STUDY_REGIME_MIN_TRADES = 10;
/** 相隔不超过这个时间的信号属于同一轮结算，算一次独立事件。 */
export const ROUND_GAP_MS = 60 * 60_000;
export const PRIMARY_PLAN = 0;

export const REGIMES: readonly Regime[] = ["bull", "bear", "range"];
export const REGIME_LABELS: Record<Regime, string> = { bull: "牛市", bear: "熊市", range: "震荡" };

/**
 * 按 24 小时成交额分档的往返成本，和信号效果统计相同（signal-stats.ts 的 COST_TIERS，有测试保证一致）。
 * 这里不直接 import：lib 文件之间的运行时导入会让 Node 直接跑的测试找不到模块。
 */
export const STUDY_COST_TIERS: readonly [number, number][] = [[5e8, 0.14], [1e8, 0.2], [2e7, 0.3], [0, 0.5]];

export function studyCost(sample: FundingSample): number {
  return STUDY_COST_TIERS.find(([floor]) => sample.features.volume24h >= floor)?.[1] ?? 0.5;
}

export type Hypothesis = {
  id: string;
  label: string;
  /** 登记时的预期。 */
  expectation: string;
  side: (sample: FundingSample) => StudySide | null;
};

/** 第一次检验前登记，看到结果后不能修改。 */
export const HYPOTHESES: readonly Hypothesis[] = [
  { id: "F1", label: "F1 负费率极端 → 做多", expectation: "空头回补，同时收资金费",
    side: (sample) => (sample.direction === "negative" ? "long" : null) },
  { id: "F0", label: "F0 正费率极端 → 做空（对照）", expectation: "不加确认的反向做空",
    side: (sample) => (sample.direction === "positive" ? "short" : null) },
  { id: "F2", label: "F2 正费率极端 且 前 24 小时下跌 → 做空", expectation: "多头拥挤且价格开始走弱",
    side: (sample) => (sample.direction === "positive" && (sample.features.ret24h ?? 0) < 0 ? "short" : null) },
  { id: "F3", label: "F3 顺着拥挤方向：正费率做多、负费率做空", expectation: "费率回归但价格延续",
    side: (sample) => (sample.direction === "positive" ? "long" : "short") },
];

export type PreparedSample = FundingSample & { event: number; half: 0 | 1 };

/** 给每个样本标上所属的结算轮次（独立事件）和前后半段，按时间从早到晚。 */
export function prepareStudy(samples: readonly FundingSample[]): PreparedSample[] {
  const sorted = [...samples].sort((a, b) => a.time - b.time);
  const middle = sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)].time : 0;
  let event = 0;
  return sorted.map((sample, index) => {
    if (index > 0 && sample.time - sorted[index - 1].time > ROUND_GAP_MS) event += 1;
    return { ...sample, event, half: sample.time <= middle ? 0 : 1 };
  });
}

export type StudyTrade = { sample: PreparedSample; side: StudySide; outcome: StudyOutcome; net: number };

export function studyTrades(samples: readonly PreparedSample[], hypothesis: Hypothesis, plan: number): StudyTrade[] {
  return samples.flatMap((sample) => {
    const side = hypothesis.side(sample);
    const outcome = side ? sample.plans[plan]?.[side] : null;
    return side && outcome ? [{ sample, side, outcome, net: outcome.price + outcome.funding - studyCost(sample) }] : [];
  });
}

const mean = (values: readonly number[]) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);

export type StudyStats = {
  count: number;
  events: number;
  average: number | null;
  winRate: number | null;
  price: number | null;
  funding: number | null;
  cost: number | null;
  hours: number | null;
  halves: [number | null, number | null];
  profitFactor: number | null;
  trimmed: number | null;
  total: number;
  maxDrawdown: number;
  regimes: Record<Regime, { count: number; average: number | null }>;
  exits: Record<StudyOutcome["exit"], number>;
  delistedShare: number | null;
  /** 没满足的标准，全部满足时为空。 */
  failures: string[];
  credible: boolean;
};

export function studyStats(trades: readonly StudyTrade[]): StudyStats {
  const nets = trades.map(({ net }) => net);
  const sorted = [...nets].sort((a, b) => a - b);
  const gains = nets.filter((value) => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = -nets.filter((value) => value < 0).reduce((sum, value) => sum + value, 0);
  const profitFactor = losses > 0 ? gains / losses : null;
  const trimmed = mean(sorted.slice(0, Math.max(0, sorted.length - STUDY_TRIMMED)));
  const halves = ([0, 1] as const).map((half) => mean(trades.filter(({ sample }) => sample.half === half).map(({ net }) => net))) as
    [number | null, number | null];
  // 按平仓先后逐笔累计（每笔一份），计算累计收益的最大回撤（drawdown）。
  const closed = [...trades].sort((a, b) => a.sample.entryTime + a.outcome.hours * 3_600_000 - (b.sample.entryTime + b.outcome.hours * 3_600_000));
  let running = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const { net } of closed) {
    running += net;
    peak = Math.max(peak, running);
    maxDrawdown = Math.max(maxDrawdown, peak - running);
  }
  const regimes = Object.fromEntries(REGIMES.map((regime) => {
    const values = trades.filter(({ sample }) => sample.features.regime === regime).map(({ net }) => net);
    return [regime, { count: values.length, average: mean(values) }];
  })) as StudyStats["regimes"];
  const exits = { normal: 0, time: 0, stop: 0, delisted: 0 };
  for (const { outcome } of trades) exits[outcome.exit] += 1;
  const events = new Set(trades.map(({ sample }) => sample.event)).size;
  const average = mean(nets);
  const failures: string[] = [];
  if (events < STUDY_MIN_EVENTS) failures.push(`独立事件 ${events} < ${STUDY_MIN_EVENTS}`);
  if ((average ?? -Infinity) < STUDY_MIN_EDGE) failures.push(`每笔平均低于 +${STUDY_MIN_EDGE}%`);
  if (!halves.every((value) => value !== null && value > 0)) failures.push("前后两段没有都赚");
  if (profitFactor !== null && profitFactor < STUDY_MIN_PROFIT_FACTOR) failures.push(`总盈利 ÷ 总亏损 < ${STUDY_MIN_PROFIT_FACTOR}`);
  if (!((trimmed ?? -Infinity) > 0)) failures.push(`去掉最赚 ${STUDY_TRIMMED} 笔后不赚`);
  for (const regime of REGIMES) {
    const { count, average: value } = regimes[regime];
    if (count >= STUDY_REGIME_MIN_TRADES && (value ?? 0) < STUDY_REGIME_FLOOR) failures.push(`${REGIME_LABELS[regime]}每笔亏损超过 ${-STUDY_REGIME_FLOOR}%`);
  }
  if (maxDrawdown > running) failures.push("最大回撤超过累计收益");
  return {
    count: trades.length,
    events,
    average,
    winRate: nets.length ? nets.filter((value) => value > 0).length / nets.length : null,
    price: mean(trades.map(({ outcome }) => outcome.price)),
    funding: mean(trades.map(({ outcome }) => outcome.funding)),
    cost: mean(trades.map(({ sample }) => studyCost(sample))),
    hours: mean(trades.map(({ outcome }) => outcome.hours)),
    halves,
    profitFactor,
    trimmed,
    total: running,
    maxDrawdown,
    regimes,
    exits,
    delistedShare: trades.length ? trades.filter(({ sample }) => sample.delisted).length / trades.length : null,
    failures,
    credible: trades.length > 0 && failures.length === 0,
  };
}

export function planLabel({ kind, hold, stop }: StudyPlan): string {
  const time = hold % 24 === 0 ? `${hold / 24} 天` : `${hold} 小时`;
  const exit = kind === "normal" ? `费率恢复正常就平，最多 ${time}` : `固定持仓 ${time}`;
  return `${exit} · ${stop === null ? "不设止损" : `止损 ${stop}%`}`;
}

export type StudyGroup = { id: string; label: string; bucket: (sample: FundingSample) => string | null };

export const STUDY_GROUPS: readonly StudyGroup[] = [
  { id: "regime", label: "行情阶段", bucket: (sample) => (sample.features.regime ? REGIME_LABELS[sample.features.regime] : "未知") },
  { id: "rate", label: "费率极端程度（8 小时口径）", bucket: (sample) => {
    const rate = Math.abs(sample.features.rate8h);
    return rate >= 0.5 ? "≥0.5%" : rate >= 0.3 ? "0.3–0.5%" : rate >= 0.2 ? "0.2–0.3%" : "0.1–0.2%";
  } },
  { id: "interval", label: "结算间隔", bucket: (sample) => `${sample.features.intervalHours} 小时` },
  { id: "concurrent", label: "同时拥挤的合约数", bucket: (sample) =>
    sample.features.concurrent >= 10 ? "≥10 个" : sample.features.concurrent >= 3 ? "3–9 个" : "1–2 个" },
  { id: "ret24h", label: "进场前 24 小时涨跌", bucket: (sample) => {
    const value = sample.features.ret24h;
    if (value === null) return null;
    return value <= -10 ? "≤−10%" : value < 0 ? "−10%–0" : value < 10 ? "0–10%" : "≥10%";
  } },
  { id: "rank", label: "流动性排名", bucket: (sample) => (sample.features.rank <= 20 ? "前 20" : sample.features.rank <= 50 ? "21–50" : "51 以后") },
  { id: "delisted", label: "后来是否下架", bucket: (sample) => (sample.delisted ? "已下架" : "仍在交易") },
];

export function studyGroupStats(samples: readonly PreparedSample[], hypothesis: Hypothesis, plan: number, groupId: string) {
  const group = STUDY_GROUPS.find(({ id }) => id === groupId);
  if (!group) return [];
  const buckets = new Map<string, PreparedSample[]>();
  for (const sample of samples) {
    const bucket = group.bucket(sample);
    if (bucket !== null) buckets.set(bucket, [...(buckets.get(bucket) ?? []), sample]);
  }
  return [...buckets.entries()]
    .map(([bucket, rows]) => ({ bucket, stats: studyStats(studyTrades(rows, hypothesis, plan)) }))
    .filter(({ stats }) => stats.count > 0)
    .sort((a, b) => a.bucket.localeCompare(b.bucket, "zh"));
}

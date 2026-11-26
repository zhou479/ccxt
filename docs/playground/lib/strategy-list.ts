/**
 * 工作台「策略」页的策略列表：把各个策略的状态整理成统一的卡片数据。
 *
 * 不管有没有通过历史检验，每个策略都有自己的卡片，它的参数、记录和检验结果都放在卡片详情里。
 * 现在有异动监控策略（只告警）、资金费率策略（未通过检验）和测试策略（手动下单）。
 * 等有了第一个通过检验、真正运行的交易策略，再把启停和状态统一挪到后端。
 */
import type { BackgroundMonitorStatus } from "./background-monitor-types";
import type { StudySummary } from "./study-stats";
import type { Trade } from "./trading-types";

const HOUR = 3_600_000;
const BEIJING_OFFSET = 8 * HOUR;

/** 北京时间当天 0 点（UTC 毫秒），和后端的每日亏损统计一致。 */
export function beijingDayStart(now: number): number {
  return Math.floor((now + BEIJING_OFFSET) / (24 * HOUR)) * 24 * HOUR - BEIJING_OFFSET;
}

export type StrategyKind = "alert" | "manual" | "trading";

export const STRATEGY_KIND_LABELS: Record<StrategyKind, string> = { alert: "只告警", manual: "手动下单", trading: "自动交易" };

export type StrategyCard = {
  id: string;
  name: string;
  kind: StrategyKind;
  /** 是否在运行；手动策略没有运行状态，为 null。 */
  running: boolean | null;
  /** 运行状态的说明，例如「运行中 · 行情已连接」。 */
  status: string;
  /** 状态是否异常（例如监控进程离线）。 */
  warning: boolean;
  stats: { label: string; value: string }[];
  /** 能否在卡片上直接启停。 */
  toggleable: boolean;
  /** 历史检验的结论；没有检验过时为 null。 */
  verdict: { passed: boolean; text: string } | null;
  /** 点开卡片后的详情分类，例如参数设置、这个策略产生的记录、它的检验结果。没有详情时为空。 */
  details: { id: string; label: string }[];
};

function percent(value: number | null) {
  return value === null ? null : `${Math.abs(value)}%`;
}

/** 异动监控策略：启停就是后台监控规则的 enabled。 */
export function spikeMonitorCard(monitor: BackgroundMonitorStatus | null, now: number): StrategyCard {
  const rule = monitor?.configured ? monitor.rule : null;
  const running = rule?.enabled === true;
  const worker = monitor?.worker;
  const today = beijingDayStart(now);
  const alerts = (monitor?.spikes ?? []).filter((spike) => spike.time >= today && (spike.status === "alerted" || spike.status === "upgraded")).length;
  const status = !monitor ? "正在读取状态"
    : !running ? (rule ? "已停止" : "还没有保存过规则")
    : worker === "connected" ? "运行中 · 行情已连接"
    : worker === "offline" ? "运行中 · 监控进程离线，正在重试"
    : "运行中 · 正在连接行情";
  const directions = rule ? [rule.up !== null ? `涨 ${percent(rule.up)}` : null, rule.down !== null ? `跌 ${percent(rule.down)}` : null]
    .filter(Boolean).join(" / ") : "";
  return {
    id: "spike-monitor",
    name: "异动监控策略",
    kind: "alert",
    running,
    status,
    warning: running && worker === "offline",
    stats: [
      { label: "今日告警", value: String(alerts) },
      { label: "钉钉通知", value: rule?.notify ? "开" : "关" },
      ...(rule ? [{ label: "规则", value: `${rule.seconds} 秒内${directions} · 成交额 ≥ ${rule.turnoverMultiple} 倍` }] : []),
    ],
    toggleable: true,
    // 30 天、959 个独立事件的检验：追进去和反着做扣成本后都亏，所以只告警、不下单。
    verdict: { passed: false, text: "异动追单未通过历史检验（追进去和反着做扣成本后都亏），只用来告警" },
    details: [
      { id: "settings", label: "参数设置" },
      { id: "records", label: "异动记录" },
      { id: "signals", label: "信号统计" },
    ],
  };
}

function day(time: number) {
  return new Date(time + BEIJING_OFFSET).toISOString().slice(0, 10);
}

function signedPercent(value: number | null) {
  return value === null ? "—" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

/**
 * 资金费率策略：费率从常态变成极端时做多或做空。只有历史检验通过后才会实现自动下单，所以现在没有启停。
 * `summary` 是最近一次检验的摘要，`studying` 表示检验正在进行。
 */
export function fundingStrategyCard(summary: StudySummary | null, studying: boolean): StrategyCard {
  const passed = (summary?.passed ?? 0) > 0;
  const status = studying ? "正在运行历史检验…"
    : !summary ? "还没有检验结果，打开详情运行历史检验"
    : passed ? `${summary.passed} 个假设通过历史检验，写成规则后可以上模拟盘`
    : "未通过历史检验，不能启用";
  return {
    id: "funding-rate",
    name: "资金费率策略",
    kind: "trading",
    running: false,
    status,
    warning: false,
    stats: summary ? [
      { label: "检验区间", value: `${day(summary.from)} 至 ${day(summary.to)}` },
      { label: "信号", value: `${summary.signals} 个` },
      { label: "通过", value: `${summary.passed} / ${summary.total}` },
      { label: "最好", value: `${summary.best.id} 每笔 ${signedPercent(summary.best.average)}` },
    ] : [],
    toggleable: false,
    verdict: summary ? {
      passed,
      text: passed ? `历史检验：${summary.passed} / ${summary.total} 个假设通过` : `历史检验：${summary.total} 个假设全部未通过，扣成本并计入资金费后都亏`,
    } : null,
    details: [{ id: "study", label: "历史检验" }],
  };
}

/** 测试策略：手动下单打通链路用，没有启停。 */
export function testStrategyCard(trades: readonly Trade[], now: number): StrategyCard {
  const today = beijingDayStart(now);
  const own = trades.filter((trade) => trade.strategy.id === "test");
  const active = own.filter((trade) => ["opening", "open", "closing"].includes(trade.status)).length;
  return {
    id: "test",
    name: "测试策略",
    kind: "manual",
    running: null,
    status: "手动下单，用来检查下单链路",
    warning: false,
    stats: [
      { label: "今日下单", value: String(own.filter((trade) => trade.openedAt >= today).length) },
      { label: "持仓中", value: String(active) },
    ],
    toggleable: false,
    verdict: null,
    details: [],
  };
}

export function strategyCards(
  monitor: BackgroundMonitorStatus | null,
  trades: readonly Trade[],
  now: number,
  funding: { summary: StudySummary | null; studying: boolean } = { summary: null, studying: false },
): StrategyCard[] {
  return [spikeMonitorCard(monitor, now), fundingStrategyCard(funding.summary, funding.studying), testStrategyCard(trades, now)];
}

/** 总览顶部的一句话：哪些策略在运行。 */
export function runningSummary(cards: readonly StrategyCard[]): { running: number; text: string } {
  const running = cards.filter((card) => card.running);
  return {
    running: running.length,
    text: running.length === 0 ? "暂无运行中的策略" : `${running.map((card) => card.name).join("、")}运行中`,
  };
}

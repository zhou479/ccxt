/**
 * 工作台「策略」页的策略列表：把各个策略的状态整理成统一的卡片数据。
 *
 * 现在只有异动监控策略（只告警）和测试策略（手动下单）。以后新增的自动交易策略，在这里加一项即可出现在策略页；
 * 等有了第二个真正的交易策略，再把启停和状态统一挪到后端。
 */
import type { BackgroundMonitorStatus } from "./background-monitor-types";
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
    verdict: { passed: false, text: "信号统计：追进去扣成本后亏损，因此只告警、不自动下单" },
    details: [
      { id: "settings", label: "参数设置" },
      { id: "records", label: "异动记录" },
      { id: "signals", label: "信号统计" },
    ],
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

export function strategyCards(monitor: BackgroundMonitorStatus | null, trades: readonly Trade[], now: number): StrategyCard[] {
  return [spikeMonitorCard(monitor, now), testStrategyCard(trades, now)];
}

/** 总览顶部的一句话：哪些策略在运行。 */
export function runningSummary(cards: readonly StrategyCard[]): { running: number; text: string } {
  const running = cards.filter((card) => card.running);
  return {
    running: running.length,
    text: running.length === 0 ? "暂无运行中的策略" : `${running.map((card) => card.name).join("、")}运行中`,
  };
}

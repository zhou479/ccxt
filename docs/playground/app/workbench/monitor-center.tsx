"use client";

import type { BackgroundMonitorStatus } from "@/lib/background-monitor-types";
import { beijingDayStart } from "@/lib/strategy-list";
import MarketMonitor from "../markets/market-monitor";
import styles from "./workbench.module.css";

type Props = {
  monitor: { data: BackgroundMonitorStatus | null; error: string };
  onOpenStrategies: () => void;
};

const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", timeStyle: "short" });

function percent(value: number | null) {
  return value === null ? null : `${Math.abs(value)}%`;
}

/**
 * 异动监控中心：监控是否在运行、今天的告警、监控指标和最近的告警记录。
 * 「监控指标」先留空，之后找到想监控的指标再逐个加进来。
 */
export default function MonitorCenter({ monitor, onOpenStrategies }: Props) {
  const data = monitor.data;
  const rule = data?.configured ? data.rule : null;
  const running = rule?.enabled === true;
  const today = beijingDayStart(Date.now());
  const spikes = data?.spikes ?? [];
  const todaySpikes = spikes.filter((spike) => spike.time >= today);
  const alerted = todaySpikes.filter((spike) => spike.status === "alerted" || spike.status === "upgraded");
  const latest = [...spikes].sort((a, b) => b.time - a.time)[0];
  const worker = !data ? "正在读取" : !running ? "监控已停止"
    : data.worker === "connected" ? "运行中 · 行情已连接" : data.worker === "offline" ? "运行中 · 监控进程离线，正在重试" : "运行中 · 正在连接行情";
  const directions = rule ? [rule.up !== null ? `涨 ${percent(rule.up)}` : null, rule.down !== null ? `跌 ${percent(rule.down)}` : null]
    .filter(Boolean).join(" / ") : "—";

  return (
    <>
      {monitor.error && <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">{monitor.error}</p>}
      <div className={styles.statusBar}>
        <span className={styles.statusItem}>
          <span className={`${styles.dot} ${running ? (data?.worker === "offline" ? styles.dotWarn : styles.dotOk) : ""}`} />{worker}
        </span>
        {rule && <span className={styles.statusItem}>规则：{rule.seconds} 秒内{directions} · 成交额 ≥ {rule.turnoverMultiple} 倍</span>}
        <span className={styles.statusItem}>钉钉通知 {rule?.notify ? "开" : "关"}</span>
        <div className={styles.actions}>
          <button type="button" className={styles.button} onClick={onOpenStrategies}>启停与参数设置</button>
        </div>
      </div>

      <div className={styles.metrics}>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>今日告警（北京时间）</div>
          <div className={styles.metricValue}>{alerted.length}</div>
          <div className={styles.metricNote}>价格达到阈值、成交额也达标</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>今日异动</div>
          <div className={styles.metricValue}>{todaySpikes.length}</div>
          <div className={styles.metricNote}>包括成交额不够、没有告警的</div>
        </div>
        <div className={styles.metric}>
          <div className={styles.metricLabel}>最近一次异动</div>
          <div className={`${styles.metricValue} ${styles.metricSmall}`}>{latest ? latest.symbol : "—"}</div>
          <div className={styles.metricNote}>{latest ? `${clock.format(latest.time)} · ${latest.change > 0 ? "+" : ""}${latest.change.toFixed(2)}%` : "还没有异动"}</div>
        </div>
      </div>

      <section className={styles.card} aria-label="监控指标">
        <div className={styles.cardHeader}>
          <h3 className={styles.cardTitle}>监控指标</h3>
          <span className={styles.cardMeta}>之后在这里添加想监控的指标</span>
        </div>
        <div className={styles.empty}>还没有添加监控指标。</div>
      </section>

      <MarketMonitor section="records" contracts={undefined} coinCount={null} directoryError={false} />
    </>
  );
}

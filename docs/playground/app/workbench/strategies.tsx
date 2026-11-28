"use client";

import { useState } from "react";
import type { BackgroundMonitorStatus, BackgroundRule } from "@/lib/background-monitor-types";
import { STRATEGY_KIND_LABELS, type StrategyCard } from "@/lib/strategy-list";
import MarketMonitor from "../markets/market-monitor";
import styles from "./workbench.module.css";

type Props = {
  cards: StrategyCard[];
  monitor: { data: BackgroundMonitorStatus | null; saving: boolean; error: string; save: (rule: BackgroundRule) => Promise<void> };
};

/** 策略页：每个策略一张卡片，显示类型、状态和今日数据；可以直接启停，或展开参数设置。 */
export default function Strategies({ cards, monitor }: Props) {
  const [editing, setEditing] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  function toggle(card: StrategyCard) {
    setMessage("");
    if (card.id !== "spike-monitor") return;
    const rule = monitor.data?.configured ? monitor.data.rule : null;
    if (!rule) {
      setEditing(card.id);
      setMessage("异动监控策略还没有保存过规则，请先在下面设置参数并保存，再启用。");
      return;
    }
    const next = !rule.enabled;
    if (!window.confirm(next
      ? "确定启用异动监控策略？启用后将按当前规则在后台监控行情，关闭网页后仍会继续。"
      : "确定关闭异动监控策略？价格监控和待核验告警会停止。")) return;
    void monitor.save({ ...rule, enabled: next });
  }

  return (
    <>
      {(message || monitor.error) && <p className={`${styles.notice} ${monitor.error ? styles.noticeBad : ""}`} role="status">{monitor.error || message}</p>}
      <div className={styles.strategyGrid}>
        {cards.map((card) => (
          <section key={card.id} className={`${styles.card} ${styles.strategyCard}`} aria-label={card.name}>
            <div className={styles.strategyHead}>
              <h3 className={styles.cardTitle}>{card.name}</h3>
              <span className={styles.badge}>{STRATEGY_KIND_LABELS[card.kind]}</span>
              {card.toggleable && <button type="button" role="switch" aria-checked={card.running === true}
                aria-label={`${card.running ? "停止" : "启用"}${card.name}`} disabled={monitor.saving}
                className={`${styles.switch} ${card.running ? styles.switchOn : ""}`} onClick={() => toggle(card)}>
                <span className={styles.switchKnob} />
              </button>}
            </div>
            <p className={`${styles.strategyStatus} ${card.warning ? styles.down : card.running ? styles.up : ""}`}>
              {monitor.saving && card.id === "spike-monitor" ? "正在保存…" : card.status}
            </p>
            <dl className={styles.strategyStats}>
              {card.stats.map((stat) => <div key={stat.label}><dt>{stat.label}</dt><dd>{stat.value}</dd></div>)}
            </dl>
            {card.details.length > 0 && <div className={styles.strategyActions}>
              <button type="button" className={styles.button} onClick={() => setEditing(editing === card.id ? null : card.id)}>
                {editing === card.id ? "收起参数" : "参数设置"}</button>
            </div>}
          </section>
        ))}
      </div>
      {editing === "spike-monitor" && <MarketMonitor section="strategy" contracts={undefined} coinCount={null} directoryError={false} />}
      <p className={styles.hint}>停止策略只是不再告警（或不再开新仓），已有仓位继续由止损止盈和最长持仓时间管理；需要马上平掉全部仓位，请用总览页的「一键全平」。</p>
    </>
  );
}

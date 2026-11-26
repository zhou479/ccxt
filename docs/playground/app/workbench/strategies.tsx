"use client";

import { useState } from "react";
import type { BackgroundMonitorStatus, BackgroundRule } from "@/lib/background-monitor-types";
import { STRATEGY_KIND_LABELS, type StrategyCard } from "@/lib/strategy-list";
import MarketMonitor from "../markets/market-monitor";
import SignalStats from "../markets/signal-stats";
import styles from "./workbench.module.css";

type Props = {
  cards: StrategyCard[];
  monitor: { data: BackgroundMonitorStatus | null; saving: boolean; error: string; save: (rule: BackgroundRule) => Promise<void> };
  blocked: string | null;
  onOpenSettings: () => void;
};

/** 某个策略详情里的一个分类。新增策略时在这里加上它自己的参数、记录和检验结果。 */
function StrategyDetail({ strategy, section }: { strategy: string; section: string }) {
  if (strategy === "spike-monitor") {
    if (section === "settings") return <MarketMonitor section="strategy" contracts={undefined} coinCount={null} directoryError={false} />;
    if (section === "records") return <MarketMonitor section="records" contracts={undefined} coinCount={null} directoryError={false} />;
    if (section === "signals") return <SignalStats />;
  }
  return null;
}

/** 策略页：每个策略一张卡片，显示类型、状态、检验结论和今日数据；可以直接启停，或打开详情查看参数、记录和检验结果。 */
export default function Strategies({ cards, monitor, blocked, onOpenSettings }: Props) {
  const [open, setOpen] = useState<{ strategy: string; section: string } | null>(null);
  const [message, setMessage] = useState("");
  const opened = cards.find((card) => card.id === open?.strategy);

  function show(card: StrategyCard, section = card.details[0]?.id) {
    setOpen(section ? { strategy: card.id, section } : null);
  }

  function toggle(card: StrategyCard) {
    setMessage("");
    if (card.id !== "spike-monitor") return;
    const rule = monitor.data?.configured ? monitor.data.rule : null;
    if (!rule) {
      show(card, "settings");
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
      {blocked && <p className={`${styles.notice} ${styles.noticeBad}`}>交易保护：{blocked} 自动交易策略暂时不能开新仓。</p>}
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
            {card.verdict && <p className={`${styles.verdict} ${card.verdict.passed ? styles.verdictPassed : ""}`}>{card.verdict.text}</p>}
            <div className={styles.strategyActions}>
              {card.details.length > 0 && <button type="button" className={styles.button}
                onClick={() => (open?.strategy === card.id ? setOpen(null) : show(card))}>{open?.strategy === card.id ? "收起详情" : "查看详情"}</button>}
              {card.kind === "manual" && <button type="button" className={styles.button} onClick={onOpenSettings}>去下单</button>}
            </div>
          </section>
        ))}
      </div>
      {opened && open && <section className={styles.detail} aria-label={`${opened.name}详情`}>
        <div className={styles.detailHead}>
          <h3 className={styles.cardTitle}>{opened.name}</h3>
          <div className={styles.subTabs} role="group" aria-label={`${opened.name}详情分类`}>
            {opened.details.map(({ id, label }) => (
              <button key={id} type="button" aria-pressed={open.section === id}
                className={`${styles.subTab} ${open.section === id ? styles.subTabActive : ""}`}
                onClick={() => setOpen({ strategy: opened.id, section: id })}>{label}</button>
            ))}
          </div>
        </div>
        <StrategyDetail strategy={opened.id} section={open.section} />
      </section>}
      <p className={styles.hint}>
        停止策略只是不再开新仓或不再告警，已有仓位继续由止损止盈和最长持仓时间管理；需要马上平掉全部仓位，请用总览页的「一键全平」。
        以后新增的自动交易策略（例如资金费率、网格）通过历史检验后会出现在这里。
      </p>
    </>
  );
}

"use client";

import { useState } from "react";
import { tradingModeLabels, type TradingStatus } from "@/lib/trading-types";
import styles from "./markets.module.css";

type Props = {
  status: TradingStatus | null;
  onCloseAll: (accountRevision: string) => Promise<{ closed: number; failed: { symbol: string; error: string }[] }>;
  onResume: (accountRevision: string) => Promise<unknown>;
};

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", timeStyle: "medium" });
const formatAmount = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 2 });

/** 交易保护：每日亏损上限、一键全平 / 恢复开仓、对账结果。 */
export default function TradingGuard({ status, onCloseAll, onResume }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  if (!status?.enabled || !status.guard) return null;
  const { guard, limits } = status;
  const active = status.trades.filter((trade) => ["opening", "open", "closing"].includes(trade.status)).length;
  const reconciliation = guard.reconciliation;
  const lossShare = limits.dailyLossLimit > 0 ? Math.min(1, guard.dailyLoss / limits.dailyLossLimit) : 0;

  async function act(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ kind: "ok", text: await work() });
    } catch (caught) {
      setMessage({ kind: "error", text: caught instanceof Error ? caught.message : "操作失败。" });
    } finally {
      setBusy(false);
    }
  }

  function closeAll() {
    if (!status) return;
    const warning = `${status.mode === "live" ? "⚠️ 实盘，真实资金！\n\n" : ""}确认一键全平【${tradingModeLabels[status.mode]}】？\n\n` +
      `会撤掉止损止盈单，市价平掉 ${active} 笔策略交易，并暂停所有策略开新仓，直到你点「恢复开仓」。\n` +
      "不是策略开的持仓（手动下的单）不会动，对账结果里会列出来。";
    if (!window.confirm(warning)) return;
    void act(async () => {
      const result = await onCloseAll(status.accountRevision);
      return result.failed.length
        ? `已平仓 ${result.closed} 笔，${result.failed.length} 笔失败：${result.failed.map((item) => `${item.symbol}（${item.error}）`).join("；")}。请到币安核对。`
        : `已平仓 ${result.closed} 笔，已暂停开新仓。`;
    });
  }

  function resume() {
    if (!status || !window.confirm("确认恢复开仓？之后策略可以重新开新仓。")) return;
    void act(async () => {
      await onResume(status.accountRevision);
      return "已恢复开仓。";
    });
  }

  return (
    <details className={styles.monitorFeature} open={Boolean(guard.blocked) || reconciliation?.ok === false}>
      <summary className={styles.monitorSummary}>
        <h3>交易保护 <small>{guard.blocked ? "已暂停开新仓" : reconciliation?.ok === false ? "对账有问题" : "正常"}</small></h3>
      </summary>
      <div className={styles.monitorBody}>
        <section className={`${styles.result} ${styles.monitorSettings}`} aria-label="交易保护">
          <div className={styles.monitorHeading}>
            <span>今日（北京时间）已实现亏损 {formatAmount.format(guard.dailyLoss)} / {limits.dailyLossLimit} USDT
              （{Math.round(lossShare * 100)}%）</span>
            <span>进行中 {active} 笔</span>
            <span>{limits.isolatedMargin ? "逐仓" : "全仓"}</span>
            <span>{limits.symbolCooldownMinutes > 0 ? `同一个币平仓后冷却 ${limits.symbolCooldownMinutes} 分钟` : "不冷却"}</span>
          </div>
          {guard.blocked
            ? <p role="alert">{guard.blocked}</p>
            : <p role="status">可以开新仓。亏损达到每日上限、点了一键全平、或对账发现止损单缺失时，会自动暂停所有策略开新仓。</p>}
          <div className={styles.monitorForm}>
            <button type="button" onClick={closeAll} disabled={busy}>一键全平</button>
            {guard.pause && <button type="button" onClick={resume} disabled={busy}>恢复开仓</button>}
          </div>
          {message && <p role={message.kind === "error" ? "alert" : "status"}>{message.text}</p>}
          <h4>对账 <span>每分钟核对一次本地记录和币安的持仓、挂单、条件单</span></h4>
          {!reconciliation && <p role="status">等待第一次对账…</p>}
          {reconciliation?.error && <p role="alert">{reconciliation.error}（{formatTime.format(reconciliation.time)}）</p>}
          {reconciliation && !reconciliation.error && reconciliation.ok &&
            <p role="status">一致（{formatTime.format(reconciliation.time)}）。</p>}
          {reconciliation && reconciliation.issues.length > 0 && <ul>
            {reconciliation.issues.map((issue) => <li key={`${issue.kind}:${issue.symbol}:${issue.positionSide}`}
              className={issue.level === "critical" ? styles.sell : undefined}>
              {issue.level === "critical" ? "严重：" : "提醒："}{issue.message}
            </li>)}
          </ul>}
          <p>每日亏损上限用环境变量 PLAYGROUND_DAILY_LOSS_LIMIT 设置（默认模拟盘 100、实盘 10 USDT），
            按当天平仓交易的实际成交和估算手续费计算。开仓前默认切换为逐仓（PLAYGROUND_MARGIN_MODE=cross 可关闭），
            同一个币平仓后默认冷却 30 分钟（PLAYGROUND_SYMBOL_COOLDOWN_MINUTES，0 表示不冷却）。
            开仓、平仓、失败和新出现的对账问题会发到钉钉（需要在「消息通知」配置）。</p>
        </section>
      </div>
    </details>
  );
}

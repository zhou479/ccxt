"use client";

import { useState } from "react";
import { isTradeActive, tradeExecution, type TradingOverview, type TradingStatus } from "@/lib/trading-types";
import PnlChart from "./pnl-chart";
import styles from "./workbench.module.css";

type Props = {
  status: TradingStatus | null;
  overview: TradingOverview | null;
  error: string;
  onCloseAll: (accountRevision: string) => Promise<{ closed: number; failed: { symbol: string; error: string }[] }>;
  onResume: (accountRevision: string) => Promise<unknown>;
  strategies: { running: number; text: string };
  onOpenSettings: () => void;
  onOpenStrategies: () => void;
};

const amount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const signed = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });
const price = new Intl.NumberFormat("zh-CN", { maximumSignificantDigits: 6 });
const clock = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", timeStyle: "short" });
const dateTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });

function tone(value: number | null | undefined) {
  return value === null || value === undefined || value === 0 ? "" : value > 0 ? styles.up : styles.down;
}

function held(since: number | null) {
  if (!since) return "—";
  const minutes = Math.max(0, Math.round((Date.now() - since) / 60_000));
  return minutes < 60 ? `${minutes} 分钟` : minutes < 1_440 ? `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分` : `${Math.floor(minutes / 1_440)} 天`;
}

function Metric({ label, value, note, className = "" }: { label: string; value: string; note?: string; className?: string }) {
  return (
    <div className={styles.metric}>
      <div className={styles.metricLabel}>{label}</div>
      <div className={`${styles.metricValue} ${className}`}>{value}</div>
      {note && <div className={styles.metricNote}>{note}</div>}
    </div>
  );
}

/** 总览：运行状态、资金、今日盈亏、盈亏曲线、当前持仓和最近成交。 */
export default function Overview({ status, overview, error, onCloseAll, onResume, strategies, onOpenSettings, onOpenStrategies }: Props) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ bad: boolean; text: string } | null>(null);
  const guard = status?.guard;
  const funds = overview?.account && "equity" in overview.account ? overview.account : null;
  const fundsError = overview?.account && "error" in overview.account ? overview.account.error : null;
  const positions = overview?.positions ?? [];
  const unrealized = positions.reduce((sum, position) => sum + (position.unrealized ?? 0), 0);
  const pnl = overview?.pnl;
  const limit = status?.limits.dailyLossLimit ?? 0;
  const loss = guard?.dailyLoss ?? 0;
  const lossShare = limit > 0 ? Math.min(1, loss / limit) : 0;
  const reconciliation = guard?.reconciliation;
  const recent = (status?.trades ?? []).filter((trade) => !isTradeActive(trade)).slice(0, 8);

  async function act(work: () => Promise<string>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage({ bad: false, text: await work() });
    } catch (caught) {
      setMessage({ bad: true, text: caught instanceof Error ? caught.message : "操作失败。" });
    } finally {
      setBusy(false);
    }
  }

  function closeAll() {
    if (!status) return;
    const strategyPositions = positions.filter((position) => position.tradeId).length;
    if (!window.confirm(`${status.mode === "live" ? "实盘，真实资金！\n\n" : ""}确认一键全平？\n\n` +
      `会撤掉止损止盈单、市价平掉 ${strategyPositions} 笔策略持仓，并暂停所有策略开新仓，直到你点「恢复开仓」。\n` +
      "手动下的单不会动。")) return;
    void act(async () => {
      const result = await onCloseAll(status.accountRevision);
      return result.failed.length
        ? `已平仓 ${result.closed} 笔，${result.failed.length} 笔失败，请到币安核对。`
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

  if (status && !status.enabled) {
    return (
      <div className={styles.section}>
        <p className={styles.notice}>{status.problem ? `下单未开启：${status.problem}` : "还没有连接币安账号。"}</p>
        <div><button type="button" className={styles.button} onClick={onOpenSettings}>去设置里连接账号</button></div>
        {pnl && pnl.curve.length > 0 && <PnlChart curve={pnl.curve} />}
      </div>
    );
  }

  const guardState = guard?.blocked ? { dot: styles.dotBad, text: guard.pause ? "已暂停开新仓" : "暂停开新仓" } : { dot: styles.dotOk, text: "交易保护正常" };
  const reconcileState = !reconciliation ? { dot: "", text: "等待对账" }
    : reconciliation.error ? { dot: styles.dotWarn, text: "对账失败" }
    : reconciliation.ok ? { dot: styles.dotOk, text: `对账一致 ${clock.format(reconciliation.time)}` }
    : { dot: styles.dotBad, text: `对账发现 ${reconciliation.issues.length} 个问题` };

  return (
    <>
      <div className={styles.statusBar}>
        <button type="button" className={`${styles.statusItem} ${styles.statusLink}`} onClick={onOpenStrategies}>
          <span className={`${styles.dot} ${strategies.running ? styles.dotOk : ""}`} />{strategies.text}</button>
        <span className={styles.statusItem}><span className={`${styles.dot} ${guardState.dot}`} />{guardState.text}</span>
        <span className={styles.statusItem}><span className={`${styles.dot} ${reconcileState.dot}`} />{reconcileState.text}</span>
        <div className={styles.actions}>
          {guard?.pause && <button type="button" className={styles.button} onClick={resume} disabled={busy}>恢复开仓</button>}
          <button type="button" className={`${styles.button} ${styles.buttonDanger}`} onClick={closeAll} disabled={busy || !status}>一键全平</button>
        </div>
      </div>
      {guard?.blocked && <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">{guard.blocked}</p>}
      {reconciliation && reconciliation.issues.length > 0 && <p className={`${styles.notice} ${styles.noticeBad}`}>
        {reconciliation.issues.map((issue) => `${issue.level === "critical" ? "严重：" : "提醒："}${issue.message}`).join(" ")}
      </p>}
      {message && <p className={`${styles.notice} ${message.bad ? styles.noticeBad : ""}`} role="status">{message.text}</p>}
      {(error || fundsError) && <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">{error || `资金读取失败：${fundsError}`}</p>}

      <div className={styles.metrics}>
        <Metric label="账户权益（USDT）" value={funds ? amount.format(funds.equity) : "—"}
          note={funds ? `钱包余额 ${amount.format(funds.wallet)}` : undefined} />
        <Metric label="可用余额" value={funds?.available != null ? amount.format(funds.available) : "—"}
          note={funds?.available != null ? `占用 ${amount.format(Math.max(0, funds.equity - funds.available))}` : undefined} />
        <Metric label="今日盈亏" value={pnl ? signed.format(pnl.today) : "—"} className={tone(pnl?.today)}
          note={pnl ? `累计 ${signed.format(pnl.total)} · 胜率 ${pnl.trades ? Math.round((pnl.wins / pnl.trades) * 100) : 0}%（${pnl.trades} 笔）` : "已实现，含手续费"} />
        <Metric label="持仓浮动盈亏" value={overview ? signed.format(unrealized) : "—"} className={tone(unrealized)}
          note={`${positions.length} 笔持仓`} />
      </div>

      <div className={styles.progress}>
        <div className={styles.progressRow}>
          <span>今日亏损额度（北京时间）</span>
          <span>已用 {amount.format(loss)} / {limit} USDT</span>
        </div>
        <div className={styles.progressTrack}>
          <div className={`${styles.progressFill} ${lossShare >= 1 ? styles.progressBad : lossShare >= 0.6 ? styles.progressWarn : ""}`}
            style={{ width: `${Math.max(lossShare * 100, loss > 0 ? 2 : 0)}%` }} />
        </div>
      </div>

      <PnlChart curve={pnl?.curve ?? []} />

      <div className={styles.columns}>
        <section className={styles.card} aria-label="当前持仓">
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>当前持仓</h3>
            <span className={styles.cardMeta}>{positions.length} 笔</span>
          </div>
          {positions.length === 0 ? <div className={styles.empty}>没有持仓</div> : <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr>
                <th>合约</th><th>方向</th><th className={styles.numeric}>金额</th><th className={styles.numeric}>开仓 / 标记价</th>
                <th className={styles.numeric}>止损 / 止盈</th><th className={styles.numeric}>浮动盈亏</th><th>已持仓</th>
              </tr></thead>
              <tbody>
                {positions.map((position) => <tr key={`${position.symbol}:${position.side}`}>
                  <td><span className={styles.symbol}>{position.symbol}</span>
                    <span className={styles.sub}>{position.strategy ?? "手动下单"} · {position.isolated ? "逐仓" : "全仓"}</span></td>
                  <td className={position.side === "long" ? styles.up : styles.down}>{position.side === "long" ? "做多" : "做空"}</td>
                  <td className={styles.numeric}>{position.notional != null ? amount.format(position.notional) : "—"}</td>
                  <td className={styles.numeric}>{position.entryPrice ? price.format(position.entryPrice) : "—"}
                    <span className={styles.sub}>{position.markPrice ? price.format(position.markPrice) : "—"}</span></td>
                  <td className={styles.numeric}>{position.stopLoss ? price.format(position.stopLoss) : "—"}
                    <span className={styles.sub}>{position.takeProfit ? price.format(position.takeProfit) : "—"}</span></td>
                  <td className={`${styles.numeric} ${tone(position.unrealized)}`}>{position.unrealized != null ? signed.format(position.unrealized) : "—"}</td>
                  <td>{held(position.openedAt)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>}
        </section>

        <section className={styles.card} aria-label="最近成交">
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>最近成交</h3>
            <button type="button" className={`${styles.link} ${styles.segment}`} style={{ marginLeft: "auto" }} onClick={onOpenSettings}>全部记录</button>
          </div>
          {recent.length === 0 ? <div className={styles.empty}>还没有已结束的交易</div> : <ul className={styles.trades}>
            {recent.map((trade) => {
              const { netPnl } = tradeExecution(trade);
              return <li key={trade.id}>
                <span><span className={styles.symbol}>{trade.symbol}</span>{" "}
                  <span className={trade.side === "long" ? styles.up : styles.down}>{trade.side === "long" ? "做多" : "做空"}</span>
                  <span className={styles.sub}>{trade.status === "failed" ? `失败：${trade.error ?? ""}` : trade.exitReason ?? "已平仓"}</span></span>
                <span className={styles.tradeTime}>{trade.closedAt ? dateTime.format(trade.closedAt) : ""}</span>
                <span className={`${styles.tradePnl} ${tone(netPnl)}`}>{netPnl === null ? "待核实" : signed.format(netPnl)}</span>
              </li>;
            })}
          </ul>}
        </section>
      </div>
    </>
  );
}

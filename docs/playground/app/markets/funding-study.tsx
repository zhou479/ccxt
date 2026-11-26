"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  HYPOTHESES, PRIMARY_PLAN, REGIMES, REGIME_LABELS, STUDY_GROUPS, STUDY_MIN_EDGE, STUDY_MIN_EVENTS, STUDY_MIN_PROFIT_FACTOR,
  STUDY_REGIME_FLOOR, STUDY_TRIMMED, planLabel, prepareStudy, studyGroupStats, studyStats, studyTrades, type StudyStats,
} from "@/lib/study-stats";
import type { DatasetSnapshot, Regime, StudyJob } from "@/lib/study-types";
import { useStudy } from "./use-study";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });
const formatDay = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short" });

function pct(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function share(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function tone(value: number | null | undefined) {
  return value === null || value === undefined || value === 0 ? undefined : value > 0 ? styles.buy : styles.sell;
}

function datasetStatus({ job, summary }: DatasetSnapshot) {
  const stored = summary
    ? `本地已有 ${summary.contracts ?? 0} 个合约（${summary.delistedContracts ?? 0} 个已下架）、` +
      `${(summary.hourBars ?? 0).toLocaleString("zh-CN")} 根小时K线、${(summary.fundingPoints ?? 0).toLocaleString("zh-CN")} 次资金费结算。`
    : "";
  const progress = `${job.done ?? 0}/${job.total ?? 0} 个合约`;
  const failed = job.failedCount ? `，${job.failedCount} 个下载失败` : "";
  switch (job.status) {
    case "running": return `下载中：${progress}${failed}。${stored}`;
    case "done": return `最近一次下载完成于 ${job.finishedAt ? formatTime.format(job.finishedAt) : "—"}（最近 ${job.days} 天，${progress}${failed}）。${stored}`;
    case "failed": return `下载失败：${job.error ?? "未知原因"}（已完成 ${progress}）。${stored}`;
    case "interrupted": return `下载中断：${job.error ?? ""}已下载的部分保存在本地，重新下载会接着补。${stored}`;
    default: return stored || "还没有下载研究数据。";
  }
}

function regimeDays(regimes: DatasetSnapshot["regimes"], from?: number) {
  const days: Record<Regime, number> = { bull: 0, bear: 0, range: 0 };
  for (const segment of regimes) {
    const start = Math.max(segment.start, from ?? segment.start);
    if (segment.end > start) days[segment.regime] += Math.round((segment.end - start) / 86_400_000);
  }
  return days;
}

function studyStatus(job: StudyJob) {
  switch (job.status) {
    case "running": return "检验中，通常需要几十秒…";
    case "done": return `检验完成于 ${job.finishedAt ? formatTime.format(job.finishedAt) : "—"}。`;
    case "failed": return `检验失败：${job.error ?? "未知原因"}`;
    default: return "还没有检验过。";
  }
}

function Verdict({ stats }: { stats: StudyStats }) {
  if (stats.count === 0) return <td>—</td>;
  return stats.credible
    ? <td><small className={styles.signalCredible}>通过</small></td>
    : <td><small title={stats.failures.join("；")}>未通过：{stats.failures[0]}{stats.failures.length > 1 ? ` 等 ${stats.failures.length} 项` : ""}</small></td>;
}

function StatsCells({ stats }: { stats: StudyStats }) {
  return <>
    <td>{stats.count} / {stats.events}</td>
    <td>{share(stats.winRate)}</td>
    <td className={tone(stats.average)}>{pct(stats.average, 3)}</td>
    <td><span className={tone(stats.price)}>{pct(stats.price)}</span> / <span className={tone(stats.funding)}>{pct(stats.funding, 3)}</span> / {pct(stats.cost === null ? null : -stats.cost)}</td>
    <td>{stats.hours === null ? "—" : `${stats.hours.toFixed(1)} 小时`}</td>
    <td><span className={tone(stats.halves[0])}>{pct(stats.halves[0])}</span> / <span className={tone(stats.halves[1])}>{pct(stats.halves[1])}</span></td>
    <td>{REGIMES.map((regime, index) => <span key={regime}>{index > 0 && " / "}<span className={tone(stats.regimes[regime].average)}
      title={`${REGIME_LABELS[regime]} ${stats.regimes[regime].count} 笔`}>{pct(stats.regimes[regime].average)}</span></span>)}</td>
    <td>{stats.profitFactor === null ? "—" : stats.profitFactor.toFixed(2)}</td>
    <td className={tone(stats.trimmed)}>{pct(stats.trimmed, 3)}</td>
    <td>{pct(-stats.maxDrawdown, 1)} / <span className={tone(stats.total)}>{pct(stats.total, 1)}</span></td>
  </>;
}

const statsHeader = <>
  <th scope="col">样本 / 事件</th><th scope="col">胜率</th><th scope="col">每笔平均（净）</th>
  <th scope="col">价格 / 资金费 / 成本</th><th scope="col">平均持仓</th><th scope="col">前半段 / 后半段</th>
  <th scope="col">牛市 / 熊市 / 震荡</th><th scope="col">总盈利 ÷ 总亏损</th><th scope="col">去掉最赚 {STUDY_TRIMMED} 笔</th>
  <th scope="col">最大回撤 / 累计</th>
</>;

export default function FundingStudy() {
  const { mode, dataset, study, error, prepare, run } = useStudy();
  const [datasetDays, setDatasetDays] = useState("730");
  const [form, setForm] = useState({ days: "730", top: "100" });
  const [plan, setPlan] = useState(PRIMARY_PLAN);
  const [hypothesisId, setHypothesisId] = useState("F1");
  const [groupId, setGroupId] = useState("regime");
  const [message, setMessage] = useState("");

  const result = study?.result;
  const samples = useMemo(() => prepareStudy(result?.samples ?? []), [result]);
  const plans = result?.plans ?? [];
  const hypothesis = HYPOTHESES.find(({ id }) => id === hypothesisId) ?? HYPOTHESES[0];
  const rows = useMemo(() => HYPOTHESES.map((one) => ({ hypothesis: one, stats: studyStats(studyTrades(samples, one, plan)) })),
    [samples, plan]);
  const planRows = useMemo(() => plans.map((_, index) => studyStats(studyTrades(samples, hypothesis, index))), [samples, plans, hypothesis]);
  const groups = useMemo(() => studyGroupStats(samples, hypothesis, plan, groupId), [samples, hypothesis, plan, groupId]);
  const events = useMemo(() => new Set(samples.map(({ event }) => event)).size, [samples]);
  const split = samples.find(({ half }) => half === 1)?.time;
  const downloading = dataset?.job.status === "running";
  const studying = study?.status === "running";
  const covered = dataset ? regimeDays(dataset.regimes, result?.from) : null;

  async function download(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const days = Math.trunc(Number(datasetDays));
    if (!window.confirm(`下载最近 ${days} 天的研究数据？包括所有加密永续合约（含已下架）的小时K线和资金费率。` +
      "第一次大约需要 1–2 小时，之后只补缺的部分。下载期间页面行情不受影响。")) return;
    setMessage("");
    try {
      await prepare(days);
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "无法开始下载研究数据。");
    }
  }

  async function start(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    try {
      await run(Math.trunc(Number(form.days)), Math.trunc(Number(form.top)));
    } catch (caught) {
      setMessage(caught instanceof Error ? caught.message : "无法开始策略检验。");
    }
  }

  return (
    <details className={styles.monitorFeature}>
      <summary className={styles.monitorSummary}>
        <h3>中低频策略检验 <small>{result ? `资金费率 · ${samples.length} 个信号` : mode === "unavailable" ? "仅本机可用" : "资金费率"}</small></h3>
      </summary>
      <div className={`${styles.monitorBody} ${styles.turnover} ${styles.signalStats}`}>
        <p>检验持仓几小时到几天的策略。当前检验「资金费率极端值」：某个合约的资金费率从常态变成极端时，
          看做多或做空、按不同方式出场，扣除成本并计入持仓期间的资金费后能不能赚钱。</p>
        {mode === "unavailable" && <p role="status">请在运行 Playground 的电脑上打开本机行情页查看。</p>}
        {error && <p role="alert">{error}</p>}
        {mode === "local" && <>
          <h4>研究数据</h4>
          <form className={styles.monitorForm} onSubmit={download}>
            <label htmlFor="dataset-days">最近</label>
            <input id="dataset-days" type="number" min={30} max={1095} required value={datasetDays} disabled={downloading}
              onChange={(event) => setDatasetDays(event.target.value)} />天
            <button type="submit" disabled={downloading}>{downloading ? "下载中…" : "下载 / 更新研究数据"}</button>
          </form>
          {dataset && <p role="status">{datasetStatus(dataset)}</p>}
          {dataset?.job.archiveError && <p role="alert">{dataset.job.archiveError}</p>}
          {covered && dataset && dataset.regimes.length > 0 && <p>
            行情阶段（按 BTC 日收盘价与 200 日均线，次日生效）：牛市 {covered.bull} 天、熊市 {covered.bear} 天、震荡 {covered.range} 天
            {result ? "（检验区间内）" : ""}。
          </p>}

          <h4>资金费率检验</h4>
          <form className={styles.monitorForm} onSubmit={start}>
            <label htmlFor="study-days">最近</label>
            <input id="study-days" type="number" min={30} max={1095} required value={form.days} disabled={studying}
              onChange={(event) => setForm({ ...form, days: event.target.value })} />天，
            <label htmlFor="study-top">每次结算时流动性前</label>
            <input id="study-top" type="number" min={10} max={300} required value={form.top} disabled={studying}
              onChange={(event) => setForm({ ...form, top: event.target.value })} />名
            <button type="submit" disabled={studying || downloading}>{studying ? "检验中…" : "开始检验"}</button>
          </form>
          {study && <p role="status">{studyStatus(study)}</p>}
          {message && <p role="alert">{message}</p>}
          {result && <p role="status">
            {formatDay.format(result.from)} 至 {formatDay.format(result.to)}：{samples.length} 个信号，来自 {events} 轮结算
            （前后 1 小时内的算同一轮）{split ? `；前后两段以 ${formatTime.format(split)} 为界` : ""}
            {result.unfinished ? `；${result.unfinished} 个信号持仓期还没结束，未计入` : ""}。
          </p>}

          <div className={styles.monitorForm}>
            <label htmlFor="study-plan">出场方式</label>
            <select id="study-plan" className={styles.tradingSelect} value={plan} onChange={(event) => setPlan(Number(event.target.value))}>
              {plans.map((one, index) => <option key={index} value={index}>{planLabel(one)}{index === PRIMARY_PLAN ? "（主判据）" : ""}</option>)}
            </select>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr><th scope="col">假设</th>{statsHeader}<th scope="col">结论</th></tr></thead>
              <tbody>
                {samples.length === 0 && <tr><td colSpan={12} className={styles.emptyTableCell}>
                  <span role="status">暂无结果，请先下载研究数据并开始检验。</span></td></tr>}
                {samples.length > 0 && rows.map(({ hypothesis: one, stats }) => <tr key={one.id}>
                  <th scope="row" title={one.expectation}>{one.label}</th>
                  <StatsCells stats={stats} />
                  <Verdict stats={stats} />
                </tr>)}
              </tbody>
            </table>
          </div>

          <h4>出场方式对比与分组</h4>
          <div className={styles.monitorForm}>
            <label htmlFor="study-hypothesis">假设</label>
            <select id="study-hypothesis" className={styles.tradingSelect} value={hypothesisId}
              onChange={(event) => setHypothesisId(event.target.value)}>
              {HYPOTHESES.map((one) => <option key={one.id} value={one.id}>{one.label}</option>)}
            </select>
            <label htmlFor="study-group">分组</label>
            <select id="study-group" className={styles.tradingSelect} value={groupId} onChange={(event) => setGroupId(event.target.value)}>
              {STUDY_GROUPS.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr><th scope="col">出场方式</th>{statsHeader}<th scope="col">止损 / 到期 / 恢复 / 下架</th></tr></thead>
              <tbody>
                {samples.length > 0 && planRows.map((stats, index) => <tr key={index}>
                  <th scope="row">{planLabel(plans[index])}</th>
                  <StatsCells stats={stats} />
                  <td>{stats.exits.stop} / {stats.exits.time} / {stats.exits.normal} / {stats.exits.delisted}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr><th scope="col">分组</th>{statsHeader}</tr></thead>
              <tbody>
                {groups.map(({ bucket, stats }) => <tr key={bucket}>
                  <th scope="row">{bucket}</th>
                  <StatsCells stats={stats} />
                </tr>)}
              </tbody>
            </table>
          </div>

          <details className={styles.turnover}>
            <summary className={styles.monitorSectionSummary}><h4>最近信号 <span>最多 100 条</span></h4></summary>
            <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
              <table className={styles.alertTable}>
                <thead><tr>
                  <th scope="col">结算时间</th><th scope="col">交易对</th><th scope="col">费率（8 小时口径）</th><th scope="col">结算间隔</th>
                  <th scope="col">前 24 小时</th><th scope="col">同时拥挤</th><th scope="col">流动性排名</th><th scope="col">行情</th>
                  <th scope="col">做多 / 做空（{plans[plan] ? planLabel(plans[plan]) : "—"}，未扣成本）</th>
                </tr></thead>
                <tbody>
                  {samples.slice(-100).reverse().map((sample) => {
                    const outcome = sample.plans[plan];
                    const total = (side: "long" | "short") => {
                      const one = outcome?.[side];
                      return one ? one.price + one.funding : null;
                    };
                    return <tr key={sample.id}>
                      <td><time dateTime={new Date(sample.time).toISOString()}>{formatTime.format(sample.time)}</time></td>
                      <th scope="row">{sample.symbol}{sample.delisted ? "（已下架）" : ""}</th>
                      <td className={tone(sample.features.rate8h)}>{pct(sample.features.rate8h, 3)}</td>
                      <td>{sample.features.intervalHours} 小时</td>
                      <td className={tone(sample.features.ret24h)}>{pct(sample.features.ret24h)}</td>
                      <td>{sample.features.concurrent} 个</td>
                      <td>{sample.features.rank}</td>
                      <td>{sample.features.regime ? REGIME_LABELS[sample.features.regime] : "—"}</td>
                      <td><span className={tone(total("long"))}>{pct(total("long"))}</span> / <span className={tone(total("short"))}>{pct(total("short"))}</span></td>
                    </tr>;
                  })}
                </tbody>
              </table>
            </div>
          </details>

          <p>
            说明：信号是某个合约的资金费率（换算成每 8 小时口径）从常态进入 ≤ −0.1% 或 ≥ +0.1%，同一合约 72 小时内只取一次；
            只看每次结算时按前 7 天成交额排名的流动性前 {result?.params.top ?? 100} 名，且前 24 小时成交额不低于 2000 万。
            结算后的下一根小时K线开盘进场；「费率恢复正常」指回到 −0.01% 到 +0.01% 之间，同样在下一根小时K线开盘平仓。
            盈亏 = 价格盈亏 + 持仓期间的资金费 − 交易成本（按当时 24 小时成交额分档：≥5 亿 0.14%，1–5 亿 0.2%，2000 万–1 亿 0.3%，更低 0.5%）。
            正好在开仓或平仓那一刻结算的资金费只在对我们不利时计入；小时K线内同时碰到止损和止盈按止损计；持仓期间合约下架按最后成交价平仓。
            合约全集包含已下架合约，避免只看「活下来的币」。
            「通过」需要同时满足：独立事件 ≥ {STUDY_MIN_EVENTS}、每笔平均 ≥ +{STUDY_MIN_EDGE}%、前后两段都赚、
            总盈利 ÷ 总亏损 ≥ {STUDY_MIN_PROFIT_FACTOR}、去掉最赚 {STUDY_TRIMMED} 笔仍赚、
            牛市 / 熊市 / 震荡每段每笔不低于 {STUDY_REGIME_FLOOR}%（不足 10 笔的阶段不判断）、最大回撤不超过累计收益。
            这些假设和标准在第一次检验前就定好，看到结果后不再修改。
          </p>
        </>}
      </div>
    </details>
  );
}

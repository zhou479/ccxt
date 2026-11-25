"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  COST_OPTIONS, DEFAULT_COST, MIN_SAMPLES, SIGNAL_GROUPS, barrierStats, excursionStats, filterSamples, groupStats,
  horizonStats, type SampleFilter, type TradeStats,
} from "@/lib/signal-stats";
import type { ScanParams, SignalScan, SignalSource } from "@/lib/signal-types";
import { useSignals } from "./use-signals";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });
const defaultScan = { days: "7", top: "100", percent: "3", windowMinutes: "5" };

function pct(value: number | null | undefined, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${value > 0 ? "+" : ""}${value.toFixed(digits)}%`;
}

function share(value: number | null) {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function tone(value: number | null) {
  return value === null || value === 0 ? undefined : value > 0 ? styles.buy : styles.sell;
}

function Count({ count }: { count: number }) {
  return <>{count}{count > 0 && count < MIN_SAMPLES && <small title={`少于 ${MIN_SAMPLES} 个样本，结果偶然性很大`}> 少</small>}</>;
}

function scanStatus(scan: SignalScan) {
  const progress = `${scan.done ?? 0}/${scan.total ?? 0} 个合约，${scan.samples ?? 0} 个样本`;
  switch (scan.status) {
    case "running": return `扫描中：${progress}${scan.skipped ? `，${scan.skipped} 个合约读取失败已跳过` : ""}。`;
    case "done": return `上次扫描完成于 ${scan.finishedAt ? formatTime.format(scan.finishedAt) : "—"}：${progress}。`;
    case "failed": return `扫描失败：${scan.error ?? "未知原因"}（已完成 ${progress}）。`;
    case "interrupted": return scan.error ?? "扫描中断，请重新扫描。";
    default: return "还没有扫描过。";
  }
}

export default function SignalStats() {
  const [source, setSource] = useState<SignalSource>("scan");
  const { mode, data, error, startScan } = useSignals(source);
  const [filter, setFilter] = useState<SampleFilter>({ direction: "all", minMultiple: 0, alertedOnly: true });
  const [cost, setCost] = useState(DEFAULT_COST);
  const [groupId, setGroupId] = useState("direction");
  const [barrier, setBarrier] = useState(1);
  const [scanForm, setScanForm] = useState(defaultScan);
  const [scanMessage, setScanMessage] = useState("");

  const samples = useMemo(() => filterSamples(data?.samples ?? [], { ...filter, alertedOnly: source === "live" && filter.alertedOnly }),
    [data, filter, source]);
  const barriers = data?.barriers ?? [];
  const barrierRows = useMemo(() => barrierStats(samples, barriers, cost), [samples, barriers, cost]);
  const horizons = useMemo(() => horizonStats(samples, data?.horizons ?? []), [samples, data]);
  const excursions = useMemo(() => excursionStats(samples), [samples]);
  const groups = useMemo(() => groupStats(samples, groupId, barrier, cost), [samples, groupId, barrier, cost]);
  const running = data?.scan.status === "running";

  async function scan(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const params: ScanParams = {
      days: Math.trunc(Number(scanForm.days)), top: Math.trunc(Number(scanForm.top)),
      percent: Number(scanForm.percent), windowMinutes: Math.trunc(Number(scanForm.windowMinutes)),
    };
    if (!window.confirm(`开始扫描？将读取成交额前 ${params.top} 的合约最近 ${params.days} 天的 1 分钟K线，` +
      `大约需要 ${Math.max(1, Math.round(params.top * (1.6 * params.days + 2) * 1.4 / 60))} 分钟，并替换上次的扫描结果。`)) return;
    setScanMessage("");
    try {
      await startScan(params);
    } catch (caught) {
      setScanMessage(caught instanceof Error ? caught.message : "无法开始历史扫描。");
    }
  }

  const row = (stats: TradeStats) => <>
    <td className={tone(stats.average)}>{pct(stats.average, 3)}</td>
  </>;

  return (
    <details className={styles.monitorFeature}>
      <summary className={styles.monitorSummary}>
        <h3>信号效果统计 <small>{data ? `${samples.length} 个样本` : mode === "unavailable" ? "仅本机可用" : "读取中"}</small></h3>
      </summary>
      <div className={`${styles.monitorBody} ${styles.turnover} ${styles.signalStats}`}>
        <p>统计异动出现后马上「追进去」的结果：按下面的止损止盈组合模拟每一笔，最多持仓 60 分钟，
          并和「反向操作」对比。每笔平均为正，才说明扣除成本后有优势。</p>
        {mode === "unavailable" && <p role="status">请在运行 Playground 的电脑上打开本机行情页查看。</p>}
        {error && <p role="alert">{error}</p>}
        {mode === "local" && <>
          <div className={styles.monitorForm}>
            <label htmlFor="signal-source">样本来源</label>
            <select id="signal-source" className={styles.tradingSelect} value={source}
              onChange={(event) => setSource(event.target.value as SignalSource)}>
              <option value="scan">历史扫描</option>
              <option value="live">实时告警</option>
            </select>
            <label htmlFor="signal-direction">方向</label>
            <select id="signal-direction" className={styles.tradingSelect} value={filter.direction}
              onChange={(event) => setFilter({ ...filter, direction: event.target.value as SampleFilter["direction"] })}>
              <option value="all">全部</option>
              <option value="up">上涨异动</option>
              <option value="down">下跌异动</option>
            </select>
            <label htmlFor="signal-multiple">成交额倍数</label>
            <select id="signal-multiple" className={styles.tradingSelect} value={filter.minMultiple}
              onChange={(event) => setFilter({ ...filter, minMultiple: Number(event.target.value) })}>
              <option value={0}>不限</option>
              {[2, 3, 5, 10].map((value) => <option key={value} value={value}>≥ {value} 倍</option>)}
            </select>
            <label htmlFor="signal-cost">每笔成本</label>
            <select id="signal-cost" className={styles.tradingSelect} value={cost}
              onChange={(event) => setCost(Number(event.target.value))}>
              {COST_OPTIONS.map((value) => <option key={value} value={value}>{value}%</option>)}
            </select>
            {source === "live" && <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={filter.alertedOnly}
                onChange={(event) => setFilter({ ...filter, alertedOnly: event.target.checked })} />只看已告警
            </label>}
          </div>

          {source === "scan" ? <form className={styles.monitorForm} onSubmit={scan}>
            <label htmlFor="scan-days">最近</label>
            <input id="scan-days" type="number" min={1} max={30} required value={scanForm.days} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, days: event.target.value })} />天，
            <label htmlFor="scan-top">成交额前</label>
            <input id="scan-top" type="number" min={10} max={300} required value={scanForm.top} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, top: event.target.value })} />个合约，
            <label htmlFor="scan-window">窗口</label>
            <input id="scan-window" type="number" min={1} max={15} required value={scanForm.windowMinutes} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, windowMinutes: event.target.value })} />分钟内涨跌超过
            <input id="scan-percent" aria-label="涨跌幅阈值（%）" type="number" min={1} max={50} step="0.1" required
              value={scanForm.percent} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, percent: event.target.value })} />%
            <button type="submit" disabled={running}>{running ? "扫描中…" : "开始扫描"}</button>
          </form> : <p>实时告警在发生 1 小时后自动补算结果，需要开启「异动监控策略」并保持服务运行。</p>}
          {source === "scan" && data && <p role="status">{scanStatus(data.scan)}</p>}
          {scanMessage && <p role="alert">{scanMessage}</p>}

          <h4>止损止盈模拟 <span>扣除每笔 {cost}% 成本</span></h4>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">止损 / 止盈</th><th scope="col">样本</th><th scope="col">追进去胜率</th>
                <th scope="col">追进去每笔平均</th><th scope="col">盈亏比</th><th scope="col">止盈 / 止损 / 到期</th>
                <th scope="col">反向操作每笔平均</th>
              </tr></thead>
              <tbody>
                {samples.length === 0 && <tr><td colSpan={7} className={styles.emptyTableCell}>
                  <span role="status">{source === "scan" ? "暂无样本，请先开始扫描。" : "暂无已完成的实时告警样本。"}</span></td></tr>}
                {samples.length > 0 && barrierRows.map(({ stop, take, chase, fade }) => <tr key={`${stop}-${take}`}>
                  <th scope="row">{stop}% / {take}%</th>
                  <td><Count count={chase.count} /></td>
                  <td>{share(chase.winRate)}</td>
                  {row(chase)}
                  <td>{chase.payoff === null ? "—" : chase.payoff.toFixed(2)}</td>
                  <td>{chase.takes} / {chase.stops} / {chase.times}</td>
                  {row(fade)}
                </tr>)}
              </tbody>
            </table>
          </div>

          <h4>异动之后的走势 <span>顺着异动方向，未扣成本</span></h4>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">时间</th><th scope="col">平均</th><th scope="col">中位数</th><th scope="col">继续顺向的比例</th>
              </tr></thead>
              <tbody>
                {samples.length > 0 && horizons.map((horizon) => <tr key={horizon.minutes}>
                  <th scope="row">{horizon.minutes} 分钟后</th>
                  <td className={tone(horizon.average)}>{pct(horizon.average)}</td>
                  <td className={tone(horizon.median)}>{pct(horizon.median)}</td>
                  <td>{share(horizon.continued)}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
          {samples.length > 0 && <p>60 分钟内最大浮盈的中位数 {pct(excursions.mfe)}，最大浮亏的中位数 {pct(excursions.mae)}。</p>}

          <h4>分组对比</h4>
          <div className={styles.monitorForm}>
            <label htmlFor="signal-group">按</label>
            <select id="signal-group" className={styles.tradingSelect} value={groupId}
              onChange={(event) => setGroupId(event.target.value)}>
              {SIGNAL_GROUPS.map((group) => <option key={group.id} value={group.id}>{group.label}</option>)}
            </select>
            <label htmlFor="signal-barrier">止损 / 止盈</label>
            <select id="signal-barrier" className={styles.tradingSelect} value={barrier}
              onChange={(event) => setBarrier(Number(event.target.value))}>
              {barriers.map(({ stop, take }, index) => <option key={index} value={index}>{stop}% / {take}%</option>)}
            </select>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">分组</th><th scope="col">样本</th><th scope="col">追进去胜率</th>
                <th scope="col">追进去每笔平均</th><th scope="col">反向操作每笔平均</th>
              </tr></thead>
              <tbody>
                {groups.map(({ bucket, chase, fade }) => <tr key={bucket}>
                  <th scope="row">{bucket}</th>
                  <td><Count count={chase.count} /></td>
                  <td>{share(chase.winRate)}</td>
                  {row(chase)}
                  {row(fade)}
                </tr>)}
              </tbody>
            </table>
          </div>

          <details className={styles.turnover}>
            <summary className={styles.monitorSectionSummary}><h4>最近样本 <span>最多 100 条</span></h4></summary>
            <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
              <table className={styles.alertTable}>
                <thead><tr>
                  <th scope="col">时间</th><th scope="col">交易对</th><th scope="col">涨跌幅</th><th scope="col">成交额倍数</th>
                  <th scope="col">5 分钟</th><th scope="col">15 分钟</th><th scope="col">60 分钟</th>
                  <th scope="col">最大浮盈 / 浮亏</th>
                </tr></thead>
                <tbody>
                  {samples.slice(0, 100).map((sample) => <tr key={sample.id}>
                    <td><time dateTime={new Date(sample.time).toISOString()}>{formatTime.format(sample.time)}</time></td>
                    <th scope="row">{sample.symbol}</th>
                    <td className={tone(sample.change)}>{pct(sample.change)}</td>
                    <td>{sample.turnoverMultiple === null ? "—" : `${sample.turnoverMultiple.toFixed(1)} 倍`}</td>
                    {["5", "15", "60"].map((minutes) => <td key={minutes} className={tone(sample.returns[minutes])}>
                      {pct(sample.returns[minutes])}</td>)}
                    <td>{pct(sample.mfe)} / {pct(sample.mae)}</td>
                  </tr>)}
                </tbody>
              </table>
            </div>
          </details>

          <p>
            说明：历史扫描用 1 分钟K线找出「{data?.scan.params?.windowMinutes ?? "N"} 分钟内涨跌超过阈值」的异动，在下一分钟开盘价进场，
            同一合约 30 分钟内只取一次；实时告警按告警价进场。同一分钟内同时碰到止损和止盈时按止损计，结果偏保守。
            走势表的收益方向和异动一致，正数表示继续往异动方向走。样本标「少」的分组不足 {MIN_SAMPLES} 个，偶然性很大，暂不下结论。
          </p>
        </>}
      </div>
    </details>
  );
}

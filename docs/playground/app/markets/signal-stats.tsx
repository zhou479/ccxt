"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  COST_OPTIONS, DEFAULT_COST, LIQUIDITY_OPTIONS, MIN_EDGE, MIN_EVENTS, MIN_PROFIT_FACTOR, MIN_SAMPLES, TRIMMED_TRADES, SIGNAL_GROUPS, barrierStats, excursionStats, filterSamples,
  barrierLabel, groupStats, horizonStats, marketKind, prepareSamples, type CostModel, type OutcomeStats, type SampleFilter,
} from "@/lib/signal-stats";
import type { ArchiveStatus, ScanParams, SignalScan, SignalSource } from "@/lib/signal-types";
import { useSignals } from "./use-signals";
import styles from "./markets.module.css";

const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });
const defaultScan = { days: "30", top: "100", percent: "3", windowMinutes: "5", zScore: "0" };

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

function Count({ stats }: { stats: OutcomeStats }) {
  return <>{stats.count} / {stats.events}
    {stats.count > 0 && (stats.count < MIN_SAMPLES || stats.events < MIN_EVENTS / 2) &&
      <small title={`样本少于 ${MIN_SAMPLES} 个或独立事件少于 ${MIN_EVENTS / 2} 个，结果偶然性很大`}> 少</small>}</>;
}

const marketLabels = { single: "个币", mixed: "中间", market: "全市场" } as const;

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

function archiveStatus(archive: ArchiveStatus) {
  const at = (time: number | null) => time ? `，最近 ${formatTime.format(time)}` : "";
  return `数据存档：价格和资金费率快照 ${archive.premiumSnapshots} 次${at(archive.premiumAt)}；` +
    `强平单 ${archive.liquidations} 条${at(archive.liquidationAt)}；多空比 ${archive.longShortSymbols} 个合约${at(archive.longShortAt)}；` +
    `本地缓存 ${archive.cachedBars.toLocaleString("zh-CN")} 根 1 分钟K线。`;
}

export default function SignalStats() {
  const [source, setSource] = useState<SignalSource>("scan");
  const { mode, data, error, startScan } = useSignals(source);
  const [filter, setFilter] = useState<SampleFilter>({
    direction: "all", minMultiple: 0, alertedOnly: true, market: "all", minVolume: 2e7,
  });
  const [cost, setCost] = useState<CostModel>(DEFAULT_COST);
  const [groupId, setGroupId] = useState("direction");
  const [barrier, setBarrier] = useState(1);
  const [scanForm, setScanForm] = useState(defaultScan);
  const [scanMessage, setScanMessage] = useState("");

  // Concurrency, events and halves come from the whole source, before filtering.
  const prepared = useMemo(() => prepareSamples(data?.samples ?? []), [data]);
  const samples = useMemo(() => filterSamples(prepared, { ...filter, alertedOnly: source === "live" && filter.alertedOnly }),
    [prepared, filter, source]);
  const events = useMemo(() => new Set(samples.map((sample) => sample.context.event)).size, [samples]);
  const split = useMemo(() => prepared.find((sample) => sample.context.half === 1)?.time, [prepared]);
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
      zScore: Number(scanForm.zScore),
    };
    if (!window.confirm(`开始扫描？将读取成交额前 ${params.top} 的合约最近 ${params.days} 天的 1 分钟K线，` +
      `大约需要 ${Math.max(1, Math.round(params.top * (1.6 * params.days + 2) * 1.4 / 60))} 分钟，并替换上次的扫描结果。已下载过的K线和持仓量会直接读本地缓存，重复扫描会快很多。`)) return;
    setScanMessage("");
    try {
      await startScan(params);
    } catch (caught) {
      setScanMessage(caught instanceof Error ? caught.message : "无法开始历史扫描。");
    }
  }

  const average = (stats: OutcomeStats) => <td className={tone(stats.average)}>
    {pct(stats.average, 3)}{stats.credible && <small className={styles.signalCredible}
      title={`每笔 ≥ +${MIN_EDGE}%、前后两段为正、盈亏总额比 ≥ ${MIN_PROFIT_FACTOR}、去掉最赚 ${TRIMMED_TRADES} 笔仍为正、独立事件 ≥ ${MIN_EVENTS}`}> 可信</small>}
  </td>;
  const halves = (stats: OutcomeStats) => <td>
    <span className={tone(stats.halves[0])}>{pct(stats.halves[0])}</span> / <span className={tone(stats.halves[1])}>{pct(stats.halves[1])}</span>
  </td>;

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
              onChange={(event) => setCost(event.target.value === "tiered" ? "tiered" : Number(event.target.value))}>
              {COST_OPTIONS.map((value) => <option key={value} value={value}>
                {value === "tiered" ? "按流动性分档" : `${value}%`}</option>)}
            </select>
            <label htmlFor="signal-market">行情类型</label>
            <select id="signal-market" className={styles.tradingSelect} value={filter.market}
              onChange={(event) => setFilter({ ...filter, market: event.target.value as SampleFilter["market"] })}>
              <option value="all">全部</option>
              <option value="single">个币独立（同时 ≤3 个币）</option>
              <option value="mixed">中间（4–9 个币）</option>
              <option value="market">全市场（≥10 个币）</option>
            </select>
            <label htmlFor="signal-volume">当时 24 小时成交额</label>
            <select id="signal-volume" className={styles.tradingSelect} value={filter.minVolume}
              onChange={(event) => setFilter({ ...filter, minVolume: Number(event.target.value) })}>
              {LIQUIDITY_OPTIONS.map((value) => <option key={value} value={value}>
                {value === 0 ? "不限" : `≥ ${value >= 1e8 ? `${value / 1e8} 亿` : `${value / 1e4} 万`}`}</option>)}
            </select>
            {source === "live" && <label className={styles.monitorSwitch}>
              <input type="checkbox" checked={filter.alertedOnly}
                onChange={(event) => setFilter({ ...filter, alertedOnly: event.target.checked })} />只看已告警
            </label>}
          </div>

          {source === "scan" ? <form className={styles.monitorForm} onSubmit={scan}>
            <label htmlFor="scan-days">最近</label>
            <input id="scan-days" type="number" min={1} max={365} required value={scanForm.days} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, days: event.target.value })} />天，
            <label htmlFor="scan-top">成交额前</label>
            <input id="scan-top" type="number" min={10} max={300} required value={scanForm.top} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, top: event.target.value })} />个合约，
            <label htmlFor="scan-window">窗口</label>
            <input id="scan-window" type="number" min={1} max={15} required value={scanForm.windowMinutes} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, windowMinutes: event.target.value })} />分钟内涨跌超过
            <input id="scan-percent" aria-label="涨跌幅阈值（%）" type="number" min={1} max={50} step="0.1" required
              value={scanForm.percent} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, percent: event.target.value })} />%，
            <label htmlFor="scan-z">且至少是平时波动的</label>
            <input id="scan-z" type="number" min={0} max={30} step="0.5" required value={scanForm.zScore} disabled={running}
              onChange={(event) => setScanForm({ ...scanForm, zScore: event.target.value })} />倍（0 = 不限）
            <button type="submit" disabled={running}>{running ? "扫描中…" : "开始扫描"}</button>
          </form> : <p>实时告警在发生 1 小时后自动补算结果，需要开启「异动监控策略」并保持服务运行。</p>}
          {source === "scan" && data && <p role="status">{scanStatus(data.scan)}</p>}
          {data?.archive && <p>{archiveStatus(data.archive)}</p>}
          {scanMessage && <p role="alert">{scanMessage}</p>}

          {samples.length > 0 && <p role="status">
            当前 {samples.length} 个样本，来自 {events} 个独立事件（相隔 15 分钟以内的异动算同一事件）。
            {split && `前后两段以 ${formatTime.format(split)} 为界。`}
          </p>}

          <h4>出场方式模拟 <span>
            {cost === "tiered" ? "按流动性分档扣成本" : `扣除每笔 ${cost}% 成本`}；未注明时长的最多持仓 60 分钟</span></h4>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">出场方式</th><th scope="col">样本 / 事件</th><th scope="col">追进去胜率</th>
                <th scope="col">追进去每笔平均</th><th scope="col">前半段 / 后半段</th><th scope="col">盈利事件占比</th>
                <th scope="col">总盈利 ÷ 总亏损</th><th scope="col">去掉最赚 {TRIMMED_TRADES} 笔</th>
                <th scope="col">止盈 / 止损 / 到期</th><th scope="col">反向操作每笔平均</th>
              </tr></thead>
              <tbody>
                {samples.length === 0 && <tr><td colSpan={10} className={styles.emptyTableCell}>
                  <span role="status">{source === "scan" ? "暂无样本，请先开始扫描。" : "暂无已完成的实时告警样本。"}</span></td></tr>}
                {samples.length > 0 && barrierRows.map(({ chase, fade, ...plan }, index) => <tr key={index}>
                  <th scope="row">{barrierLabel(plan)}</th>
                  <td><Count stats={chase} /></td>
                  <td>{share(chase.winRate)}</td>
                  {average(chase)}
                  {halves(chase)}
                  <td>{share(chase.eventWinRate)}</td>
                  <td>{chase.profitFactor === null ? "—" : chase.profitFactor.toFixed(2)}</td>
                  <td className={tone(chase.trimmed)}>{pct(chase.trimmed, 3)}</td>
                  <td>{chase.takes} / {chase.stops} / {chase.times}</td>
                  {average(fade)}
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
            <label htmlFor="signal-barrier">出场方式</label>
            <select id="signal-barrier" className={styles.tradingSelect} value={barrier}
              onChange={(event) => setBarrier(Number(event.target.value))}>
              {barriers.map((barrier, index) => <option key={index} value={index}>{barrierLabel(barrier)}</option>)}
            </select>
          </div>
          <div className={styles.tableScroll}>
            <table className={styles.alertTable}>
              <thead><tr>
                <th scope="col">分组</th><th scope="col">样本 / 事件</th><th scope="col">追进去胜率</th>
                <th scope="col">追进去每笔平均</th><th scope="col">前半段 / 后半段</th><th scope="col">盈利事件占比</th>
                <th scope="col">反向操作每笔平均</th><th scope="col">反向前半段 / 后半段</th>
              </tr></thead>
              <tbody>
                {groups.map(({ bucket, chase, fade }) => <tr key={bucket}>
                  <th scope="row">{bucket}</th>
                  <td><Count stats={chase} /></td>
                  <td>{share(chase.winRate)}</td>
                  {average(chase)}
                  {halves(chase)}
                  <td>{share(chase.eventWinRate)}</td>
                  {average(fade)}
                  {halves(fade)}
                </tr>)}
              </tbody>
            </table>
          </div>

          <details className={styles.turnover}>
            <summary className={styles.monitorSectionSummary}><h4>最近样本 <span>最多 100 条</span></h4></summary>
            <div className={`${styles.tableScroll} ${styles.alertScroll}`}>
              <table className={styles.alertTable}>
                <thead><tr>
                  <th scope="col">时间</th><th scope="col">交易对</th><th scope="col">涨跌幅</th><th scope="col">超额涨跌</th>
                  <th scope="col">同时异动</th><th scope="col">成交额倍数</th>
                  <th scope="col">5 分钟</th><th scope="col">15 分钟</th><th scope="col">60 分钟</th>
                  <th scope="col">最大浮盈 / 浮亏</th>
                </tr></thead>
                <tbody>
                  {samples.slice(0, 100).map((sample) => <tr key={sample.id}>
                    <td><time dateTime={new Date(sample.time).toISOString()}>{formatTime.format(sample.time)}</time></td>
                    <th scope="row">{sample.symbol}</th>
                    <td className={tone(sample.change)}>{pct(sample.change)}</td>
                    <td className={tone(sample.context.excess)}>{pct(sample.context.excess)}</td>
                    <td>{sample.context.concurrent} 个（{marketLabels[marketKind(sample.context.concurrent)]}）</td>
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
            成本「按流动性分档」：当时 24 小时成交额 ≥5 亿每笔 0.14%，1–5 亿 0.2%，2000 万–1 亿 0.3%，更低或未知 0.5%（双边吃单手续费 0.1% 加滑点）。
            「按波动率」的止损止盈以这个币前 24 小时的 1 小时波动幅度为单位；「保本」在浮盈达到止损距离后把止损移到开仓价；
            「移动止损」不设止盈，止损跟随最好价格。
            说明：历史扫描用 1 分钟K线找出「{data?.scan.params?.windowMinutes ?? "N"} 分钟内涨跌超过阈值」的异动，在下一分钟开盘价进场，
            同一合约 30 分钟内只取一次；实时告警按告警价进场。同一分钟内同时碰到止损和止盈时按止损计，结果偏保守。
            走势表的收益方向和异动一致，正数表示继续往异动方向走。
            一次全市场大行情会同时产生几十个样本，所以同时显示独立事件数，并把样本按时间分成前后两段分别统计；
            只有每笔平均不低于 +{MIN_EDGE}%、前后两段都为正、总盈利 ÷ 总亏损不低于 {MIN_PROFIT_FACTOR}、
            去掉最赚的 {TRIMMED_TRADES} 笔后仍为正、且独立事件不少于 {MIN_EVENTS} 个时，才标「可信」。
            同时异动币数只数异动之前 5 分钟内的币，和实盘时能看到的一致。
            默认只看当时 24 小时成交额不低于 2000 万的样本；扫描只包含现在仍在交易的合约，已下架的币不在其中。
            标「少」表示样本不足 {MIN_SAMPLES} 个或独立事件不足 {MIN_EVENTS / 2} 个，暂不下结论。
          </p>
        </>}
      </div>
    </details>
  );
}

"use client";

import { useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { PNL_RANGES, chartGeometry, nearestPoint, pnlSeries, type PnlCurvePoint, type PnlRange } from "@/lib/pnl-chart";
import styles from "./workbench.module.css";

const HEIGHT = 200;
const PAD = 10;
const formatTime = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "short", timeStyle: "short" });
const formatAmount = new Intl.NumberFormat("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2, signDisplay: "exceptZero" });

/** 累计已实现盈亏曲线：每笔交易平仓时跳到新的累计值，可切换 7 天 / 30 天 / 全部。 */
export default function PnlChart({ curve }: { curve: readonly PnlCurvePoint[] }) {
  const [range, setRange] = useState<PnlRange>("30d");
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = box.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // 时间范围按打开页面的时刻计算，曲线数据每次刷新时一起更新。
  const series = useMemo(() => pnlSeries(curve, range, Date.now()), [curve, range]);
  const geometry = useMemo(() => chartGeometry(series, width, HEIGHT, PAD), [series, width]);
  const last = series.at(-1)?.value ?? 0;
  const tone = last >= 0 ? "hsl(var(--success))" : "hsl(var(--destructive))";
  const point = hover !== null && geometry ? { ...series[hover], ...geometry.points[hover] } : null;

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!geometry) return;
    const rect = event.currentTarget.getBoundingClientRect();
    setHover(nearestPoint(geometry.points, event.clientX - rect.left));
  }

  return (
    <section className={styles.card} aria-label="累计盈亏曲线">
      <div className={styles.cardHeader}>
        <h3 className={styles.cardTitle}>累计盈亏</h3>
        <span className={`${styles.cardMeta} ${last > 0 ? styles.up : last < 0 ? styles.down : ""}`}>
          {series.length ? `${formatAmount.format(last)} USDT` : ""}
        </span>
        <div className={styles.segmented} role="group" aria-label="时间范围">
          {PNL_RANGES.map((option) => (
            <button key={option.id} type="button" aria-pressed={range === option.id}
              className={`${styles.segment} ${range === option.id ? styles.segmentActive : ""}`}
              onClick={() => setRange(option.id)}>{option.label}</button>
          ))}
        </div>
      </div>
      <div className={styles.chart} ref={box}>
        {!geometry && <div className={styles.empty}>
          {curve.length === 0 ? "还没有已结束的交易，平仓后这里会画出累计盈亏。" : "这段时间内没有已结束的交易。"}
        </div>}
        {geometry && <>
          <svg className={styles.chartSvg} viewBox={`0 0 ${width} ${HEIGHT}`} role="img"
            aria-label={`累计盈亏 ${formatAmount.format(last)} USDT`}
            onPointerMove={move} onPointerLeave={() => setHover(null)}>
            <line x1={0} x2={width} y1={geometry.zeroY} y2={geometry.zeroY}
              stroke="hsl(var(--border))" strokeDasharray="4 4" />
            <path d={geometry.area} fill={tone} opacity={0.08} />
            <path d={geometry.line} fill="none" stroke={tone} strokeWidth={2} strokeLinejoin="round" />
            {point && <>
              <line x1={point.x} x2={point.x} y1={0} y2={HEIGHT} stroke="hsl(var(--border))" />
              <circle cx={point.x} cy={point.y} r={4} fill={tone} />
            </>}
          </svg>
          <span className={styles.chartAxis} style={{ top: 8 }}>{formatAmount.format(geometry.max)}</span>
          <span className={styles.chartAxis} style={{ bottom: 12 }}>{formatAmount.format(geometry.min)}</span>
          {point && <div className={styles.tooltip}
            style={point.x > width / 2 ? { right: width - point.x + 24 } : { left: point.x + 24 }}>
            <div>{formatTime.format(point.time)}</div>
            {point.symbol && <div>{point.symbol} 这笔 <span className={(point.pnl ?? 0) >= 0 ? styles.up : styles.down}>
              {formatAmount.format(point.pnl ?? 0)}</span></div>}
            <div>累计 <strong>{formatAmount.format(point.value)}</strong> USDT</div>
          </div>}
        </>}
      </div>
    </section>
  );
}

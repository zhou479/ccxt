/** 盈亏曲线：按时间范围截取已结束交易，从 0 开始累计，再换算成 SVG 坐标。 */

export type PnlCurvePoint = { time: number; pnl: number; cumulative: number; symbol: string };

/** 曲线上的一个点；第一个点值为 0，最后一个点是「现在」，延续最新的累计值。 */
export type SeriesPoint = { time: number; value: number; pnl: number | null; symbol: string | null };

export const PNL_RANGES = [
  { id: "7d", label: "7 天", ms: 7 * 86_400_000 },
  { id: "30d", label: "30 天", ms: 30 * 86_400_000 },
  { id: "all", label: "全部", ms: null },
] as const;

export type PnlRange = (typeof PNL_RANGES)[number]["id"];

/** 截取 `now - range` 之后平仓的交易，累计盈亏从 0 开始。横轴从范围内第一笔交易开始，交易少时也看得清。 */
export function pnlSeries(curve: readonly PnlCurvePoint[], range: PnlRange, now: number): SeriesPoint[] {
  const ms = PNL_RANGES.find(({ id }) => id === range)?.ms ?? null;
  const from = ms === null ? null : now - ms;
  const inside = from === null ? curve : curve.filter(({ time }) => time >= from);
  if (inside.length === 0) return [];
  // 范围之前已经累计的部分要减掉，这样曲线从 0 起步。
  const before = from === null ? 0 : (curve.filter(({ time }) => time < from).at(-1)?.cumulative ?? 0);
  const points: SeriesPoint[] = [
    { time: inside[0].time, value: 0, pnl: null, symbol: null },
    ...inside.map(({ time, pnl, cumulative, symbol }) => ({ time, value: cumulative - before, pnl, symbol })),
  ];
  const last = points[points.length - 1];
  if (now > last.time) points.push({ time: now, value: last.value, pnl: null, symbol: null });
  return points;
}

export type ChartGeometry = {
  /** 阶梯折线：每笔交易平仓时累计盈亏跳到新值。 */
  line: string;
  /** 曲线和 0 轴之间的填充区域。 */
  area: string;
  zeroY: number;
  min: number;
  max: number;
  /** 每个点的坐标，用于鼠标悬停时找最近的点。 */
  points: { x: number; y: number }[];
};

/** 把序列换算到 `width × height` 的画布（四周留 `pad`）。纵轴总是包含 0。 */
export function chartGeometry(series: readonly SeriesPoint[], width: number, height: number, pad = 8): ChartGeometry | null {
  if (series.length < 2 || width <= 2 * pad || height <= 2 * pad) return null;
  const values = series.map(({ value }) => value);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const first = series[0].time;
  const last = series[series.length - 1].time;
  const duration = last - first || 1;
  const x = (time: number) => pad + ((time - first) / duration) * (width - 2 * pad);
  const y = (value: number) => pad + ((max - value) / span) * (height - 2 * pad);
  const points = series.map(({ time, value }) => ({ x: x(time), y: y(value) }));
  const round = (value: number) => Math.round(value * 10) / 10;
  let line = `M${round(points[0].x)},${round(points[0].y)}`;
  for (let index = 1; index < points.length; index += 1) {
    line += ` H${round(points[index].x)} V${round(points[index].y)}`;
  }
  const zeroY = y(0);
  const area = `${line} V${round(zeroY)} H${round(points[0].x)} Z`;
  return { line, area, zeroY, min, max, points };
}

/** 离横坐标 `x` 最近的点的序号。 */
export function nearestPoint(points: readonly { x: number }[], x: number): number {
  let best = 0;
  for (let index = 1; index < points.length; index += 1) {
    if (Math.abs(points[index].x - x) < Math.abs(points[best].x - x)) best = index;
  }
  return best;
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { chartGeometry, nearestPoint, pnlSeries } from "./pnl-chart.ts";

const DAY = 86_400_000;
const curve = [
  { time: 1 * DAY, pnl: 5, cumulative: 5, symbol: "A" },
  { time: 20 * DAY, pnl: -3, cumulative: 2, symbol: "B" },
  { time: 28 * DAY, pnl: 4, cumulative: 6, symbol: "C" },
];

test("a range starts at zero and leaves out what was earned before it", () => {
  const all = pnlSeries(curve, "all", 30 * DAY);
  assert.deepEqual(all.map(({ value }) => value), [0, 5, 2, 6, 6]);
  assert.equal(all.at(-1).time, 30 * DAY);
  assert.equal(all[0].time, DAY);
  const week = pnlSeries(curve, "7d", 30 * DAY);
  // 只剩第 28 天那一笔：从 0 跳到 +4，之前赚的 2 不算进这段。
  assert.deepEqual(week.map(({ time, value }) => [time / DAY, value]), [[28, 0], [28, 4], [30, 4]]);
  assert.deepEqual(pnlSeries(curve, "7d", 100 * DAY), []);
  assert.deepEqual(pnlSeries([], "all", 0), []);
});

test("the chart keeps zero on the axis and steps at each closed trade", () => {
  const geometry = chartGeometry(pnlSeries(curve, "all", 30 * DAY), 100, 50, 0);
  assert.equal(geometry.min, 0);
  assert.equal(geometry.max, 6);
  assert.equal(geometry.zeroY, 50);
  assert.equal(geometry.points.length, 5);
  assert.ok(geometry.line.startsWith("M0,50 H0 V8.3"));
  assert.ok(geometry.line.endsWith("H100 V0"));
  assert.ok(geometry.area.endsWith("V50 H0 Z"));
  const losing = chartGeometry([{ time: 0, value: 0 }, { time: 1, value: -4 }], 100, 50, 0);
  assert.equal(losing.max, 0);
  assert.equal(losing.zeroY, 0);
  assert.equal(chartGeometry([{ time: 0, value: 0 }], 100, 50), null);
  // 横轴从第 1 天到第 30 天：第 20 天约在 65.5，第 28 天约在 93.1。
  assert.equal(nearestPoint(geometry.points, 70), 2);
});

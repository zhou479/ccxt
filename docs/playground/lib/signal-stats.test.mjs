import assert from "node:assert/strict";
import { test } from "node:test";
import { barrierStats, filterSamples, groupStats, horizonStats, tradeStats } from "./signal-stats.ts";

const barriers = [{ stop: 1, take: 2 }];

function sample(overrides = {}) {
  return {
    id: "s", source: "scan", symbol: "BTCUSDT", time: 0, direction: "up", change: 3, windowSeconds: 300, level: null,
    status: "scan", turnoverMultiple: 4, entry: 100, returns: { 1: 0.5, 5: 1, 15: -1, 30: 2, 60: 3 }, mfe: 3, mae: -1,
    features: { pre60: 2, btcWindow: 0.5, btcPre60: 0, takerBuyShare: 0.7, oiChange15: 2, oiChange60: 3,
      fundingRate: 0.01, quoteVolume24h: 3e8, hour: 13 },
    barriers: [{ stop: 1, take: 2, chase: { exit: "take", pnl: 2, minutes: 5 }, fade: { exit: "stop", pnl: -1, minutes: 5 } }],
    ...overrides,
  };
}

test("trade statistics subtract the cost from every trade", () => {
  const stats = tradeStats([{ exit: "take", pnl: 2, minutes: 1 }, { exit: "stop", pnl: -1, minutes: 1 }, null], 0.2);
  assert.equal(stats.count, 2);
  assert.equal(stats.winRate, 0.5);
  assert.ok(Math.abs(stats.average - 0.3) < 1e-9);
  assert.ok(Math.abs(stats.payoff - 1.8 / 1.2) < 1e-9);
  assert.deepEqual([stats.takes, stats.stops, stats.times], [1, 1, 0]);
});

test("filters combine direction, turnover multiple and live verification", () => {
  const samples = [
    sample({ id: "a" }),
    sample({ id: "b", direction: "down", change: -3 }),
    sample({ id: "c", turnoverMultiple: null }),
    sample({ id: "d", source: "live", status: "below-threshold" }),
  ];
  assert.deepEqual(filterSamples(samples, { direction: "up", minMultiple: 3, alertedOnly: true }).map(({ id }) => id), ["a"]);
  assert.equal(filterSamples(samples, { direction: "all", minMultiple: 0, alertedOnly: false }).length, 4);
});

test("chasing and fading are reported side by side", () => {
  const [row] = barrierStats([sample(), sample()], barriers, 0.1);
  assert.equal(row.chase.average, 1.9);
  assert.equal(row.fade.average, -1.1);
});

test("horizons report the share of moves that kept going", () => {
  const rows = horizonStats([sample(), sample({ returns: { 1: -1, 5: -1, 15: -1, 30: -1, 60: -1 } })], [5, 60]);
  assert.deepEqual(rows.map(({ minutes, continued }) => [minutes, continued]), [[5, 0.5], [60, 0.5]]);
  assert.equal(rows[1].average, 1);
});

test("features are bucketed in the direction of the move", () => {
  const up = sample({ features: { ...sample().features, btcWindow: 0.5 } });
  const down = sample({ direction: "down", change: -3, features: { ...sample().features, btcWindow: 0.5, takerBuyShare: 0.2 } });
  assert.deepEqual(groupStats([up, down], "btc", 0, 0).map(({ bucket }) => bucket), ["BTC 反向 ≥0.3%", "BTC 同向 ≥0.3%"]);
  assert.deepEqual(groupStats([up, down], "taker", 0, 0).map(({ bucket, chase }) => [bucket, chase.count]), [["≥70%", 2]]);
  assert.deepEqual(groupStats([up], "missing", 0, 0), []);
});

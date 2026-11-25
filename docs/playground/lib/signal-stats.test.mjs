import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EVENT_GAP_MS, MIN_EVENTS, barrierStats, filterSamples, groupStats, horizonStats, outcomeStats, prepareSamples, tradeStats,
} from "./signal-stats.ts";

const MINUTE = 60_000;
const barriers = [{ stop: 1, take: 2 }];
const all = { direction: "all", minMultiple: 0, alertedOnly: false, market: "all", minVolume: 0 };

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

function exit(pnl) {
  return [{ stop: 1, take: 2, chase: { exit: pnl > 0 ? "take" : "stop", pnl, minutes: 5 }, fade: null }];
}

test("trade statistics subtract the cost from every trade", () => {
  const stats = tradeStats([{ exit: "take", pnl: 2, minutes: 1 }, { exit: "stop", pnl: -1, minutes: 1 }, null], 0.2);
  assert.equal(stats.count, 2);
  assert.equal(stats.winRate, 0.5);
  assert.ok(Math.abs(stats.average - 0.3) < 1e-9);
  assert.ok(Math.abs(stats.payoff - 1.8 / 1.2) < 1e-9);
  assert.deepEqual([stats.takes, stats.stops, stats.times], [1, 1, 0]);
});

test("context counts symbols moving together, events, halves and excess over BTC", () => {
  const samples = prepareSamples([
    ...Array.from({ length: 12 }, (_, index) => sample({ id: `m${index}`, symbol: `C${index}`, time: index * 10_000 })),
    sample({ id: "solo", symbol: "SOLO", time: 3 * 60 * MINUTE, change: -4, features: { ...sample().features, btcWindow: -1 } }),
  ]);
  const solo = samples.find(({ id }) => id === "solo");
  // Only the past counts: the first coin of the burst looks alone, the last sees all twelve.
  assert.equal(samples[0].context.concurrent, 1);
  assert.equal(samples[11].context.concurrent, 12);
  assert.equal(solo.context.concurrent, 1);
  assert.equal(solo.context.excess, -3);
  assert.equal(new Set(samples.map(({ context }) => context.event)).size, 2);
  assert.deepEqual([samples[0].context.half, solo.context.half], [0, 1]);
  assert.deepEqual(filterSamples(samples, { ...all, market: "single" }).map(({ id }) => id), ["m0", "m1", "m2", "solo"]);
  assert.equal(filterSamples(samples, { ...all, market: "market" }).length, 3);
  assert.equal(filterSamples(samples, { ...all, minVolume: 5e8 }).length, 0);
});

test("filters combine direction, turnover multiple, live verification and the symbol cooldown", () => {
  const samples = prepareSamples([
    sample({ id: "a" }),
    sample({ id: "repeat", time: 10 * MINUTE }),
    sample({ id: "b", symbol: "ETHUSDT", direction: "down", change: -3 }),
    sample({ id: "c", symbol: "XRPUSDT", turnoverMultiple: null }),
    sample({ id: "d", symbol: "SOLUSDT", source: "live", status: "below-threshold" }),
  ]);
  assert.deepEqual(filterSamples(samples, { ...all, direction: "up", minMultiple: 3, alertedOnly: true }).map(({ id }) => id), ["a"]);
  assert.equal(filterSamples(samples, all).length, 4);
});

test("a result is credible only when both halves are positive and enough events agree", () => {
  const spaced = (count, pnl, offset = 0) => Array.from({ length: count }, (_, index) =>
    sample({ id: `${pnl}-${index}-${offset}`, symbol: `S${index}`, time: offset + index * (EVENT_GAP_MS + MINUTE), barriers: exit(pnl) }));
  const steady = prepareSamples(spaced(MIN_EVENTS, 1));
  const stats = outcomeStats(steady, 0, "chase", 0.2);
  assert.equal(stats.events, MIN_EVENTS);
  assert.ok(stats.credible);
  // A thin edge below MIN_EDGE is not enough, however steady.
  assert.equal(outcomeStats(prepareSamples(spaced(MIN_EVENTS, 0.3)), 0, "chase", 0.2).credible, false);
  // One burst of 40 winners on top of steady small losers: positive overall, not credible.
  const burst = Array.from({ length: 40 }, (_, index) => sample({ id: `burst${index}`, symbol: `B${index}`, time: 0, barriers: exit(3) }));
  const mixed = prepareSamples([...burst, ...spaced(MIN_EVENTS, -0.5, EVENT_GAP_MS * 2)]);
  const lucky = outcomeStats(mixed, 0, "chase", 0.2);
  assert.ok(lucky.average > 0);
  assert.equal(lucky.credible, false);
  assert.ok(lucky.profitFactor > 1);
  assert.equal(lucky.trimmed < lucky.average, true);
  assert.ok(lucky.eventWinRate < 0.1);
});

test("chasing and fading are reported side by side", () => {
  const [row] = barrierStats(prepareSamples([sample(), sample({ symbol: "ETHUSDT" })]), barriers, 0.1);
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
  const down = sample({ symbol: "ETHUSDT", direction: "down", change: -3,
    features: { ...sample().features, btcWindow: 0.5, takerBuyShare: 0.2 } });
  const samples = prepareSamples([up, down]);
  assert.deepEqual(groupStats(samples, "btc", 0, 0).map(({ bucket }) => bucket), ["BTC 反向 ≥0.3%", "BTC 同向 ≥0.3%"]);
  assert.deepEqual(groupStats(samples, "taker", 0, 0).map(({ bucket, chase }) => [bucket, chase.count]), [["≥70%", 2]]);
  assert.deepEqual(groupStats(samples, "excess", 0, 0).map(({ bucket }) => bucket), ["2–3%", "3–5%"]);
  assert.deepEqual(groupStats(samples, "missing", 0, 0), []);
});

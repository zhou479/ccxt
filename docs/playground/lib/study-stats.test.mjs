import assert from "node:assert/strict";
import { test } from "node:test";
import { COST_TIERS } from "./signal-stats.ts";
import {
  HYPOTHESES, ROUND_GAP_MS, STUDY_COST_TIERS, STUDY_MIN_EVENTS, planLabel, prepareStudy, studyCost, studyGroupStats, studyStats, studySummary,
  studyTrades,
} from "./study-stats.ts";

const HOUR = 3_600_000;
const hypothesis = (id) => HYPOTHESES.find((one) => one.id === id);

function sample(overrides = {}, long = { exit: "normal", hours: 10, price: 2, funding: 0.3 }, short = null) {
  const { features, ...rest } = overrides;
  return {
    id: "s", symbol: "AUSDT", time: 0, entryTime: HOUR, entry: 1, direction: "negative", delisted: false,
    features: { rate: -0.2, rate8h: -0.2, intervalHours: 8, ret24h: -5, ret72h: -8, btcRet24h: 0, volume24h: 6e8, rank: 5,
      concurrent: 1, regime: "bull", ...features },
    plans: [{ long, short: short ?? (long ? { ...long, price: -long.price, funding: -long.funding } : null) }],
    ...rest,
  };
}

test("cost tiers match the signal statistics", () => {
  assert.deepEqual(STUDY_COST_TIERS, COST_TIERS);
  assert.deepEqual([6e8, 2e8, 5e7, 1e6].map((volume24h) => studyCost(sample({ features: { volume24h } }))), [0.14, 0.2, 0.3, 0.5]);
});

test("hypotheses pick their side from the crowded direction", () => {
  const negative = sample();
  const positiveFalling = sample({ direction: "positive", features: { ret24h: -2 } });
  const positiveRising = sample({ direction: "positive", features: { ret24h: 3 } });
  const sides = (id) => [negative, positiveFalling, positiveRising].map((one) => hypothesis(id).side(one));
  assert.deepEqual(sides("F1"), ["long", null, null]);
  assert.deepEqual(sides("F0"), [null, "short", "short"]);
  assert.deepEqual(sides("F2"), [null, "short", null]);
  assert.deepEqual(sides("F3"), ["short", "long", "long"]);
});

test("net results add funding and subtract the tiered cost; one settlement round is one event", () => {
  const rows = prepareStudy([
    sample({ id: "a", symbol: "A", time: 0 }),
    sample({ id: "b", symbol: "B", time: ROUND_GAP_MS / 2 }),
    sample({ id: "c", symbol: "C", time: 10 * HOUR, features: { volume24h: 1e6, regime: "bear" } }),
  ]);
  assert.deepEqual(rows.map(({ event, half }) => [event, half]), [[0, 0], [0, 0], [1, 1]]);
  const trades = studyTrades(rows, hypothesis("F1"), 0);
  assert.deepEqual(trades.map(({ net }) => Math.round(net * 100) / 100), [2.16, 2.16, 1.8]);
  const stats = studyStats(trades);
  assert.equal(stats.events, 2);
  assert.equal(stats.regimes.bear.count, 1);
  assert.equal(stats.exits.normal, 3);
  assert.ok(Math.abs(stats.funding - 0.3) < 1e-9);
  assert.equal(stats.credible, false);
  assert.ok(stats.failures[0].startsWith("独立事件 2"));
  // F3 shorts the negative side and loses the mirror image.
  assert.ok(studyStats(studyTrades(rows, hypothesis("F3"), 0)).average < 0);
});

test("a steady edge across rounds and regimes passes; a regime with heavy losses does not", () => {
  const steady = Array.from({ length: STUDY_MIN_EVENTS + 10 }, (_, index) => sample({
    id: `s${index}`, symbol: `S${index}`, time: index * 10 * HOUR,
    features: { regime: ["bull", "bear", "range"][index % 3] },
  }, { exit: "normal", hours: 8, price: index % 4 === 0 ? -1 : 1, funding: 0.2 }));
  const passing = studyStats(studyTrades(prepareStudy(steady), hypothesis("F1"), 0));
  assert.deepEqual(passing.failures, []);
  assert.ok(passing.credible);
  assert.ok(passing.maxDrawdown > 0 && passing.maxDrawdown < passing.total);
  const bearCrash = steady.map((one, index) => (index % 3 === 1
    ? { ...one, plans: [{ long: { exit: "stop", hours: 3, price: -8, funding: 0 }, short: null }] } : one));
  const failing = studyStats(studyTrades(prepareStudy(bearCrash), hypothesis("F1"), 0));
  assert.equal(failing.credible, false);
  assert.ok(failing.failures.some((reason) => reason.startsWith("熊市")));
});

test("groups split the trades, and plan labels read in Chinese", () => {
  const rows = prepareStudy([sample({ id: "a" }), sample({ id: "b", symbol: "B", time: 5 * HOUR, delisted: true, features: { rate8h: -0.6 } })]);
  assert.deepEqual(studyGroupStats(rows, hypothesis("F1"), 0, "delisted").map(({ bucket, stats }) => [bucket, stats.count]),
    [["仍在交易", 1], ["已下架", 1]]);
  assert.deepEqual(studyGroupStats(rows, hypothesis("F1"), 0, "rate").map(({ bucket }) => bucket).sort(), ["0.2–0.3%", "≥0.5%"].sort());
  assert.equal(planLabel({ kind: "normal", hold: 72, stop: 8 }), "费率恢复正常就平，最多 3 天 · 止损 8%");
  assert.equal(planLabel({ kind: "fixed", hold: 8, stop: null }), "固定持仓 8 小时 · 不设止损");
});

test("the summary counts passed hypotheses and names the best one", () => {
  const steady = Array.from({ length: STUDY_MIN_EVENTS + 10 }, (_, index) => sample({
    id: `s${index}`, symbol: `S${index}`, time: index * 10 * HOUR, features: { regime: ["bull", "bear", "range"][index % 3] },
  }, { exit: "normal", hours: 8, price: index % 4 === 0 ? -1 : 1, funding: 0.2 }));
  const summary = studySummary(steady, 0, 100);
  // 负费率样本：F1 做多通过；F3 顺着做做空，亏的是镜像。
  assert.equal(summary.signals, steady.length);
  assert.equal(summary.total, HYPOTHESES.length);
  assert.equal(summary.passed, 1);
  assert.equal(summary.best.id, "F1");
  assert.equal(studySummary([], 0, 0).passed, 0);
});

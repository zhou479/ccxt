import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDayStart, fundingStrategyCard, runningSummary, spikeMonitorCard, strategyCards, testStrategyCard } from "./strategy-list.ts";

const HOUR = 3_600_000;
const now = 1_795_600_000_000;
const today = beijingDayStart(now);

function monitor(overrides = {}) {
  return {
    configured: true,
    rule: { enabled: true, notify: true, seconds: 30, up: 5, down: -5, turnoverMultiple: 3 },
    worker: "connected",
    records: [],
    spikes: [
      { symbol: "A", time: today + HOUR, status: "alerted" },
      { symbol: "B", time: today + 2 * HOUR, status: "below-threshold" },
      { symbol: "C", time: today - HOUR, status: "alerted" },
    ],
    autoOrders: [],
    autoOrderRequests: [],
    ...overrides,
  };
}

test("the Beijing day starts at 16:00 UTC", () => {
  assert.equal((today + 8 * HOUR) % (24 * HOUR), 0);
  assert.ok(now >= today && now - today < 24 * HOUR);
});

test("the spike monitor card follows the background rule and counts today's alerts", () => {
  const card = spikeMonitorCard(monitor(), now);
  assert.equal(card.running, true);
  assert.equal(card.status, "运行中 · 行情已连接");
  assert.deepEqual(card.stats, [
    { label: "今日告警", value: "1" },
    { label: "钉钉通知", value: "开" },
    { label: "规则", value: "30 秒内涨 5% / 跌 5% · 成交额 ≥ 3 倍" },
  ]);
  const offline = spikeMonitorCard(monitor({ worker: "offline" }), now);
  assert.equal(offline.warning, true);
  const stopped = spikeMonitorCard(monitor({ rule: { ...monitor().rule, enabled: false, up: null } }), now);
  assert.equal(stopped.running, false);
  assert.equal(stopped.status, "已停止");
  assert.equal(stopped.stats[2].value, "30 秒内跌 5% · 成交额 ≥ 3 倍");
  assert.equal(spikeMonitorCard(monitor({ configured: false }), now).status, "还没有保存过规则");
  assert.equal(spikeMonitorCard(null, now).status, "正在读取状态");
  // 详情里放这个策略自己的参数、记录和检验结果。
  assert.deepEqual(card.details.map(({ label }) => label), ["参数设置", "异动记录", "信号统计"]);
  assert.equal(card.verdict.passed, false);
});

test("the test strategy has no switch and counts its own trades", () => {
  const trades = [
    { strategy: { id: "test" }, status: "open", openedAt: today + HOUR },
    { strategy: { id: "test" }, status: "closed", openedAt: today - HOUR },
    { strategy: { id: "other" }, status: "open", openedAt: today + HOUR },
  ];
  const card = testStrategyCard(trades, now);
  assert.equal(card.running, null);
  assert.equal(card.toggleable, false);
  assert.deepEqual(card.details, []);
  assert.equal(card.verdict, null);
  assert.deepEqual(card.stats.map(({ value }) => value), ["1", "1"]);
  assert.deepEqual(runningSummary(strategyCards(monitor(), trades, now)), { running: 1, text: "异动监控策略运行中" });
  assert.deepEqual(runningSummary(strategyCards(null, [], now)), { running: 0, text: "暂无运行中的策略" });
});

test("the funding strategy shows its study verdict and cannot be started before passing", () => {
  const empty = fundingStrategyCard(null, false);
  assert.equal(empty.status, "还没有检验结果，打开详情运行历史检验");
  assert.equal(empty.toggleable, false);
  assert.deepEqual(empty.details, [{ id: "study", label: "历史检验" }]);
  const failed = fundingStrategyCard({ signals: 3079, from: today - 730 * 24 * HOUR, to: today, passed: 0, total: 4,
    best: { id: "F1", average: -0.0856 } }, false);
  assert.equal(failed.status, "未通过历史检验，不能启用");
  assert.equal(failed.verdict.passed, false);
  assert.deepEqual(failed.stats.slice(1).map(({ value }) => value), ["3079 个", "0 / 4", "F1 每笔 -0.09%"]);
  assert.equal(fundingStrategyCard(null, true).status, "正在运行历史检验…");
  assert.equal(strategyCards(null, [], now).map(({ id }) => id).join(), "spike-monitor,funding-rate,test");
  // 未通过的交易策略不算在运行中。
  assert.equal(runningSummary(strategyCards(null, [], now)).running, 0);
});

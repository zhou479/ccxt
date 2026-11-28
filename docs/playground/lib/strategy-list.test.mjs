import assert from "node:assert/strict";
import { test } from "node:test";
import { beijingDayStart, runningSummary, spikeMonitorCard, strategyCards } from "./strategy-list.ts";

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
  assert.deepEqual(card.details.map(({ label }) => label), ["参数设置"]);
});

test("only the spike monitor is listed, and the summary says whether it runs", () => {
  assert.deepEqual(strategyCards(monitor(), now).map(({ id }) => id), ["spike-monitor"]);
  assert.deepEqual(runningSummary(strategyCards(monitor(), now)), { running: 1, text: "异动监控策略运行中" });
  assert.deepEqual(runningSummary(strategyCards(null, now)), { running: 0, text: "暂无运行中的策略" });
});

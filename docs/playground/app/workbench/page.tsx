"use client";

import { useEffect, useMemo, useState } from "react";
import { apiUrl } from "@/lib/basePath";
import { runningSummary, strategyCards } from "@/lib/strategy-list";
import { tradingModeLabels } from "@/lib/trading-types";
import BinanceSettings from "../markets/binance-settings";
import DingTalkSettings from "../markets/dingtalk-settings";
import TestStrategy from "../markets/test-strategy";
import TradeRecords from "../markets/trade-records";
import { useBackgroundMonitor } from "../markets/use-background-monitor";
import { useStrategyNotifications } from "../markets/use-strategy-notifications";
import { useTrading } from "../markets/use-trading";
import MonitorCenter from "./monitor-center";
import Overview from "./overview";
import Research from "./research";
import Strategies from "./strategies";
import { useOverview } from "./use-overview";
import styles from "./workbench.module.css";

const TABS = [
  { id: "overview", label: "总览" },
  { id: "monitor", label: "异动监控中心" },
  { id: "strategies", label: "策略" },
  { id: "research", label: "研究" },
  { id: "settings", label: "设置" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/** 工作台：总览（资金、盈亏、持仓）、异动监控中心、策略（启停和参数）、研究（行情查询、研究数据）、设置（账号、通知、测试下单、记录）。 */
export default function Workbench() {
  const [tab, setTab] = useState<Tab>("overview");
  const trading = useTrading();
  const overview = useOverview(tab === "overview");
  const notifications = useStrategyNotifications();
  const monitor = useBackgroundMonitor();
  const cards = useMemo(() => strategyCards(monitor.data, Date.now()), [monitor.data]);

  // 分页记在地址栏的 #，刷新、前进后退或手动改地址后都停在对应的页。
  useEffect(() => {
    const follow = () => {
      const fromHash = window.location.hash.slice(1);
      if (TABS.some(({ id }) => id === fromHash)) setTab(fromHash as Tab);
    };
    follow();
    window.addEventListener("hashchange", follow);
    return () => window.removeEventListener("hashchange", follow);
  }, []);

  function open(next: Tab) {
    setTab(next);
    window.history.replaceState(null, "", `#${next}`);
  }

  const status = trading.data;
  const badge = status?.mode === "live" ? styles.badgeLive : status?.mode === "demo" ? styles.badgeDemo : "";

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <span className={styles.brand}>量化工作台</span>
        <nav className={styles.tabs} aria-label="工作台分页">
          {TABS.map(({ id, label }) => (
            <button key={id} type="button" aria-current={tab === id ? "page" : undefined}
              className={`${styles.tab} ${tab === id ? styles.tabActive : ""}`} onClick={() => open(id)}>{label}</button>
          ))}
        </nav>
        <div className={styles.headerRight}>
          <a className={styles.link} href={apiUrl("/markets")}>旧版行情页</a>
          {status && <span className={`${styles.badge} ${badge}`}>
            {status.enabled ? tradingModeLabels[status.mode] : "未连接账号"}
          </span>}
        </div>
      </header>

      <main className={styles.main}>
        {trading.mode === "unavailable" && <p className={styles.notice}>
          工作台只在本机启动（node scripts/start-rust-markets.mjs）时可用。
        </p>}

        {tab === "overview" && trading.mode !== "unavailable" && <Overview status={status} overview={overview.data}
          error={trading.error || overview.error} onCloseAll={trading.closeAll} onResume={trading.resume}
          strategies={runningSummary(cards)} onOpenSettings={() => open("settings")} onOpenStrategies={() => open("strategies")} />}

        {tab === "monitor" && <MonitorCenter monitor={monitor} onOpenStrategies={() => open("strategies")} />}

        {tab === "strategies" && <Strategies cards={cards} monitor={monitor} />}

        {tab === "research" && <Research />}

        {tab === "settings" && <>
          <h2 className={styles.sectionTitle}>账号与通知</h2>
          <div className={styles.columns}>
            <BinanceSettings availability={trading.mode} status={status} error={trading.error} onChange={trading.changeAccount} />
            <DingTalkSettings {...notifications} />
          </div>
          <h2 className={styles.sectionTitle}>测试下单</h2>
          <TestStrategy mode={trading.mode} status={status} error={trading.error} onSubmit={trading.placeTestOrder} />
          <h2 className={styles.sectionTitle}>下单记录</h2>
          <TradeRecords trades={status?.trades ?? []} activeMode={status?.enabled ? status.mode : "off"}
            canDelete={trading.mode === "local"} onDelete={trading.deleteTrades} onClose={trading.closeTrade} />
        </>}
      </main>
    </div>
  );
}

"use client";

import { useMemo } from "react";
import MarketMonitor from "./market-monitor";
import CoinResearch from "./coin-research";
import Logo from "@/components/Logo";
import { getContractCoins } from "@/lib/market-lookup";
import { useMarketDirectory } from "./use-market-directory";
import styles from "./markets.module.css";

export default function MarketsPage() {
  const binance = useMarketDirectory("binance");
  const okx = useMarketDirectory("okx");
  const futures = binance.directory?.futures;
  const contracts = futures?.updatedAt != null ? futures.instruments : undefined;
  const coinCount = useMemo(() => (contracts ? getContractCoins(contracts).size : null), [contracts]);

  return (
    <main className={styles.page} lang="zh-CN">
      <header className={styles.header}>
        <div className={styles.brand}><Logo size={22} /> 星期五</div>
        <nav className={styles.sectionNav} aria-label="页面板块">
          <a href="#market-alerts">交易策略</a>
          <a href="#coin-research">币种深度调研</a>
        </nav>
      </header>

      <div className={styles.content}>
        <div className={styles.intro}>
          <p className={styles.eyebrow}>BINANCE · OKX</p>
          <h1>币种行情</h1>
          <p>监控币安合约价格异动，查看币安和 OKX 的币种详情。</p>
        </div>

        <MarketMonitor contracts={contracts} coinCount={coinCount}
          directoryError={binance.syncError || !!futures?.stale} />
        <CoinResearch binance={binance} okx={okx} />
      </div>
    </main>
  );
}

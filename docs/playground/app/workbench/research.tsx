"use client";

import { useState } from "react";
import CoinResearch from "../markets/coin-research";
import FundingStudy from "../markets/funding-study";
import { useMarketDirectory } from "../markets/use-market-directory";
import styles from "./workbench.module.css";

const SECTIONS = [
  { id: "market", label: "行情查询" },
  { id: "study", label: "策略检验" },
] as const;

type Section = (typeof SECTIONS)[number]["id"];

/** 币种行情要先同步交易所目录，只在打开「行情查询」时加载。 */
function MarketLookup() {
  const binance = useMarketDirectory("binance");
  const okx = useMarketDirectory("okx");
  return <CoinResearch binance={binance} okx={okx} />;
}

/**
 * 研究页：不属于某个策略的通用工具——看行情、检验新的策略想法。
 * 某个策略自己的记录和检验结果（例如异动监控的异动记录、信号统计）放在策略页它的卡片详情里。
 */
export default function Research() {
  const [section, setSection] = useState<Section>("market");
  return (
    <>
      <div className={styles.subTabs} role="group" aria-label="研究分类">
        {SECTIONS.map(({ id, label }) => (
          <button key={id} type="button" aria-pressed={section === id}
            className={`${styles.subTab} ${section === id ? styles.subTabActive : ""}`} onClick={() => setSection(id)}>{label}</button>
        ))}
      </div>
      {section === "market" && <MarketLookup />}
      {section === "study" && <FundingStudy />}
    </>
  );
}

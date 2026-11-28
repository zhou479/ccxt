/** 资金费率检验的数据类型（对应 market-service/src/study.rs）。 */

export type StudySide = "long" | "short";

export type StudyOutcome = {
  exit: "normal" | "time" | "stop" | "delisted";
  hours: number;
  /** 按持仓方向计算的价格收益，%。 */
  price: number;
  /** 收到（正）或付出（负）的资金费，占开仓金额的 %。 */
  funding: number;
};

export type StudyPlan = { kind: "normal" | "fixed"; hold: number; stop: number | null };

export type Regime = "bull" | "bear" | "range";

export type FundingSample = {
  id: string;
  symbol: string;
  /** 信号所在的结算时间。 */
  time: number;
  entryTime: number;
  entry: number;
  /** 哪一方拥挤：正费率表示多头付费。 */
  direction: "positive" | "negative";
  delisted: boolean;
  features: {
    /** 结算费率，%。 */
    rate: number;
    /** 换算成每 8 小时口径的费率，%。 */
    rate8h: number;
    intervalHours: number;
    ret24h: number | null;
    ret72h: number | null;
    btcRet24h: number | null;
    volume24h: number;
    rank: number;
    /** 1 小时内同方向拥挤的合约数。 */
    concurrent: number;
    regime: Regime | null;
  };
  plans: { long: StudyOutcome | null; short: StudyOutcome | null }[];
};

export type StudyResult = {
  params: { days: number; top: number };
  from: number;
  to: number;
  plans: StudyPlan[];
  unfinished: number;
  samples: FundingSample[];
};

export type StudyJob = {
  status: "idle" | "running" | "done" | "failed";
  startedAt?: number;
  finishedAt?: number;
  error?: string;
  params?: { days: number; top: number };
  result?: StudyResult;
};

/** 研究数据的种类，和后端 dataset.rs 的 DataKind 一一对应。 */
export type DataKind = "contracts" | "hourly" | "funding" | "minute" | "openInterest" | "premium" | "liquidation" | "longShort";

export type DatasetJob = {
  /** 正在更新的数据种类；「all」是一起下载合约列表、小时K线和资金费率。 */
  kind?: DataKind | "all";
  label?: string;
  status: "idle" | "running" | "done" | "failed" | "interrupted" | "stopped";
  startedAt?: number;
  finishedAt?: number;
  days?: number;
  done?: number;
  total?: number;
  skipped?: number;
  failedCount?: number;
  failed?: { symbol: string; error: string }[];
  error?: string;
  archiveError?: string;
};

export type DatasetSnapshot = {
  job: DatasetJob;
  summary: {
    hourBars?: number; fundingPoints?: number; contracts?: number; delistedContracts?: number;
    /** 研究数据的时间范围（不含 BTC 为均线多下载的部分）。 */
    hourFrom?: number | null; hourTo?: number | null;
    /** 异动追单检验用的 1 分钟K线缓存。 */
    cachedBars?: number;
    cachedBarsAt?: number | null;
    /** 5 分钟持仓量（币安只保留约 30 天，程序自己存档）。 */
    openInterestPoints?: number;
    /** 程序自己存档的资金费率快照次数、强平单数量、多空比合约数。 */
    premiumSnapshots?: number;
    liquidations?: number;
    longShortSymbols?: number;
  } | null;
  regimes: { start: number; end: number; regime: Regime }[];
};

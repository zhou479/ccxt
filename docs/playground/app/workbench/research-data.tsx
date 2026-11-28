"use client";

import { useState } from "react";
import { useStudy } from "../markets/use-study";
import type { DataKind, DatasetSnapshot } from "@/lib/study-types";
import styles from "./workbench.module.css";

const number = new Intl.NumberFormat("zh-CN");
const day = new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" });

type Summary = NonNullable<DatasetSnapshot["summary"]>;

type Item = {
  kind: DataKind;
  name: string;
  what: string;
  amount: (summary: Summary) => string;
  use: string;
  /** 更新时下载多少天；存档类数据由程序运行时自动记录，没有「更新」。 */
  days?: number;
  /** 更新按钮下的说明。 */
  scope?: string;
};

type Group = { title: string; note: string; items: Item[] };

const count = (value: number | undefined, unit: string) => (value ? `${number.format(value)} ${unit}` : "没有数据");

/** 按类型分组的数据目录。每类数据可以单独更新、取消更新或删除。 */
const GROUPS: Group[] = [
  {
    title: "小时级数据",
    note: "两年的历史，所有 USDT 加密永续合约（含已下架）",
    items: [
      {
        kind: "contracts", name: "合约列表", what: "币安所有 USDT 加密永续合约，包括已经下架的",
        amount: (s) => (s.contracts ? `${number.format(s.contracts)} 个（其中已下架 ${number.format(s.delistedContracts ?? 0)} 个）` : "没有数据"),
        use: "选币范围；包含已下架的币，避免只看「活下来的币」", days: 730, scope: "重新整理交易所列表，几秒钟",
      },
      {
        kind: "hourly", name: "小时K线", what: "每个合约每小时的开盘、最高、最低、收盘价和成交额",
        amount: (s) => s.hourBars ? `${count(s.hourBars, "根")}（${s.hourFrom ? day.format(s.hourFrom) : "—"} 至 ${s.hourTo ? day.format(s.hourTo) : "—"}）` : "没有数据",
        use: "持仓几小时到几天的分析；按成交额给合约排流动性", days: 730, scope: "最近 730 天，只补缺的部分",
      },
      {
        kind: "funding", name: "资金费率", what: "每个合约每次结算的资金费率（每 1、4 或 8 小时一次）",
        amount: (s) => count(s.fundingPoints, "条"), use: "资金费率相关的分析；计算持仓期间收付的资金费",
        days: 730, scope: "最近 730 天，只补缺的部分",
      },
    ],
  },
  {
    title: "分钟级数据",
    note: "异动研究用，成交额最靠前的 100 个合约",
    items: [
      {
        kind: "minute", name: "1 分钟K线", what: "每分钟的价格和成交额",
        amount: (s) => count(s.cachedBars, "根"), use: "找出几分钟内的涨跌异动，再看之后的走势",
        days: 30, scope: "最近 30 天，只补缺的部分",
      },
      {
        kind: "openInterest", name: "持仓量", what: "每 5 分钟的未平仓合约数量。币安只保留约 30 天",
        amount: (s) => count(s.openInterestPoints, "条"), use: "异动前后持仓量是增加还是减少",
        days: 29, scope: "最近 29 天（币安只给这么多）",
      },
    ],
  },
  {
    title: "实时存档",
    note: "币安不提供这些的长期历史，程序运行时自动记录，只能删除",
    items: [
      {
        kind: "premium", name: "资金费率快照", what: "每 5 分钟所有合约的标记价、指数价和资金费率",
        amount: (s) => count(s.premiumSnapshots, "次"), use: "以后研究资金费率的变化过程",
      },
      {
        kind: "liquidation", name: "强平单", what: "币安推送的每一笔强平（只记录程序运行期间的）",
        amount: (s) => count(s.liquidations, "笔"), use: "以后研究强平是否预示反转",
      },
      {
        kind: "longShort", name: "多空比", what: "大户持仓多空比、全市场账户多空比",
        amount: (s) => (s.longShortSymbols ? `${number.format(s.longShortSymbols)} 个合约` : "没有数据"), use: "以后研究多空拥挤程度",
      },
    ],
  },
];

/** 研究页「研究数据」：按类型列出本地数据库里有哪些数据，每类可以单独更新、取消更新或删除。 */
export default function ResearchData() {
  const { mode, dataset, error, prepare, cancel, remove } = useStudy();
  const [busy, setBusy] = useState<DataKind | null>(null);
  const [message, setMessage] = useState<{ bad: boolean; text: string } | null>(null);
  const summary: Summary = dataset?.summary ?? {};
  const job = dataset?.job;
  const running = job?.status === "running";
  // 旧的「一起下载」会同时更新合约列表、小时K线和资金费率。
  const runningKinds: (DataKind | "all")[] = !running ? []
    : !job?.kind || job.kind === "all" ? ["contracts", "hourly", "funding"] : [job.kind];

  async function act(kind: DataKind, work: () => Promise<unknown>, done: string) {
    setBusy(kind);
    setMessage(null);
    try {
      await work();
      setMessage({ bad: false, text: done });
    } catch (caught) {
      setMessage({ bad: true, text: caught instanceof Error ? caught.message : "操作失败。" });
    } finally {
      setBusy(null);
    }
  }

  function update(item: Item) {
    const days = item.days;
    if (!days) return;
    void act(item.kind, () => prepare(days, item.kind), `已开始更新${item.name}。`);
  }

  function stop(item: Item) {
    if (!window.confirm(`取消更新${item.name}？当前合约下载完就停，已下载的部分保留，下次接着下。`)) return;
    void act(item.kind, () => cancel(), `正在取消更新${item.name}…`);
  }

  function erase(item: Item) {
    if (!window.confirm(`删除本地的全部${item.name}？\n\n删除后不能恢复，需要时再点「更新」重新下载` +
      `${item.days ? "" : "（这类数据只能等程序运行时重新记录）"}。\n数据库文件大小不会马上变小。`)) return;
    void act(item.kind, () => remove(item.kind), `已删除${item.name}。`);
  }

  if (mode === "unavailable") return <p className={styles.notice}>研究数据只在本机启动时可用。</p>;

  return (
    <div className={styles.section}>
      {error && <p className={`${styles.notice} ${styles.noticeBad}`} role="alert">读取研究数据失败：{error}。程序可能没在运行，或者正在启动。</p>}
      {mode === "loading" && !error && <p className={styles.notice} role="status">正在读取研究数据…</p>}
      {message && <p className={`${styles.notice} ${message.bad ? styles.noticeBad : ""}`} role="status">{message.text}</p>}
      {job && ["stopped", "failed", "interrupted"].includes(job.status) && job.error &&
        <p className={styles.notice} role="status">{job.label ? `${job.label}：` : ""}{job.error}</p>}
      <p className={styles.hint}>都是币安的公开数据，保存在本机的 .cache/market-monitor/monitor.history.sqlite。
        数量每分钟统计一次，更新或删除后会马上重新统计。同一时间只能更新一类数据。</p>

      {GROUPS.map((group) => (
        <section key={group.title} className={styles.card} aria-label={group.title}>
          <div className={styles.cardHeader}>
            <h3 className={styles.cardTitle}>{group.title}</h3>
            <span className={styles.cardMeta}>{group.note}</span>
          </div>
          <div className={styles.tableScroll}>
            <table className={`${styles.table} ${styles.catalog}`}>
              <thead><tr><th>数据</th><th>是什么</th><th>有多少</th><th>用来做什么</th><th>操作</th></tr></thead>
              <tbody>
                {group.items.map((item) => {
                  const active = runningKinds.includes(item.kind);
                  return <tr key={item.kind}>
                    <td className={styles.symbol}>{item.name}</td>
                    <td>{item.what}</td>
                    <td>{item.amount(summary)}
                      {active && <span className={styles.sub}>
                        更新中：{job?.done ?? 0} / {job?.total ?? 0} 个合约{job?.failedCount ? `，${job.failedCount} 个失败` : ""}
                      </span>}
                    </td>
                    <td>{item.use}</td>
                    <td>
                      <div className={styles.rowActions}>
                        {item.days ? (active
                          ? <button type="button" className={styles.button} onClick={() => stop(item)} disabled={busy !== null}>取消更新</button>
                          : <button type="button" className={styles.button} onClick={() => update(item)}
                            disabled={running || busy !== null || mode !== "local"}
                            title={running ? "正在更新其他数据，完成或取消后再更新" : item.scope}>更新</button>)
                          : <span className={styles.cardMeta}>自动记录</span>}
                        <button type="button" className={`${styles.button} ${styles.buttonDanger}`} onClick={() => erase(item)}
                          disabled={running || busy !== null || mode !== "local"}
                          title={running ? "正在更新数据，取消后才能删除" : undefined}>删除</button>
                      </div>
                      {item.scope && <span className={styles.sub}>{item.scope}</span>}
                    </td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

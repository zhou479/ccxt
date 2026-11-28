//! 本地历史行情缓存与市场数据存档（单独的 SQLite 文件，不和监控数据库混在一起）。
//!
//! - 缓存：历史扫描下载过的 1 分钟K线、5 分钟持仓量和资金费率，以及研究数据集的小时K线。已经收盘的历史数据不会再变，
//!   之后调整参数重新扫描时直接读本地，只下载缺的部分。每类数据按合约记录一段「已下载区间」。
//! - 存档：后台定期保存的标记价 / 指数价 / 资金费率快照、多空比，以及实时收到的强平单。
//!   币安的持仓量和多空比只保留约 30 天、强平推送没有历史，所以要自己存。

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::store::Result;

const MINUTE: i64 = 60_000;
const HOUR: i64 = 60 * MINUTE;

/// One finished candle. `end` is exclusive: the bar covers `[time, end)`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Bar {
    pub time: i64,
    pub end: i64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub quote: f64,
    pub taker_quote: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Kind {
    Klines,
    HourKlines,
    OpenInterest,
    Funding,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Klines => "kline_1m",
            Kind::HourKlines => "kline_1h",
            Kind::OpenInterest => "open_interest_5m",
            Kind::Funding => "funding",
        }
    }

    /// K线种类对应的表名和每根K线的时长。
    fn candles(self) -> Result<(&'static str, i64)> {
        match self {
            Kind::Klines => Ok(("kline_1m", MINUTE)),
            Kind::HourKlines => Ok(("kline_1h", HOUR)),
            Kind::OpenInterest | Kind::Funding => Err("not a candle kind".into()),
        }
    }
}

/// 研究数据集里的一个 USDⓈ-M 永续合约，包括已下架的。
#[derive(Clone, Debug, PartialEq)]
pub struct Contract {
    pub symbol: String,
    /// 上线时间；只在币安公开数据仓库里的合约没有这项。
    pub onboard: Option<i64>,
    /// 下架时间；仍在交易，或只在公开数据仓库里、尚未确定时为 `None`。
    pub delisted: Option<i64>,
    pub status: String,
}

/// A forced liquidation pushed by Binance. `side` is the order side: BUY closes a short.
#[derive(Clone, Debug, PartialEq)]
pub struct Liquidation {
    pub time: i64,
    pub symbol: String,
    pub side: String,
    pub price: f64,
    pub quantity: f64,
}

pub struct History {
    db: Mutex<Connection>,
    /// 统计数字要数上千万行，页面又会频繁刷新，所以缓存一段时间。
    status: Mutex<Option<(std::time::Instant, Value)>>,
    /// 后台正在重新数，避免同时开好几个。
    refreshing: std::sync::atomic::AtomicBool,
    /// 数据库文件位置，数数时另开一个只读连接，不占用主连接；内存数据库（测试）为 None。
    path: Option<std::path::PathBuf>,
}

/// 统计数字的缓存时长。
const STATUS_CACHE: std::time::Duration = std::time::Duration::from_secs(60);

impl History {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent().filter(|parent| !parent.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let db = Connection::open(path)?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "synchronous", "NORMAL")?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS kline_1m (
                symbol TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
                close REAL NOT NULL, quote REAL NOT NULL, taker REAL NOT NULL, PRIMARY KEY (symbol, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS kline_1h (
                symbol TEXT NOT NULL, time INTEGER NOT NULL, open REAL NOT NULL, high REAL NOT NULL, low REAL NOT NULL,
                close REAL NOT NULL, quote REAL NOT NULL, taker REAL NOT NULL, PRIMARY KEY (symbol, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS contract_list (
                symbol TEXT PRIMARY KEY, onboard INTEGER, delisted INTEGER, status TEXT NOT NULL
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS open_interest_5m (
                symbol TEXT NOT NULL, time INTEGER NOT NULL, value REAL NOT NULL, PRIMARY KEY (symbol, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS funding (
                symbol TEXT NOT NULL, time INTEGER NOT NULL, rate REAL NOT NULL, PRIMARY KEY (symbol, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS coverage (
                symbol TEXT NOT NULL, kind TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL,
                PRIMARY KEY (symbol, kind)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS premium_5m (
                symbol TEXT NOT NULL, time INTEGER NOT NULL, mark REAL NOT NULL, index_price REAL,
                funding_rate REAL, PRIMARY KEY (symbol, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS long_short_5m (
                symbol TEXT NOT NULL, kind TEXT NOT NULL, time INTEGER NOT NULL, ratio REAL NOT NULL,
                PRIMARY KEY (symbol, kind, time)
            ) WITHOUT ROWID;
            CREATE TABLE IF NOT EXISTS liquidation (
                time INTEGER NOT NULL, symbol TEXT NOT NULL, side TEXT NOT NULL, price REAL NOT NULL, quantity REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS liquidation_symbol_time ON liquidation (symbol, time);
            CREATE TABLE IF NOT EXISTS stream_session (
                id INTEGER PRIMARY KEY, start INTEGER NOT NULL, end INTEGER NOT NULL
            );",
        )?;
        let path = (path != Path::new(":memory:")).then(|| path.to_path_buf());
        Ok(Self { db: Mutex::new(db), status: Mutex::new(None), refreshing: std::sync::atomic::AtomicBool::new(false), path })
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.db.lock().map_err(|_| "history database lock poisoned".into())
    }

    /// The range already downloaded for a symbol, `[start, end)`.
    pub fn coverage(&self, symbol: &str, kind: Kind) -> Result<Option<(i64, i64)>> {
        Ok(self
            .db()?
            .query_row(
                "SELECT start, end FROM coverage WHERE symbol = ? AND kind = ?",
                params![symbol, kind.key()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?)
    }

    pub fn set_coverage(&self, symbol: &str, kind: Kind, start: i64, end: i64) -> Result<()> {
        self.db()?.execute(
            "INSERT INTO coverage VALUES (?, ?, ?, ?) ON CONFLICT(symbol, kind) DO UPDATE SET start = excluded.start, end = excluded.end",
            params![symbol, kind.key(), start, end],
        )?;
        Ok(())
    }

    #[cfg(test)]
    pub fn save_bars(&self, symbol: &str, bars: &[Bar]) -> Result<()> {
        self.save_candles(Kind::Klines, symbol, bars)
    }

    pub fn save_candles(&self, kind: Kind, symbol: &str, bars: &[Bar]) -> Result<()> {
        let (table, _) = kind.candles()?;
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached(&format!("INSERT OR REPLACE INTO {table} VALUES (?, ?, ?, ?, ?, ?, ?, ?)"))?;
            for bar in bars {
                insert.execute(params![symbol, bar.time, bar.open, bar.high, bar.low, bar.close, bar.quote, bar.taker_quote])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// One-minute bars starting in `[start, end)`, oldest first.
    #[cfg(test)]
    pub fn bars(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<Bar>> {
        self.candles(Kind::Klines, symbol, start, end)
    }

    /// 某种K线中开始时间在 `[start, end)` 的部分，按时间从早到晚。
    pub fn candles(&self, kind: Kind, symbol: &str, start: i64, end: i64) -> Result<Vec<Bar>> {
        let (table, length) = kind.candles()?;
        let db = self.db()?;
        let mut query = db.prepare_cached(&format!(
            "SELECT time, open, high, low, close, quote, taker FROM {table} WHERE symbol = ? AND time >= ? AND time < ? ORDER BY time",
        ))?;
        let rows = query.query_map(params![symbol, start, end], |row| {
            let time: i64 = row.get(0)?;
            Ok(Bar {
                time,
                end: time + length,
                open: row.get(1)?,
                high: row.get(2)?,
                low: row.get(3)?,
                close: row.get(4)?,
                quote: row.get(5)?,
                taker_quote: row.get(6)?,
            })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn save_points(&self, symbol: &str, kind: Kind, points: &[(i64, f64)]) -> Result<()> {
        let sql = match kind {
            Kind::OpenInterest => "INSERT OR REPLACE INTO open_interest_5m VALUES (?, ?, ?)",
            Kind::Funding => "INSERT OR REPLACE INTO funding VALUES (?, ?, ?)",
            Kind::Klines | Kind::HourKlines => return Err("bars are saved with save_candles".into()),
        };
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached(sql)?;
            for (time, value) in points {
                insert.execute(params![symbol, time, value])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Points recorded in `[start, end]`, oldest first.
    pub fn points(&self, symbol: &str, kind: Kind, start: i64, end: i64) -> Result<Vec<(i64, f64)>> {
        let sql = match kind {
            Kind::OpenInterest => "SELECT time, value FROM open_interest_5m WHERE symbol = ? AND time >= ? AND time <= ? ORDER BY time",
            Kind::Funding => "SELECT time, rate FROM funding WHERE symbol = ? AND time >= ? AND time <= ? ORDER BY time",
            Kind::Klines | Kind::HourKlines => return Err("bars are read with candles".into()),
        };
        let db = self.db()?;
        let mut query = db.prepare_cached(sql)?;
        let rows = query.query_map(params![symbol, start, end], |row| Ok((row.get(0)?, row.get(1)?)))?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// 用新的合约全集替换旧的。
    pub fn save_contracts(&self, contracts: &[Contract]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        tx.execute("DELETE FROM contract_list", [])?;
        {
            let mut insert = tx.prepare_cached("INSERT INTO contract_list VALUES (?, ?, ?, ?)")?;
            for contract in contracts {
                insert.execute(params![contract.symbol, contract.onboard, contract.delisted, contract.status])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn contracts(&self) -> Result<Vec<Contract>> {
        let db = self.db()?;
        let mut query = db.prepare_cached("SELECT symbol, onboard, delisted, status FROM contract_list ORDER BY symbol")?;
        let rows = query.query_map([], |row| {
            Ok(Contract { symbol: row.get(0)?, onboard: row.get(1)?, delisted: row.get(2)?, status: row.get(3)? })
        })?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    /// Mark price, index price and funding rate of every contract at one moment.
    pub fn save_premium(&self, time: i64, rows: &[(String, f64, Option<f64>, Option<f64>)]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO premium_5m VALUES (?, ?, ?, ?, ?)")?;
            for (symbol, mark, index, funding) in rows {
                insert.execute(params![symbol, time, mark, index, funding])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn save_long_short(&self, symbol: &str, kind: &str, points: &[(i64, f64)]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO long_short_5m VALUES (?, ?, ?, ?)")?;
            for (time, ratio) in points {
                insert.execute(params![symbol, kind, time, ratio])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    pub fn save_liquidations(&self, liquidations: &[Liquidation]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT INTO liquidation VALUES (?, ?, ?, ?, ?)")?;
            for liquidation in liquidations {
                insert.execute(params![
                    liquidation.time, liquidation.symbol, liquidation.side, liquidation.price, liquidation.quantity
                ])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Starts a liquidation stream session; extend it with `touch_session` while connected.
    pub fn start_session(&self, now: i64) -> Result<i64> {
        let db = self.db()?;
        db.execute("INSERT INTO stream_session (start, end) VALUES (?, ?)", params![now, now])?;
        Ok(db.last_insert_rowid())
    }

    pub fn touch_session(&self, id: i64, now: i64) -> Result<()> {
        self.db()?.execute("UPDATE stream_session SET end = ? WHERE id = ?", params![now, id])?;
        Ok(())
    }

    /// Liquidated value (USDT) in `[start, end)` closing shorts (BUY) and closing longs (SELL),
    /// or `None` when the stream was not connected for the whole range.
    pub fn liquidations(&self, symbol: &str, start: i64, end: i64) -> Result<Option<(f64, f64)>> {
        let db = self.db()?;
        let covered: bool = db.query_row(
            "SELECT EXISTS (SELECT 1 FROM stream_session WHERE start <= ? AND end >= ?)",
            params![start, end],
            |row| row.get(0),
        )?;
        if !covered {
            return Ok(None);
        }
        let (buy, sell): (f64, f64) = db.query_row(
            "SELECT COALESCE(SUM(CASE WHEN side = 'BUY' THEN price * quantity END), 0),
                    COALESCE(SUM(CASE WHEN side = 'SELL' THEN price * quantity END), 0)
             FROM liquidation WHERE symbol = ? AND time >= ? AND time < ?",
            params![symbol, start, end],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Some((buy, sell)))
    }

    /// 研究数据的时间范围：起点不算 BTC 为 200 日均线多下载的部分，终点是最后一根小时K线的结束时间。
    pub fn hour_range(&self) -> Result<(Option<i64>, Option<i64>)> {
        Ok(self.db()?.query_row(
            "SELECT MIN(CASE WHEN symbol != 'BTCUSDT' THEN time END), MAX(time) + 3600000 FROM kline_1h",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?)
    }

    /// 页面用的统计数字，不让页面等待：有旧结果就先返回旧的，过期了在后台重新数；
    /// 第一次没有结果时才在后台线程里数完再返回。数数要扫描上千万行，放在后台不会卡住其他请求。
    pub async fn status_in_background(self: &Arc<Self>) -> Option<Value> {
        let cached = self.status.lock().ok().and_then(|cache| cache.as_ref().map(|(at, value)| (at.elapsed() < STATUS_CACHE, value.clone())));
        match cached {
            Some((fresh, value)) => {
                if !fresh && !self.refreshing.swap(true, std::sync::atomic::Ordering::AcqRel) {
                    let history = Arc::clone(self);
                    tokio::task::spawn_blocking(move || {
                        let _ = history.refresh_status();
                        history.refreshing.store(false, std::sync::atomic::Ordering::Release);
                    });
                }
                Some(value)
            }
            None => {
                let history = Arc::clone(self);
                tokio::task::spawn_blocking(move || history.refresh_status().ok()).await.ok().flatten()
            }
        }
    }

    /// 数据有变动（更新完成、删除）时清掉缓存，下次读取会重新数。
    pub fn invalidate_status(&self) {
        if let Ok(mut cache) = self.status.lock() {
            *cache = None;
        }
    }

    /// 在一个事务里执行删除语句（研究数据「删除」用）。
    pub fn delete_rows(&self, statements: &[&str]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        for statement in statements {
            tx.execute(statement, [])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// 重新数一遍并更新缓存。
    fn refresh_status(&self) -> Result<Value> {
        let value = self.compute_status()?;
        if let Ok(mut cache) = self.status.lock() {
            *cache = Some((std::time::Instant::now(), value.clone()));
        }
        Ok(value)
    }

    /// 页面用的统计数字，最多缓存一分钟（同步版本，会等数完）。
    #[cfg(test)]
    pub fn status(&self) -> Result<Value> {
        let mut cache = self.status.lock().map_err(|_| "history status lock poisoned")?;
        if let Some((at, value)) = cache.as_ref() {
            if at.elapsed() < STATUS_CACHE {
                return Ok(value.clone());
            }
        }
        let value = self.compute_status()?;
        *cache = Some((std::time::Instant::now(), value.clone()));
        Ok(value)
    }

    /// 重新数一遍各类数据（要扫描整张表，较慢）。
    fn compute_status(&self) -> Result<Value> {
        match &self.path {
            Some(path) => {
                let reader = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
                reader.busy_timeout(std::time::Duration::from_secs(5))?;
                Self::count_all(&reader)
            }
            None => Self::count_all(&*self.db()?),
        }
    }

    fn count_all(db: &Connection) -> Result<Value> {
        let count = |sql: &str| -> rusqlite::Result<(i64, Option<i64>)> {
            db.query_row(sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
        };
        let premium = count("SELECT COUNT(DISTINCT time), MAX(time) FROM premium_5m")?;
        let liquidations = count("SELECT COUNT(*), MAX(time) FROM liquidation")?;
        let long_short = count("SELECT COUNT(DISTINCT symbol), MAX(time) FROM long_short_5m")?;
        let klines = count("SELECT COUNT(*), MAX(time) FROM kline_1m")?;
        let hours = count("SELECT COUNT(*), MAX(time) FROM kline_1h")?;
        let range: (Option<i64>, Option<i64>) = db.query_row(
            "SELECT MIN(CASE WHEN symbol != 'BTCUSDT' THEN time END), MAX(time) + 3600000 FROM kline_1h",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let funding = count("SELECT COUNT(*), MAX(time) FROM funding")?;
        let open_interest = count("SELECT COUNT(*), MAX(time) FROM open_interest_5m")?;
        let contracts = count("SELECT COUNT(*), MAX(delisted) FROM contract_list")?;
        let delisted = count("SELECT COUNT(*), MAX(delisted) FROM contract_list WHERE status != 'TRADING'")?;
        let session = count("SELECT COUNT(*), MAX(end) FROM stream_session")?;
        Ok(json!({
            "premiumSnapshots": premium.0, "premiumAt": premium.1,
            "liquidations": liquidations.0, "liquidationAt": liquidations.1,
            "longShortSymbols": long_short.0, "longShortAt": long_short.1,
            "cachedBars": klines.0,
            "hourBars": hours.0, "fundingPoints": funding.0, "openInterestPoints": open_interest.0,
            "cachedBarsAt": klines.1,
            "hourFrom": range.0, "hourTo": range.1,
            "contracts": contracts.0, "delistedContracts": delisted.0,
            "streamAt": session.1,
        }))
    }
}

/// Parts of `[start, end)` outside the downloaded range. The range stays one interval, so a request
/// that does not touch it also fetches the gap in between.
pub fn missing(coverage: Option<(i64, i64)>, start: i64, end: i64) -> Vec<(i64, i64)> {
    if start >= end {
        return Vec::new();
    }
    let Some((from, to)) = coverage else {
        return vec![(start, end)];
    };
    let mut parts = Vec::new();
    if start < from {
        parts.push((start, from));
    }
    if end > to {
        parts.push((to, end));
    }
    parts
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_ranges_extend_the_downloaded_interval() {
        assert_eq!(missing(None, 0, 10), vec![(0, 10)]);
        assert_eq!(missing(Some((5, 8)), 0, 10), vec![(0, 5), (8, 10)]);
        assert_eq!(missing(Some((0, 10)), 2, 8), Vec::<(i64, i64)>::new());
        // A request after the range also fills the gap, keeping a single interval.
        assert_eq!(missing(Some((0, 10)), 20, 30), vec![(10, 30)]);
    }

    #[test]
    fn bars_points_and_liquidations_round_trip() {
        let history = History::open_memory().unwrap();
        let bar = |time| Bar { time, end: time + MINUTE, open: 1.0, high: 2.0, low: 0.5, close: 1.5, quote: 10.0, taker_quote: 6.0 };
        history.save_bars("BTCUSDT", &[bar(0), bar(MINUTE), bar(2 * MINUTE)]).unwrap();
        history.save_bars("BTCUSDT", &[bar(MINUTE)]).unwrap();
        assert_eq!(history.bars("BTCUSDT", 0, 2 * MINUTE).unwrap(), vec![bar(0), bar(MINUTE)]);
        history.set_coverage("BTCUSDT", Kind::Klines, 0, 3 * MINUTE).unwrap();
        assert_eq!(history.coverage("BTCUSDT", Kind::Klines).unwrap(), Some((0, 3 * MINUTE)));
        assert_eq!(history.coverage("BTCUSDT", Kind::Funding).unwrap(), None);
        let hour = Bar { time: 0, end: HOUR, ..bar(0) };
        history.save_candles(Kind::HourKlines, "BTCUSDT", &[hour]).unwrap();
        assert_eq!(history.candles(Kind::HourKlines, "BTCUSDT", 0, HOUR).unwrap(), vec![hour]);
        assert_eq!(history.bars("BTCUSDT", 0, 2 * MINUTE).unwrap().len(), 2);
        let listed = Contract { symbol: "OMGUSDT".into(), onboard: Some(1), delisted: Some(5), status: "SETTLING".into() };
        history.save_contracts(&[listed.clone()]).unwrap();
        assert_eq!(history.contracts().unwrap(), vec![listed]);
        history.save_points("BTCUSDT", Kind::OpenInterest, &[(0, 5.0), (300_000, 6.0)]).unwrap();
        assert_eq!(history.points("BTCUSDT", Kind::OpenInterest, 0, 300_000).unwrap().len(), 2);

        let liquidation = |time, side: &str| Liquidation { time, symbol: "BTCUSDT".into(), side: side.into(), price: 100.0, quantity: 2.0 };
        history.save_liquidations(&[liquidation(1_000, "BUY"), liquidation(2_000, "SELL"), liquidation(9_000, "BUY")]).unwrap();
        // Without a stream session covering the range there is no answer, not zero.
        assert_eq!(history.liquidations("BTCUSDT", 0, 5_000).unwrap(), None);
        let session = history.start_session(0).unwrap();
        history.touch_session(session, 10_000).unwrap();
        assert_eq!(history.liquidations("BTCUSDT", 0, 5_000).unwrap(), Some((200.0, 200.0)));
        assert_eq!(history.status().unwrap()["liquidations"], 3);
        // 研究数据的起点不算 BTC 为均线多下载的部分，终点是最后一根小时K线的结束时间。
        history.save_candles(Kind::HourKlines, "ETHUSDT", &[Bar { time: 5 * HOUR, end: 6 * HOUR, ..bar(0) }]).unwrap();
        // 统计数字有一分钟缓存：缓存里还是保存 ETH 之前的结果，重新数才是新的。
        assert_eq!(history.status().unwrap()["hourFrom"], Value::Null);
        let status = history.compute_status().unwrap();
        assert_eq!(status["hourFrom"], 5 * HOUR);
        assert_eq!(status["hourTo"], 6 * HOUR);
    }
}

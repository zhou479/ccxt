//! 本地历史行情缓存与市场数据存档（单独的 SQLite 文件，不和监控数据库混在一起）。
//!
//! - 缓存：历史扫描下载过的 1 分钟K线、5 分钟持仓量和资金费率。已经收盘的历史数据不会再变，
//!   之后调整参数重新扫描时直接读本地，只下载缺的部分。每类数据按合约记录一段「已下载区间」。
//! - 存档：后台定期保存的标记价 / 指数价 / 资金费率快照、多空比，以及实时收到的强平单。
//!   币安的持仓量和多空比只保留约 30 天、强平推送没有历史，所以要自己存。

use std::path::Path;
use std::sync::Mutex;

use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::store::Result;

const MINUTE: i64 = 60_000;

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
    OpenInterest,
    Funding,
}

impl Kind {
    fn key(self) -> &'static str {
        match self {
            Kind::Klines => "kline_1m",
            Kind::OpenInterest => "open_interest_5m",
            Kind::Funding => "funding",
        }
    }
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

pub struct History(Mutex<Connection>);

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
        Ok(Self(Mutex::new(db)))
    }

    #[cfg(test)]
    pub fn open_memory() -> Result<Self> {
        Self::open(Path::new(":memory:"))
    }

    fn db(&self) -> Result<std::sync::MutexGuard<'_, Connection>> {
        self.0.lock().map_err(|_| "history database lock poisoned".into())
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

    pub fn save_bars(&self, symbol: &str, bars: &[Bar]) -> Result<()> {
        let mut db = self.db()?;
        let tx = db.transaction()?;
        {
            let mut insert = tx.prepare_cached("INSERT OR REPLACE INTO kline_1m VALUES (?, ?, ?, ?, ?, ?, ?, ?)")?;
            for bar in bars {
                insert.execute(params![symbol, bar.time, bar.open, bar.high, bar.low, bar.close, bar.quote, bar.taker_quote])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// One-minute bars starting in `[start, end)`, oldest first.
    pub fn bars(&self, symbol: &str, start: i64, end: i64) -> Result<Vec<Bar>> {
        let db = self.db()?;
        let mut query = db.prepare_cached(
            "SELECT time, open, high, low, close, quote, taker FROM kline_1m WHERE symbol = ? AND time >= ? AND time < ? ORDER BY time",
        )?;
        let rows = query.query_map(params![symbol, start, end], |row| {
            let time: i64 = row.get(0)?;
            Ok(Bar {
                time,
                end: time + MINUTE,
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
            Kind::Klines => return Err("bars are saved with save_bars".into()),
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
            Kind::Klines => return Err("bars are read with bars".into()),
        };
        let db = self.db()?;
        let mut query = db.prepare_cached(sql)?;
        let rows = query.query_map(params![symbol, start, end], |row| Ok((row.get(0)?, row.get(1)?)))?;
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

    /// Counts and latest times for the page.
    pub fn status(&self) -> Result<Value> {
        let db = self.db()?;
        let count = |sql: &str| -> rusqlite::Result<(i64, Option<i64>)> {
            db.query_row(sql, [], |row| Ok((row.get(0)?, row.get(1)?)))
        };
        let premium = count("SELECT COUNT(DISTINCT time), MAX(time) FROM premium_5m")?;
        let liquidations = count("SELECT COUNT(*), MAX(time) FROM liquidation")?;
        let long_short = count("SELECT COUNT(DISTINCT symbol), MAX(time) FROM long_short_5m")?;
        let klines = count("SELECT COUNT(*), MAX(time) FROM kline_1m")?;
        let session = count("SELECT COUNT(*), MAX(end) FROM stream_session")?;
        Ok(json!({
            "premiumSnapshots": premium.0, "premiumAt": premium.1,
            "liquidations": liquidations.0, "liquidationAt": liquidations.1,
            "longShortSymbols": long_short.0, "longShortAt": long_short.1,
            "cachedBars": klines.0,
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
    }
}

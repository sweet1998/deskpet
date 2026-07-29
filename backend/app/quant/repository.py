import asyncio
from datetime import date
import json
import os
from typing import Any, Dict, Iterable, List, Optional

import duckdb
import pandas as pd


SCHEMA = """
CREATE TABLE IF NOT EXISTS instruments (
    instrument_id VARCHAR PRIMARY KEY,
    symbol VARCHAR NOT NULL,
    name VARCHAR NOT NULL,
    industry VARCHAR,
    market VARCHAR,
    list_date DATE,
    list_status VARCHAR,
    valid_from DATE,
    valid_to DATE,
    source VARCHAR NOT NULL,
    updated_at TIMESTAMP NOT NULL
);
CREATE TABLE IF NOT EXISTS daily_prices (
    instrument_id VARCHAR NOT NULL,
    trade_date DATE NOT NULL,
    open DOUBLE,
    high DOUBLE,
    low DOUBLE,
    close DOUBLE,
    pre_close DOUBLE,
    pct_change DOUBLE,
    volume DOUBLE,
    amount DOUBLE,
    source VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS daily_valuations (
    instrument_id VARCHAR NOT NULL,
    trade_date DATE NOT NULL,
    turnover_rate DOUBLE,
    pe_ttm DOUBLE,
    pb DOUBLE,
    total_market_cap DOUBLE,
    float_market_cap DOUBLE,
    source VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL,
    PRIMARY KEY (instrument_id, trade_date)
);
CREATE TABLE IF NOT EXISTS financial_periods (
    instrument_id VARCHAR NOT NULL,
    report_date DATE NOT NULL,
    announced_at DATE NOT NULL,
    eps DOUBLE,
    revenue DOUBLE,
    revenue_yoy DOUBLE,
    net_profit DOUBLE,
    net_profit_yoy DOUBLE,
    roe DOUBLE,
    gross_margin DOUBLE,
    net_margin DOUBLE,
    debt_ratio DOUBLE,
    operating_cash_flow_per_share DOUBLE,
    source_record_id VARCHAR NOT NULL,
    source VARCHAR NOT NULL,
    ingested_at TIMESTAMP NOT NULL,
    PRIMARY KEY (instrument_id, report_date, announced_at, source_record_id)
);
CREATE TABLE IF NOT EXISTS factor_snapshots (
    instrument_id VARCHAR NOT NULL,
    as_of DATE NOT NULL,
    style VARCHAR NOT NULL,
    quality DOUBLE,
    growth DOUBLE,
    value DOUBLE,
    momentum DOUBLE,
    risk DOUBLE,
    composite DOUBLE NOT NULL,
    coverage DOUBLE NOT NULL,
    confidence VARCHAR NOT NULL,
    rank INTEGER,
    industry_rank INTEGER,
    factor_version VARCHAR NOT NULL,
    calculated_at TIMESTAMP NOT NULL,
    PRIMARY KEY (instrument_id, as_of, style, factor_version)
);
CREATE TABLE IF NOT EXISTS backtest_runs (
    run_id VARCHAR PRIMARY KEY,
    style VARCHAR NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    parameters JSON NOT NULL,
    result JSON NOT NULL,
    factor_version VARCHAR NOT NULL,
    created_at TIMESTAMP NOT NULL
);
"""


def _records(cursor: duckdb.DuckDBPyConnection) -> List[Dict[str, Any]]:
    names = [item[0] for item in cursor.description or []]
    return [dict(zip(names, row)) for row in cursor.fetchall()]


class QuantRepository:
    def __init__(self, path: str):
        if not path:
            raise ValueError("QUANT_DB_PATH 未配置")
        self.path = os.path.abspath(path)
        self._lock = asyncio.Lock()

    def _connect(self) -> duckdb.DuckDBPyConnection:
        os.makedirs(os.path.dirname(self.path) or ".", exist_ok=True)
        return duckdb.connect(self.path)

    async def start(self) -> None:
        def initialize() -> None:
            with self._connect() as connection:
                connection.execute(SCHEMA)

        async with self._lock:
            await asyncio.to_thread(initialize)

    async def upsert_instruments(self, rows: Iterable[Dict[str, Any]]) -> int:
        values = [(
            row["instrumentId"], row["symbol"], row["name"], row.get("industry"),
            row.get("market"), row.get("listDate"), row.get("listStatus"),
            row.get("validFrom") or row.get("listDate"), row.get("validTo"),
            row.get("source") or "unknown", row["ingestedAt"],
        ) for row in rows]
        if not values:
            return 0

        def write() -> None:
            with self._connect() as connection:
                connection.executemany("""
                    INSERT INTO instruments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (instrument_id) DO UPDATE SET
                        symbol=excluded.symbol, name=excluded.name, industry=excluded.industry,
                        market=excluded.market, list_date=excluded.list_date,
                        list_status=excluded.list_status, valid_from=excluded.valid_from,
                        valid_to=excluded.valid_to, source=excluded.source,
                        updated_at=excluded.updated_at
                """, values)

        async with self._lock:
            await asyncio.to_thread(write)
        return len(values)

    async def upsert_daily_prices(self, rows: Iterable[Dict[str, Any]]) -> int:
        values = [(
            row["instrumentId"], row["tradeDate"], row.get("open"), row.get("high"),
            row.get("low"), row.get("close"), row.get("preClose"), row.get("pctChange"),
            row.get("volume"), row.get("amount"), row.get("source") or "unknown",
            row["ingestedAt"],
        ) for row in rows]
        if not values:
            return 0

        def write() -> None:
            with self._connect() as connection:
                batch = pd.DataFrame(values, columns=[
                    "instrument_id", "trade_date", "open", "high", "low", "close",
                    "pre_close", "pct_change", "volume", "amount", "source", "ingested_at",
                ])
                connection.register("daily_price_batch", batch)
                connection.execute("""
                    INSERT INTO daily_prices SELECT * FROM daily_price_batch
                    ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
                        open=excluded.open, high=excluded.high, low=excluded.low,
                        close=excluded.close, pre_close=excluded.pre_close,
                        pct_change=excluded.pct_change, volume=excluded.volume,
                        amount=excluded.amount, source=excluded.source,
                        ingested_at=excluded.ingested_at
                """)
                connection.unregister("daily_price_batch")

        async with self._lock:
            await asyncio.to_thread(write)
        return len(values)

    async def upsert_daily_valuations(self, rows: Iterable[Dict[str, Any]]) -> int:
        values = [(
            row["instrumentId"], row["tradeDate"], row.get("turnoverRate"),
            row.get("peTtm"), row.get("pb"), row.get("totalMarketCap"),
            row.get("floatMarketCap"), row.get("source") or "unknown", row["ingestedAt"],
        ) for row in rows]
        if not values:
            return 0

        def write() -> None:
            with self._connect() as connection:
                connection.executemany("""
                    INSERT INTO daily_valuations VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (instrument_id, trade_date) DO UPDATE SET
                        turnover_rate=excluded.turnover_rate, pe_ttm=excluded.pe_ttm,
                        pb=excluded.pb, total_market_cap=excluded.total_market_cap,
                        float_market_cap=excluded.float_market_cap,
                        source=excluded.source, ingested_at=excluded.ingested_at
                """, values)

        async with self._lock:
            await asyncio.to_thread(write)
        return len(values)

    async def upsert_financial_periods(self, rows: Iterable[Dict[str, Any]]) -> int:
        values = [(
            row["instrumentId"], row["reportDate"], row["announcedAt"], row.get("eps"),
            row.get("revenue"), row.get("revenueYoY"), row.get("netProfit"),
            row.get("netProfitYoY"), row.get("roe"), row.get("grossMargin"),
            row.get("netMargin"), row.get("debtRatio"),
            row.get("operatingCashFlowPerShare"), row["sourceRecordId"],
            row.get("source") or "unknown", row["ingestedAt"],
        ) for row in rows if row.get("announcedAt")]
        if not values:
            return 0

        def write() -> None:
            with self._connect() as connection:
                connection.executemany("""
                    INSERT INTO financial_periods VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (instrument_id, report_date, announced_at, source_record_id)
                    DO UPDATE SET eps=excluded.eps, revenue=excluded.revenue,
                        revenue_yoy=excluded.revenue_yoy, net_profit=excluded.net_profit,
                        net_profit_yoy=excluded.net_profit_yoy, roe=excluded.roe,
                        gross_margin=excluded.gross_margin, net_margin=excluded.net_margin,
                        debt_ratio=excluded.debt_ratio,
                        operating_cash_flow_per_share=excluded.operating_cash_flow_per_share,
                        source=excluded.source, ingested_at=excluded.ingested_at
                """, values)

        async with self._lock:
            await asyncio.to_thread(write)
        return len(values)

    async def summary(self) -> Dict[str, Any]:
        def read() -> Dict[str, Any]:
            with self._connect() as connection:
                row = connection.execute("""
                    SELECT
                        (SELECT count(*) FROM instruments) AS instruments,
                        (SELECT count(*) FROM daily_prices) AS price_rows,
                        (SELECT count(DISTINCT trade_date) FROM daily_prices) AS trading_days,
                        (SELECT min(trade_date) FROM daily_prices) AS price_from,
                        (SELECT max(trade_date) FROM daily_prices) AS price_to,
                        (SELECT count(*) FROM daily_valuations) AS valuation_rows,
                        (SELECT count(*) FROM financial_periods) AS financial_rows,
                        (SELECT count(*) FROM factor_snapshots) AS factor_rows,
                        (SELECT count(*) FROM backtest_runs) AS backtest_runs
                """).fetchone()
                names = [item[0] for item in connection.description]
                return dict(zip(names, row))

        async with self._lock:
            result = await asyncio.to_thread(read)
        return {
            key: value.isoformat() if isinstance(value, date) else value
            for key, value in result.items()
        }

    async def trading_dates(self, start_date: str, end_date: str) -> List[str]:
        def read() -> List[str]:
            with self._connect() as connection:
                rows = connection.execute("""
                    SELECT DISTINCT trade_date FROM daily_prices
                    WHERE trade_date BETWEEN ? AND ? ORDER BY trade_date
                """, [start_date, end_date]).fetchall()
                return [row[0].isoformat() for row in rows]

        async with self._lock:
            return await asyncio.to_thread(read)

    async def prices_between(self, start_date: str, end_date: str) -> List[Dict[str, Any]]:
        def read() -> List[Dict[str, Any]]:
            with self._connect() as connection:
                return _records(connection.execute("""
                    SELECT instrument_id, trade_date, open, close, pct_change
                    FROM daily_prices WHERE trade_date BETWEEN ? AND ?
                    ORDER BY trade_date, instrument_id
                """, [start_date, end_date]))

        async with self._lock:
            rows = await asyncio.to_thread(read)
        for row in rows:
            row["trade_date"] = row["trade_date"].isoformat()
        return rows

    async def price_history(self, as_of: str, points: int = 130) -> List[Dict[str, Any]]:
        def read() -> List[Dict[str, Any]]:
            with self._connect() as connection:
                return _records(connection.execute("""
                    WITH ranked AS (
                        SELECT p.*, i.name, i.industry, i.list_status,
                            row_number() OVER (
                                PARTITION BY p.instrument_id ORDER BY p.trade_date DESC
                            ) AS row_num
                        FROM daily_prices p
                        JOIN instruments i USING (instrument_id)
                        WHERE p.trade_date <= ?
                          AND (i.valid_from IS NULL OR i.valid_from <= ?)
                          AND (i.valid_to IS NULL OR i.valid_to >= ?)
                    )
                    SELECT * EXCLUDE (row_num) FROM ranked
                    WHERE row_num <= ? ORDER BY instrument_id, trade_date
                """, [as_of, as_of, as_of, points]))

        async with self._lock:
            rows = await asyncio.to_thread(read)
        for row in rows:
            row["trade_date"] = row["trade_date"].isoformat()
            row["ingested_at"] = row["ingested_at"].isoformat()
        return rows

    async def valuations_as_of(self, as_of: str) -> Dict[str, Dict[str, Any]]:
        def read() -> List[Dict[str, Any]]:
            with self._connect() as connection:
                return _records(connection.execute("""
                    SELECT * EXCLUDE (row_num) FROM (
                        SELECT *, row_number() OVER (
                            PARTITION BY instrument_id ORDER BY trade_date DESC
                        ) AS row_num
                        FROM daily_valuations WHERE trade_date <= ?
                    ) WHERE row_num = 1
                """, [as_of]))

        async with self._lock:
            rows = await asyncio.to_thread(read)
        return {row["instrument_id"]: row for row in rows}

    async def financials_as_of(self, as_of: str) -> Dict[str, Dict[str, Any]]:
        def read() -> List[Dict[str, Any]]:
            with self._connect() as connection:
                return _records(connection.execute("""
                    SELECT * EXCLUDE (row_num) FROM (
                        SELECT *, row_number() OVER (
                            PARTITION BY instrument_id
                            ORDER BY report_date DESC, announced_at DESC
                        ) AS row_num
                        FROM financial_periods WHERE announced_at <= ?
                    ) WHERE row_num = 1
                """, [as_of]))

        async with self._lock:
            rows = await asyncio.to_thread(read)
        return {row["instrument_id"]: row for row in rows}

    async def save_factor_snapshot(
        self,
        as_of: str,
        style: str,
        factor_version: str,
        rows: Iterable[Dict[str, Any]],
    ) -> int:
        values = [(
            row["instrumentId"], as_of, style, row.get("quality"), row.get("growth"),
            row.get("value"), row.get("momentum"), row.get("risk"), row["score"],
            row["coverage"], row["confidence"], row.get("rank"), row.get("industryRank"),
            factor_version, row["calculatedAt"],
        ) for row in rows]
        if not values:
            return 0

        def write() -> None:
            with self._connect() as connection:
                connection.execute(
                    "DELETE FROM factor_snapshots WHERE as_of=? AND style=? AND factor_version=?",
                    [as_of, style, factor_version],
                )
                connection.executemany(
                    "INSERT INTO factor_snapshots VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    values,
                )

        async with self._lock:
            await asyncio.to_thread(write)
        return len(values)

    async def save_backtest(self, run: Dict[str, Any]) -> None:
        def write() -> None:
            with self._connect() as connection:
                connection.execute(
                    "INSERT OR REPLACE INTO backtest_runs VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                    [
                        run["runId"], run["style"], run["startDate"], run["endDate"],
                        json.dumps(run["parameters"], ensure_ascii=False),
                        json.dumps(run["result"], ensure_ascii=False),
                        run["factorVersion"], run["createdAt"],
                    ],
                )

        async with self._lock:
            await asyncio.to_thread(write)

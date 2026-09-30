import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Board, Market } from "./qlib.js";

/**
 * 本地日K库（单文件 SQLite，`node:sqlite`，零新增依赖）。
 *
 * 口径（ADR-0004）：
 * - **存不复权价**，同时存 `adj_factor`；指标一律用 `不复权价 × 因子`（后复权序列）计算。
 *   后复权是**追加稳定**的——追加今天永远不改昨天；前复权不是（每次除权都会追溯改写全部历史，
 *   会静默作废已算好的指标与缓存）。
 * - 日期用 `YYYYMMDD` 整数、代码用 6 位数字，配合 `WITHOUT ROWID` 主键把体积压到约 70 B/行。
 * - 该库是**可再生的构建产物**，不进版本库。
 */

export const SCHEMA_VERSION = "1";

export type InstrumentRow = {
  code: string;
  market: Market;
  board: Board;
  /** 名称来自行情快照（归档里没有），bootstrap 阶段为 null */
  name: string | null;
  /** 数据起始日（`YYYYMMDD`）：近似上市日 */
  listedStart: number;
  /** 数据截止日（`YYYYMMDD`） */
  listedEnd: number;
  /** 截止日等于库内最新交易日 → 仍在交易 */
  isLive: boolean;
};

export type BarRow = {
  date: number;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（手），不复权口径 */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 复权因子：后复权价 = 不复权价 × adjFactor */
  adjFactor: number;
};

export type StoredBar = BarRow & { code: string };

/** 指数只需 OHLCV（指数不做复权）。 */
export type IndexBarRow = Omit<BarRow, "amount" | "adjFactor">;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS instruments (
  code         TEXT PRIMARY KEY,
  market       TEXT NOT NULL,
  board        TEXT NOT NULL,
  name         TEXT,
  listed_start INTEGER NOT NULL,
  listed_end   INTEGER NOT NULL,
  is_live      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_instruments_board ON instruments(board);
CREATE INDEX IF NOT EXISTS idx_instruments_live  ON instruments(is_live);

CREATE TABLE IF NOT EXISTS bars (
  code       TEXT    NOT NULL,
  date       INTEGER NOT NULL,
  open       REAL    NOT NULL,
  high       REAL    NOT NULL,
  low        REAL    NOT NULL,
  close      REAL    NOT NULL,
  volume     REAL    NOT NULL,
  amount     REAL    NOT NULL,
  adj_factor REAL    NOT NULL,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS index_bars (
  code   TEXT    NOT NULL,
  date   INTEGER NOT NULL,
  open   REAL    NOT NULL,
  high   REAL    NOT NULL,
  low    REAL    NOT NULL,
  close  REAL    NOT NULL,
  volume REAL    NOT NULL,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS valuation (
  code       TEXT    NOT NULL,
  date       INTEGER NOT NULL,
  close      REAL,
  pe_ttm     REAL,
  pb_mrq     REAL,
  ps_ttm     REAL,
  board_name TEXT,
  PRIMARY KEY (code, date)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

type RawBar = Record<string, number>;

export class MarketStore {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  constructor(readonly path: string) {
    this.db = new DatabaseSync(path);
  }

  /** 建表（幂等）。 */
  migrate(): void {
    this.db.exec(SCHEMA);
    this.setMeta("schema_version", SCHEMA_VERSION);
  }

  /**
   * bootstrap 专用加速：牺牲崩溃安全性换写入速度。
   * 库是可再生的构建产物，写坏了重跑一次即可，不值得为瞬时故障付出几倍写入时间。
   * `journal_mode = OFF` 还顺带把回滚日志从内存里去掉——全市场数百万行的单批写入
   * 若把日志留在内存会明显吃内存。
   */
  optimizeForBulkLoad(): void {
    this.db.exec("PRAGMA journal_mode = OFF");
    this.db.exec("PRAGMA synchronous = OFF");
  }

  /** 写入完成后恢复常规耐久性设置。 */
  restoreDurability(): void {
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA journal_mode = WAL");
  }

  private prepare(sql: string): StatementSync {
    let stmt = this.statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.statements.set(sql, stmt);
    }
    return stmt;
  }

  /** 在一个事务里执行；大批量写入必须走这里，否则每行一次 fsync。 */
  transaction<T>(fn: () => T): T {
    this.begin();
    try {
      const result = fn();
      this.commit();
      return result;
    } catch (err) {
      this.rollback();
      throw err;
    }
  }

  /**
   * 显式事务控制：bootstrap 要按批提交（数百万行塞进单个事务会把回滚日志撑大），
   * 而每批之间不能中断——所以需要把「开/提交」拆开暴露给调用方。
   */
  begin(): void {
    this.db.exec("BEGIN");
  }

  commit(): void {
    this.db.exec("COMMIT");
  }

  rollback(): void {
    this.db.exec("ROLLBACK");
  }

  upsertInstruments(rows: readonly InstrumentRow[]): void {
    const stmt = this.prepare(
      `INSERT INTO instruments (code, market, board, name, listed_start, listed_end, is_live)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         market = excluded.market, board = excluded.board,
         name = COALESCE(excluded.name, instruments.name),
         listed_start = MIN(excluded.listed_start, instruments.listed_start),
         listed_end = MAX(excluded.listed_end, instruments.listed_end),
         is_live = excluded.is_live`,
    );
    for (const row of rows) {
      stmt.run(
        row.code,
        row.market,
        row.board,
        row.name,
        row.listedStart,
        row.listedEnd,
        row.isLive ? 1 : 0,
      );
    }
  }

  /**
   * 列出全部标的的基础信息（约六千行，可整批载入）。
   * 筛选器据此逐只读日线，而不是一次性把所有日线都读进内存。
   */
  listInstruments(): InstrumentRow[] {
    const rows = this.prepare(
      `SELECT code, market, board, name,
              listed_start AS listedStart, listed_end AS listedEnd, is_live AS isLive
       FROM instruments ORDER BY code`,
    ).all() as unknown as Array<Omit<InstrumentRow, "isLive"> & { isLive: number }>;
    return rows.map((row) => ({ ...row, isLive: row.isLive === 1 }));
  }

  readInstrument(code: string): InstrumentRow | null {    const row = this.prepare(
      `SELECT code, market, board, name,
              listed_start AS listedStart, listed_end AS listedEnd, is_live AS isLive
       FROM instruments WHERE code = ?`,
    ).get(code) as (Omit<InstrumentRow, "isLive"> & { isLive: number }) | undefined;
    if (!row) return null;
    return { ...row, isLive: row.isLive === 1 };
  }

  insertBars(code: string, bars: readonly BarRow[]): void {
    const stmt = this.prepare(
      `INSERT INTO bars (code, date, open, high, low, close, volume, amount, adj_factor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, date) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low, close = excluded.close,
         volume = excluded.volume, amount = excluded.amount, adj_factor = excluded.adj_factor`,
    );
    for (const bar of bars) {
      stmt.run(code, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount, bar.adjFactor);
    }
  }

  insertIndexBars(code: string, bars: readonly IndexBarRow[]): void {
    const stmt = this.prepare(
      `INSERT INTO index_bars (code, date, open, high, low, close, volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, date) DO UPDATE SET
         open = excluded.open, high = excluded.high, low = excluded.low,
         close = excluded.close, volume = excluded.volume`,
    );
    for (const bar of bars) {
      stmt.run(code, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume);
    }
  }

  /** 按日期升序读某只标的的最近 `limit` 根（不复权口径）。 */
  readBars(code: string, limit?: number): BarRow[] {
    if (limit === undefined) {
      return this.prepare(
        `SELECT date, open, high, low, close, volume, amount, adj_factor AS adjFactor
         FROM bars WHERE code = ? ORDER BY date`,
      ).all(code) as unknown as BarRow[];
    }
    // 先按日期倒序取 N 根，再翻回升序，避免全表扫描后切片
    const rows = this.prepare(
      `SELECT date, open, high, low, close, volume, amount, adj_factor AS adjFactor
       FROM bars WHERE code = ? ORDER BY date DESC LIMIT ?`,
    ).all(code, limit) as unknown as BarRow[];
    return rows.reverse();
  }

  readIndexBars(code: string, limit?: number): IndexBarRow[] {
    if (limit === undefined) {
      return this.prepare(
        `SELECT date, open, high, low, close, volume FROM index_bars WHERE code = ? ORDER BY date`,
      ).all(code) as unknown as IndexBarRow[];
    }
    const rows = this.prepare(
      `SELECT date, open, high, low, close, volume FROM index_bars
       WHERE code = ? ORDER BY date DESC LIMIT ?`,
    ).all(code, limit) as unknown as IndexBarRow[];
    return rows.reverse();
  }

  countBars(): number {
    const row = this.prepare("SELECT COUNT(*) AS n FROM bars").get() as RawBar | undefined;
    return row?.n ?? 0;
  }

  countInstruments(board?: Board, liveOnly = false): number {
    const where: string[] = [];
    const params: string[] = [];
    if (board !== undefined) {
      where.push("board = ?");
      params.push(board);
    }
    if (liveOnly) where.push("is_live = 1");
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";
    const row = this.prepare(`SELECT COUNT(*) AS n FROM instruments${clause}`).get(...params) as
      | RawBar
      | undefined;
    return row?.n ?? 0;
  }

  /**
   * 抽样取仍在交易的个股代码，用于全市场自检。
   * 按等距跨步取样而不是取前 N 个：代码是有序的，取前 N 个会全部落在深市 000 段。
   */
  sampleLiveCodes(limit: number): string[] {
    const all = this.prepare(
      `SELECT code FROM instruments WHERE is_live = 1 AND board <> 'index' ORDER BY code`,
    ).all() as unknown as Array<{ code: string }>;
    if (all.length <= limit) return all.map((row) => row.code);

    const stride = all.length / limit;
    const out: string[] = [];
    for (let i = 0; i < limit; i++) out.push((all[Math.floor(i * stride)] as { code: string }).code);
    return out;
  }

  /** 库内最新的交易日；空库返回 null。 */
  latestTradeDate(): number | null {
    const row = this.prepare("SELECT MAX(date) AS d FROM bars").get() as RawBar | undefined;
    return row?.d ?? null;
  }

  setMeta(key: string, value: string): void {
    this.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, value);
  }

  getMeta(key: string): string | null {
    const row = this.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /** 幂等关闭：重复调用不抛错（进程收尾路径常常与显式关闭重叠）。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.statements.clear();
    this.db.close();
  }

  private closed = false;
}

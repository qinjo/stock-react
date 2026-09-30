import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { Board, Market } from "./qlib.js";
import type { ValuationRow } from "./valuation.js";

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

export const SCHEMA_VERSION = "2";

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
  /** 最新流通市值（元）；未接过行情快照时为 null */
  floatMarketCap?: number | null;
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
  code             TEXT PRIMARY KEY,
  market           TEXT NOT NULL,
  board            TEXT NOT NULL,
  name             TEXT,
  listed_start     INTEGER NOT NULL,
  listed_end       INTEGER NOT NULL,
  is_live          INTEGER NOT NULL,
  -- 最新流通市值（元）：来自行情快照，随每日增量刷新。
  -- 它是时点属性，筛选器的市值闸门只关心"现在"，故不按日期存历史。
  float_market_cap REAL
);
CREATE INDEX IF NOT EXISTS idx_instruments_board ON instruments(board);
CREATE INDEX IF NOT EXISTS idx_instruments_live  ON instruments(is_live);

-- 交易日历：来自指数日线（真实交易日，不需要猜节假日）。
-- 两个用途：判定"库内最新日"与"快照日"是否相邻（除权检测的前提），以及大盘门的日序。
CREATE TABLE IF NOT EXISTS trading_calendar (
  date INTEGER PRIMARY KEY
) WITHOUT ROWID;

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

  /**
   * 建表（幂等）。
   *
   * 除了 `CREATE TABLE IF NOT EXISTS`，还要处理**已存在的库**的加列：
   * 库是 644 MB 的构建产物，为了加一列让用户重新下载 541 MB 的归档并不划算。
   */
  migrate(): void {
    this.db.exec(SCHEMA);
    this.addColumnIfMissing("instruments", "float_market_cap", "REAL");
    this.setMeta("schema_version", SCHEMA_VERSION);
  }

  private addColumnIfMissing(table: string, column: string, type: string): void {
    const existing = this.db.prepare(`PRAGMA table_info(${table})`).all() as unknown as Array<{
      name: string;
    }>;
    if (existing.some((row) => row.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
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
      `INSERT INTO instruments (code, market, board, name, listed_start, listed_end, is_live, float_market_cap)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code) DO UPDATE SET
         market = excluded.market, board = excluded.board,
         name = COALESCE(excluded.name, instruments.name),
         listed_start = MIN(excluded.listed_start, instruments.listed_start),
         listed_end = MAX(excluded.listed_end, instruments.listed_end),
         is_live = excluded.is_live,
         -- 市值只在有新值时覆盖，避免一次没有快照的写入把已有值抹掉
         float_market_cap = COALESCE(excluded.float_market_cap, instruments.float_market_cap)`,
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
        row.floatMarketCap ?? null,
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
              listed_start AS listedStart, listed_end AS listedEnd, is_live AS isLive,
              float_market_cap AS floatMarketCap
       FROM instruments ORDER BY code`,
    ).all() as unknown as Array<Omit<InstrumentRow, "isLive"> & { isLive: number }>;
    return rows.map((row) => ({ ...row, isLive: row.isLive === 1 }));
  }

  /**
   * 写入交易日历（幂等）。日历来自指数日线，因此是**真实交易日**，
   * 不需要在代码里猜周末与节假日。
   */
  insertCalendarDates(dates: readonly number[]): void {
    const stmt = this.prepare("INSERT OR IGNORE INTO trading_calendar (date) VALUES (?)");
    for (const date of dates) stmt.run(date);
  }

  /** 日历中 `date` 之后的下一个交易日；没有记录则 null。 */
  nextTradingDate(date: number): number | null {
    const row = this.prepare("SELECT MIN(date) AS d FROM trading_calendar WHERE date > ?").get(
      date,
    ) as RawBar | undefined;
    return row?.d ?? null;
  }

  /** 日历覆盖范围；空日历返回 null。 */
  calendarRange(): { from: number; to: number } | null {
    const row = this.prepare(
      "SELECT MIN(date) AS fromDate, MAX(date) AS toDate FROM trading_calendar",
    ).get() as { fromDate: number | null; toDate: number | null } | undefined;
    if (!row || row.fromDate === null || row.toDate === null) return null;
    return { from: row.fromDate, to: row.toDate };
  }

  /**
   * 批量刷新标的的快照派生字段（名称、流通市值）。
   * 用 COALESCE 语义：快照里拿不到名称时保留库内已有的，不把已有值抹成空。
   */
  updateInstrumentSnapshots(
    rows: ReadonlyArray<{ code: string; name: string | null; floatMarketCap: number | null }>,
  ): void {
    const stmt = this.prepare(
      `UPDATE instruments
       SET name = COALESCE(?, name), float_market_cap = COALESCE(?, float_market_cap)
       WHERE code = ?`,
    );
    for (const row of rows) stmt.run(row.name, row.floatMarketCap, row.code);
  }

  /* ------------------------------ 估值与行业 ------------------------------ */

  /** 写入某个交易日的全市场估值与行业归属（幂等）。 */
  insertValuation(rows: readonly ValuationRow[]): void {
    const stmt = this.prepare(
      `INSERT INTO valuation (code, date, close, pe_ttm, pb_mrq, ps_ttm, board_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(code, date) DO UPDATE SET
         close = excluded.close, pe_ttm = excluded.pe_ttm, pb_mrq = excluded.pb_mrq,
         ps_ttm = excluded.ps_ttm, board_name = excluded.board_name`,
    );
    for (const row of rows) {
      stmt.run(row.code, row.date, row.close, row.peTtm, row.pbMrq, row.psTtm, row.boardName);
    }
  }

  /** 估值表里最新的交易日；空表返回 null。 */
  latestValuationDate(): number | null {
    const row = this.prepare("SELECT MAX(date) AS d FROM valuation").get() as RawBar | undefined;
    return row?.d ?? null;
  }

  /** 某个交易日已落地的估值行数（用于断点续跑）。 */
  countValuation(date: number): number {
    const row = this.prepare("SELECT COUNT(*) AS n FROM valuation WHERE date = ?").get(date) as
      | RawBar
      | undefined;
    return row?.n ?? 0;
  }

  /** 交易日历里落在 [from, to] 内的日期，升序。 */
  calendarDatesBetween(from: number, to: number): number[] {
    const rows = this.prepare(
      "SELECT date FROM trading_calendar WHERE date >= ? AND date <= ? ORDER BY date",
    ).all(from, to) as unknown as Array<{ date: number }>;
    return rows.map((row) => row.date);
  }

  /**
   * 同一交易日的「日K收盘 vs 估值收盘」配对。
   * 两个来源完全独立（Qlib dump vs 东财），因此这条比对有真实校验价值。
   */
  valuationClosePairs(date: number): Array<{
    code: string;
    barClose: number | null;
    valuationClose: number | null;
  }> {
    return this.prepare(
      `SELECT b.code AS code, b.close AS barClose, v.close AS valuationClose
       FROM bars b LEFT JOIN valuation v ON v.code = b.code AND v.date = b.date
       WHERE b.date = ?`,
    ).all(date) as unknown as Array<{
      code: string;
      barClose: number | null;
      valuationClose: number | null;
    }>;
  }

  readInstrument(code: string): InstrumentRow | null {    const row = this.prepare(
      `SELECT code, market, board, name,
              listed_start AS listedStart, listed_end AS listedEnd, is_live AS isLive,
              float_market_cap AS floatMarketCap
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
    let maxDate = 0;
    for (const bar of bars) {
      stmt.run(code, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.amount, bar.adjFactor);
      if (bar.date > maxDate) maxDate = bar.date;
    }
    // 维护"最新交易日"：否则下一次读它就得全表扫描
    if (maxDate > 0) {
      const current = this.latestTradeDate();
      if (current === null || maxDate > current) {
        this.latestDateMemo = maxDate;
        this.setMeta("latest_trade_date", String(maxDate));
      }
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

  /**
   * 库内最新的交易日；空库返回 null。
   *
   * **不能直接 `SELECT MAX(date) FROM bars`**：`bars` 是 `WITHOUT ROWID` 且主键为
   * `(code, date)`，裸的 `MAX(date)` 没有可用索引，只能全扫七百多万行——实测约 1.5 秒，
   * 而它每次请求（包括**缓存命中**）都要调用一次，等于把缓存的意义抹掉。
   * 改为读元数据，并在写入更晚的 bar 时就地维护；老库缺这项元数据时回退一次全扫并补上。
   */
  latestTradeDate(): number | null {
    if (this.latestDateMemo === undefined) {
      const meta = this.getMeta("latest_trade_date");
      if (meta !== null && /^\d{8}$/.test(meta)) {
        this.latestDateMemo = Number(meta);
      } else {
        const row = this.prepare("SELECT MAX(date) AS d FROM bars").get() as RawBar | undefined;
        this.latestDateMemo = row?.d ?? null;
        if (this.latestDateMemo !== null) {
          this.setMeta("latest_trade_date", String(this.latestDateMemo));
        }
      }
    }
    return this.latestDateMemo;
  }

  /** `latestTradeDate` 的记忆值：`undefined` 表示尚未解析。 */
  private latestDateMemo: number | null | undefined = undefined;

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

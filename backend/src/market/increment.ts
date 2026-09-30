import type { Board, Market } from "./qlib.js";
import { toDateKey } from "./qlib.js";
import type { BarRow, IndexBarRow, MarketStore } from "./store.js";
import {
  fetchTencentBatchSnapshot,
  fetchTencentKline,
  type TencentSnapshot,
} from "../tencent.js";

/**
 * 每日增量：把"今天这一根日 K × 全市场"补进库。
 *
 * 唯一实测无限流的通道是腾讯批量快照（东财 push2/push2his 已持续不可达），
 * 一次请求携带数百个代码，全市场十余个请求完成——**没有任何逐票扇出**。
 *
 * 除权处理是这里最容易做错的地方。库内同时存了不复权价与复权因子，
 * 而快照的「昨收」是交易所口径的**除权后昨收**：两者不等即说明发生了除权除息。
 * 此时把新 bar 的因子按 `库内昨收 / 快照昨收` 放大，后复权序列就保持连续，
 * 历史 bar 的因子无需改动（这正是"追加稳定"的含义）。
 *
 * 但这件事有个前提：库内最后一根必须是快照日的**上一个交易日**。
 * 否则两者的差异只是行情涨跌，按它放因子会把整条序列改歪——
 * 所以库内维护了一张真实交易日历（来自指数日线），不足以判定相邻时宁可
 * 标为"未判定"并如实上报，也不猜。
 */

/** 大盘门需要的两个指数；Qlib dump 不含它们。 */
export const INDEX_SYMBOLS = ["sh000001", "sz399006"] as const;

/** 报价到分，浮点缩放值带尾数噪声，比较必须给容差。 */
const PRICE_EPSILON = 0.005;

export type AdjustFactorDecision =
  | { kind: "unchanged"; adjFactor: number }
  | { kind: "ex-dividend"; adjFactor: number; ratio: number }
  | { kind: "unknown"; adjFactor: number; reason: string };

/**
 * 由快照昨收与库内最后一根不复权收盘推出复权因子。
 *
 * - 不相等且相邻：除权除息，因子按 `库内昨收 / 快照昨收` 放大
 * - 相等：无事件，因子不变
 * - 不相邻或数据异常：**不判定**，因子保持不变（宁可少做，不可做歪）
 */
export function resolveAdjustFactor(input: {
  lastRawClose: number;
  lastAdjFactor: number;
  snapshotPrevClose: number;
  adjacentTradingDay: boolean;
}): AdjustFactorDecision {
  const { lastRawClose, lastAdjFactor, snapshotPrevClose, adjacentTradingDay } = input;
  if (!adjacentTradingDay) {
    return { kind: "unknown", adjFactor: lastAdjFactor, reason: "库内最新日与快照日不相邻" };
  }
  if (!(lastRawClose > 0) || !(snapshotPrevClose > 0)) {
    return { kind: "unknown", adjFactor: lastAdjFactor, reason: "昨收或库内收盘不可用" };
  }
  if (Math.abs(snapshotPrevClose - lastRawClose) <= PRICE_EPSILON) {
    return { kind: "unchanged", adjFactor: lastAdjFactor };
  }
  return {
    kind: "ex-dividend",
    adjFactor: lastAdjFactor * (lastRawClose / snapshotPrevClose),
    ratio: lastRawClose / snapshotPrevClose,
  };
}

export type BarPlan =
  | { action: "write"; bar: BarRow; exDiv: boolean; refreshed: boolean }
  | { action: "skip"; reason: "no-price" | "no-volume" | "no-trade-date" | "stale-snapshot" };

/**
 * 由一条快照决定要写什么。
 *
 * 停牌 / 退市标的的行情字段是空的，必须丢弃而不是写入 0 或 NaN——
 * 一个 0 价会污染均线与结构判定，而且不会报错。
 */
export function planDailyBar(input: {
  snapshot: TencentSnapshot;
  board: Board;
  lastBar: BarRow | null;
  adjacentTradingDay: boolean;
}): BarPlan {
  const { snapshot, lastBar, adjacentTradingDay } = input;
  const { quote } = snapshot;

  if (snapshot.tradeDate === null) return { action: "skip", reason: "no-trade-date" };
  const price = quote.price;
  const open = quote.open;
  const high = quote.high;
  const low = quote.low;
  if (
    price === null ||
    open === null ||
    high === null ||
    low === null ||
    price <= 0 ||
    open <= 0 ||
    high <= 0 ||
    low <= 0
  ) {
    return { action: "skip", reason: "no-price" };
  }
  const volume = quote.volume;
  if (volume === null || volume <= 0) return { action: "skip", reason: "no-volume" };

  if (lastBar && lastBar.date > snapshot.tradeDate) {
    return { action: "skip", reason: "stale-snapshot" };
  }

  // 同日重复刷新（盘中先跑过一次、收盘后再跑）：沿用已定的因子，不重复判除权
  if (lastBar && lastBar.date === snapshot.tradeDate) {
    return {
      action: "write",
      refreshed: true,
      exDiv: false,
      bar: {
        date: snapshot.tradeDate,
        open,
        high,
        low,
        close: price,
        volume,
        amount: quote.amount ?? 0,
        adjFactor: lastBar.adjFactor,
      },
    };
  }

  const decision = lastBar
    ? resolveAdjustFactor({
        lastRawClose: lastBar.close,
        lastAdjFactor: lastBar.adjFactor,
        snapshotPrevClose: quote.prevClose ?? Number.NaN,
        adjacentTradingDay,
      })
    : // 库内没有该标的的历史（新上市）：因子取 1，没有可依据的历史因子
      ({ kind: "unchanged", adjFactor: 1 } as AdjustFactorDecision);

  return {
    action: "write",
    refreshed: false,
    exDiv: decision.kind === "ex-dividend",
    bar: {
      date: snapshot.tradeDate,
      open,
      high,
      low,
      close: price,
      volume,
      amount: quote.amount ?? 0,
      adjFactor: decision.adjFactor,
    },
  };
}

export type IncrementDeps = {
  fetchSnapshot?: (symbols: readonly string[]) => Promise<TencentSnapshot[]>;
  fetchIndexHistory?: (symbol: string, limit: number) => Promise<Array<{ date: string; open: number; high: number; low: number; close: number; volume: number }>>;
};

export type IncrementStats = {
  /** 快照所属交易日 */
  snapshotDate: number | null;
  /** 增量前库内最新交易日 */
  previousLatestDate: number | null;
  symbolsRequested: number;
  rowsReturned: number;
  requests: number;
  barsWritten: number;
  barsRefreshed: number;
  exDividends: number;
  skipped: Record<string, number>;
  namesUpdated: number;
  marketCapsUpdated: number;
  indexBarsWritten: number;
  calendarDates: number;
  notes: string[];
};

const emptySkipCounts = (): Record<string, number> => ({
  "no-price": 0,
  "no-volume": 0,
  "no-trade-date": 0,
  "stale-snapshot": 0,
  "unknown-symbol": 0,
});

/** 由标的清单拼出腾讯符号（`sh600519` / `bj920002`）。 */
export function instrumentsToSymbols(
  rows: ReadonlyArray<{ code: string; market: Market; board: Board }>,
): Map<string, { code: string; board: Board }> {
  const map = new Map<string, { code: string; board: Board }>();
  for (const row of rows) {
    if (row.board === "index") continue;
    map.set(`${row.market}${row.code}`, { code: row.code, board: row.board });
  }
  return map;
}

/**
 * 补指数日线并建立交易日历。
 *
 * 交易日历刻意从**指数日线**推导而不是自己算周末与节假日：
 * 真实交易日会因调休而偏离"周一至周五"的直觉，猜错一天就会让除权检测误判。
 */
export async function backfillIndexHistory(
  store: MarketStore,
  deps: IncrementDeps = {},
  limit = 400,
): Promise<{ indexBars: number; calendarDates: number }> {
  const fetchHistory = deps.fetchIndexHistory ?? fetchTencentKline;
  let indexBars = 0;
  const dates = new Set<number>();

  for (const symbol of INDEX_SYMBOLS) {
    const klines = await fetchHistory(symbol, limit);
    const rows: IndexBarRow[] = klines.map((k) => ({
      date: toDateKey(k.date),
      open: k.open,
      high: k.high,
      low: k.low,
      close: k.close,
      volume: k.volume,
    }));
    if (rows.length > 0) {
      store.transaction(() => store.insertIndexBars(symbol, rows));
      indexBars += rows.length;
    }
    for (const row of rows) dates.add(row.date);
  }

  const dateList = [...dates].sort((a, b) => a - b);
  if (dateList.length > 0) {
    store.transaction(() => store.insertCalendarDates(dateList));
  }
  return { indexBars, calendarDates: dateList.length };
}

/** 跑一次增量：补指数与日历（如缺）→ 拉全市场快照 → 逐只决定写什么。 */
export async function runIncrement(
  store: MarketStore,
  deps: IncrementDeps = {},
  options: { ensureCalendar?: boolean } = {},
): Promise<IncrementStats> {
  const stats: IncrementStats = {
    snapshotDate: null,
    previousLatestDate: store.latestTradeDate(),
    symbolsRequested: 0,
    rowsReturned: 0,
    requests: 0,
    barsWritten: 0,
    barsRefreshed: 0,
    exDividends: 0,
    skipped: emptySkipCounts(),
    namesUpdated: 0,
    marketCapsUpdated: 0,
    indexBarsWritten: 0,
    calendarDates: 0,
    notes: [],
  };

  // 日历是除权检测的前提；缺就先补（顺带把两个指数落库）
  if (options.ensureCalendar !== false && store.calendarRange() === null) {
    const backfill = await backfillIndexHistory(store, deps);
    stats.indexBarsWritten += backfill.indexBars;
    stats.calendarDates += backfill.calendarDates;
    stats.notes.push(`首次补齐指数日线与交易日历（${backfill.indexBars} 根 / ${backfill.calendarDates} 个交易日）`);
  }

  const instruments = instrumentsToSymbols(store.listInstruments());
  const symbols = [...instruments.keys(), ...INDEX_SYMBOLS];
  stats.symbolsRequested = symbols.length;

  const fetchSnapshot = deps.fetchSnapshot ?? ((list) => fetchTencentBatchSnapshot(list));
  const rows = await fetchSnapshot(symbols);
  stats.rowsReturned = rows.length;
  // 分批请求次数按实测块大小估算即可，调用方关心的是"没有扇出"
  stats.requests = Math.ceil(symbols.length / 400);

  // 快照日取出现次数最多的那个（个别标的会因时区/停牌带出别的日期）
  const dateVotes = new Map<number, number>();
  for (const row of rows) {
    if (row.tradeDate === null) continue;
    dateVotes.set(row.tradeDate, (dateVotes.get(row.tradeDate) ?? 0) + 1);
  }
  let snapshotDate: number | null = null;
  let best = 0;
  for (const [date, votes] of dateVotes) {
    if (votes > best) {
      best = votes;
      snapshotDate = date;
    }
  }
  stats.snapshotDate = snapshotDate;

  const snapshotUpdates: Array<{ code: string; name: string | null; floatMarketCap: number | null }> = [];
  const barWrites: Array<{ code: string; bar: BarRow }> = [];
  const indexRows: Array<{ symbol: string; bar: IndexBarRow }> = [];

  for (const row of rows) {
    if ((INDEX_SYMBOLS as readonly string[]).includes(row.symbol)) {
      const { quote } = row;
      if (
        row.tradeDate !== null &&
        quote.price !== null &&
        quote.open !== null &&
        quote.high !== null &&
        quote.low !== null
      ) {
        indexRows.push({
          symbol: row.symbol,
          bar: {
            date: row.tradeDate,
            open: quote.open,
            high: quote.high,
            low: quote.low,
            close: quote.price,
            volume: quote.volume ?? 0,
          },
        });
      }
      continue;
    }

    const instrument = instruments.get(row.symbol);
    if (!instrument) {
      stats.skipped["unknown-symbol"] = (stats.skipped["unknown-symbol"] ?? 0) + 1;
      continue;
    }

    const lastBar = store.readBars(instrument.code, 1)[0] ?? null;
    const adjacentTradingDay =
      lastBar !== null && snapshotDate !== null && store.nextTradingDate(lastBar.date) === snapshotDate;

    const plan = planDailyBar({
      snapshot: row,
      board: instrument.board,
      lastBar,
      adjacentTradingDay,
    });

    if (plan.action === "skip") {
      stats.skipped[plan.reason] = (stats.skipped[plan.reason] ?? 0) + 1;
      continue;
    }
    barWrites.push({ code: instrument.code, bar: plan.bar });
    if (plan.refreshed) stats.barsRefreshed++;
    else stats.barsWritten++;
    if (plan.exDiv) stats.exDividends++;

    // 名称与市值**各自独立**判断：快照偶尔缺名称，但市值照样是有效的。
    // 绑在一起会让市值闸门因为一个缺失的字段而整档"未生效"。
    if (row.quote.name !== null || row.quote.floatMarketCap !== null) {
      snapshotUpdates.push({
        code: instrument.code,
        name: row.quote.name,
        floatMarketCap: row.quote.floatMarketCap,
      });
    }
  }

  // 一次事务写完全部日线：逐根提交在每次增量里是约 6000 次 fsync，
  // 而且与 store.ts 里"批量写入请自行包事务"的约定相矛盾
  if (barWrites.length > 0) {
    store.transaction(() => {
      for (const write of barWrites) store.insertBars(write.code, [write.bar]);
    });
  }

  if (snapshotUpdates.length > 0) {
    store.transaction(() => store.updateInstrumentSnapshots(snapshotUpdates));
    stats.namesUpdated = snapshotUpdates.filter((r) => r.name !== null).length;
    stats.marketCapsUpdated = snapshotUpdates.filter((r) => r.floatMarketCap !== null).length;
  }

  if (indexRows.length > 0) {
    store.transaction(() => {
      for (const { symbol, bar } of indexRows) store.insertIndexBars(symbol, [bar]);
    });
    stats.indexBarsWritten += indexRows.length;
  }

  if (snapshotDate !== null) {
    const previous = stats.previousLatestDate;
    if (previous !== null && store.nextTradingDate(previous) !== snapshotDate) {
      stats.notes.push(
        `库内最新交易日 ${previous} 与快照日 ${snapshotDate} 之间不是相邻交易日：` +
          `中间缺口无法用当日快照补齐，这段时间的除权检测按"未判定"处理。`,
      );
    }
    store.setMeta("latest_trade_date", String(store.latestTradeDate() ?? snapshotDate));
    store.setMeta("last_increment_at", new Date().toISOString());
    store.setMeta("last_increment_snapshot_date", String(snapshotDate));
  }

  return stats;
}

import type { MarketStore } from "./store.js";
import { fromDateKey } from "./qlib.js";

/**
 * 估值与行业归属的落地（`datacenter-web`，与 push2 家族按域名隔离）。
 *
 * 为什么值得单独做：源书的规则**完全不用 PE/PB**（书里 0 次出现），
 * 但行业归属是 v2 题材层与"同业对比"的基础；而且这条数据通道
 * 是**按交易日一次请求取全市场**——六年约一千余次请求，没有任何逐票扇出。
 *
 * 顺带它还提供了一个独立于日K dump 的收盘价来源，可以做交叉校验：
 * 两源在同一交易日的收盘价不一致，说明其中一方有解析问题。
 */

const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";
/** 单次请求可取的行情数上限（实测 pageSize=6000 一次拿全）。 */
const PAGE_SIZE = 6000;

export type ValuationRow = {
  code: string;
  /** `YYYYMMDD` */
  date: number;
  close: number | null;
  peTtm: number | null;
  pbMrq: number | null;
  psTtm: number | null;
  boardName: string | null;
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "-" || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/** `TRADE_DATE` 在响应里形如 `2026-09-30 00:00:00`。 */
function toDateKey(raw: unknown): number | null {
  const text = str(raw);
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? Number(`${match[1]}${match[2]}${match[3]}`) : null;
}

/**
 * 归一化按交易日的全市场估值响应（纯函数）。
 *
 * 缺代码或缺日期的行直接丢弃：它们无法定位，写进库只会变成孤儿数据。
 */
export function normalizeValuationRows(raw: unknown): ValuationRow[] {
  const rows = (raw as { result?: { data?: unknown } } | null)?.result?.data;
  if (!Array.isArray(rows)) return [];

  const out: ValuationRow[] = [];
  for (const item of rows) {
    const row = item as Record<string, unknown>;
    const code = str(row.SECURITY_CODE);
    const date = toDateKey(row.TRADE_DATE);
    if (!code || date === null) continue;
    out.push({
      code,
      date,
      close: num(row.CLOSE_PRICE),
      peTtm: num(row.PE_TTM),
      pbMrq: num(row.PB_MRQ),
      psTtm: num(row.PS_TTM),
      boardName: str(row.BOARD_NAME),
    });
  }
  return out;
}

export type ValuationDeps = {
  fetchDay?: (dateKey: number) => Promise<ValuationRow[]>;
  /** 请求之间的间隔：这条通道实测未限流，但没有理由去压它 */
  delayMs?: number;
};

/** 取某个交易日的全市场估值（一次请求）。 */
export async function fetchValuationDay(dateKey: number): Promise<ValuationRow[]> {
  const url = new URL(DATACENTER);
  url.searchParams.set("reportName", "RPT_VALUEANALYSIS_DET");
  url.searchParams.set("columns", "ALL");
  url.searchParams.set("filter", `(TRADE_DATE='${fromDateKey(dateKey)}')`);
  url.searchParams.set("pageSize", String(PAGE_SIZE));
  url.searchParams.set("pageNumber", "1");

  const res = await fetch(url, {
    signal: AbortSignal.timeout(30_000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`估值数据请求失败：HTTP ${res.status}`);
  return normalizeValuationRows(await res.json());
}

export type ValuationIngestStats = {
  daysRequested: number;
  daysWithData: number;
  rowsWritten: number;
  failedDays: number;
};

/**
 * 按交易日区间落地估值与行业。
 *
 * 交易日来自库内日历（#12 从指数日线建立），因此不会去拉非交易日。
 */
export async function ingestValuation(
  store: MarketStore,
  options: { from: number; to: number; deps?: ValuationDeps } = { from: 0, to: 0 },
): Promise<ValuationIngestStats> {
  const deps = options.deps ?? {};
  const fetchDay = deps.fetchDay ?? fetchValuationDay;
  const delayMs = deps.delayMs ?? 150;

  const days = store
    .calendarDatesBetween(options.from, options.to)
    .filter((date) => store.countValuation(date) === 0); // 断点续跑：已落地的日期不再重复请求

  const stats: ValuationIngestStats = {
    daysRequested: days.length,
    daysWithData: 0,
    rowsWritten: 0,
    failedDays: 0,
  };

  for (const [index, date] of days.entries()) {
    try {
      const rows = await fetchDay(date);
      if (rows.length > 0) {
        store.transaction(() => store.insertValuation(rows));
        stats.daysWithData++;
        stats.rowsWritten += rows.length;
      }
    } catch {
      // 单日失败不中断整段回填：断点续跑会补上它
      stats.failedDays++;
    }
    if (delayMs > 0 && index < days.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return stats;
}

export type CrossCheckResult = {
  date: number;
  /** 两源都有的标的数 */
  compared: number;
  /** 收盘价一致的标的数 */
  matched: number;
  /** 差异样例（最多若干条） */
  mismatches: Array<{ code: string; barClose: number; valuationClose: number }>;
  /** 只有日K、没有估值的标的数 */
  missingInValuation: number;
};

/**
 * 收盘价交叉校验：库内日K 与估值表在同一交易日逐只比对。
 *
 * 这条校验的价值在于**两个来源完全独立**（Qlib dump vs 东财 datacenter-web），
 * 一旦某方的解析有问题（列序、缩放、复权口径），差异会立刻显形。
 */
export function crossCheckValuationClose(
  store: MarketStore,
  date: number,
  options: { sampleLimit?: number; tolerance?: number } = {},
): CrossCheckResult {
  const tolerance = options.tolerance ?? 1e-4;
  const sampleLimit = options.sampleLimit ?? 10;

  const pairs = store.valuationClosePairs(date);
  const result: CrossCheckResult = {
    date,
    compared: 0,
    matched: 0,
    mismatches: [],
    missingInValuation: 0,
  };

  for (const pair of pairs) {
    if (pair.barClose === null || pair.valuationClose === null) {
      result.missingInValuation++;
      continue;
    }
    result.compared++;
    const scale = Math.max(Math.abs(pair.barClose), Math.abs(pair.valuationClose));
    const same = scale === 0 || Math.abs(pair.barClose - pair.valuationClose) / scale <= tolerance;
    if (same) {
      result.matched++;
    } else if (result.mismatches.length < sampleLimit) {
      result.mismatches.push({
        code: pair.code,
        barClose: pair.barClose,
        valuationClose: pair.valuationClose,
      });
    }
  }
  return result;
}

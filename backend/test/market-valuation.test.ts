import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  crossCheckValuationClose,
  ingestValuation,
  normalizeValuationRows,
  type ValuationRow,
} from "../src/market/valuation.js";
import { MarketStore, type BarRow } from "../src/market/store.js";

/**
 * 估值与行业落地。
 *
 * 这条通道的独特价值有两个：**按交易日一次请求取全市场**（无逐票扇出），
 * 以及提供一个**与日K 完全独立的收盘价来源**用于交叉校验。
 */

let dir: string;
let store: MarketStore;

const DAY = 20260930;

const bar = (code: string, date: number, close: number): BarRow => ({
  date,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1000,
  amount: 1e7,
  adjFactor: 1,
});

const valuationRow = (code: string, over: Partial<ValuationRow> = {}): ValuationRow => ({
  code,
  date: DAY,
  close: 10,
  peTtm: 15,
  pbMrq: 1.5,
  psTtm: 2,
  boardName: "软件开发",
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "valuation-"));
  store = new MarketStore(join(dir, "kline.sqlite"));
  store.migrate();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("normalizeValuationRows", () => {
  const raw = {
    result: {
      data: [
        {
          SECURITY_CODE: "600519",
          SECURITY_NAME_ABBR: "贵州茅台",
          TRADE_DATE: "2026-09-30 00:00:00",
          CLOSE_PRICE: 1235.58,
          PE_TTM: 19.05,
          PB_MRQ: 6.17,
          PS_TTM: 9.8,
          BOARD_NAME: "酿酒行业",
          BOARD_CODE: "BK0477",
        },
        { SECURITY_CODE: "000001", TRADE_DATE: "2026-09-30 00:00:00", CLOSE_PRICE: 11.35 },
      ],
    },
  };

  it("抽出收盘价、PE/PB/PS 与行业，并把日期折成日期键", () => {
    const rows = normalizeValuationRows(raw);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      code: "600519",
      date: DAY,
      close: 1235.58,
      peTtm: 19.05,
      pbMrq: 6.17,
      psTtm: 9.8,
      boardName: "酿酒行业",
    });
  });

  it("缺失的估值字段为 null，而不是 0", () => {
    const rows = normalizeValuationRows(raw);
    expect(rows[1]?.peTtm).toBeNull();
    expect(rows[1]?.boardName).toBeNull();
    expect(rows[1]?.close).toBe(11.35);
  });

  it("非法日期与缺代码的行被丢弃（写进库只会变成孤儿数据）", () => {
    const rows = normalizeValuationRows({
      result: { data: [{ SECURITY_CODE: "600519", TRADE_DATE: "不是日期" }, { TRADE_DATE: "2026-09-30" }] },
    });
    expect(rows).toEqual([]);
  });

  it("响应结构异常时返回空数组，不抛错", () => {
    expect(normalizeValuationRows(null)).toEqual([]);
    expect(normalizeValuationRows({})).toEqual([]);
    expect(normalizeValuationRows({ result: { data: "nope" } })).toEqual([]);
  });
});

describe("ingestValuation（注入假请求，不触网）", () => {
  it("只请求日历里的交易日，并且已落地的日期不再重复请求", async () => {
    store.insertCalendarDates([20260928, DAY]);
    const fetchDay = vi.fn(async (date: number) => [valuationRow("600519", { date })]);

    const first = await ingestValuation(store, {
      from: 20260901,
      to: 20260930,
      deps: { fetchDay, delayMs: 0 },
    });
    expect(first.daysRequested).toBe(2);
    expect(first.rowsWritten).toBe(2);
    expect(fetchDay).toHaveBeenCalledTimes(2);

    // 断点续跑：两天都已落地，不再发请求
    const second = await ingestValuation(store, {
      from: 20260901,
      to: 20260930,
      deps: { fetchDay, delayMs: 0 },
    });
    expect(second.daysRequested).toBe(0);
    expect(fetchDay).toHaveBeenCalledTimes(2);
  });

  it("单日失败不中断整段回填", async () => {
    store.insertCalendarDates([20260928, 20260929, DAY]);
    const fetchDay = vi.fn(async (date: number) => {
      if (date === 20260929) throw new Error("HTTP 502");
      return [valuationRow("600519", { date })];
    });

    const stats = await ingestValuation(store, { from: 20260901, to: 20260930, deps: { fetchDay, delayMs: 0 } });
    expect(stats.daysWithData).toBe(2);
    expect(stats.failedDays).toBe(1);
  });
});

describe("收盘价交叉校验", () => {
  it("两源一致时全部计入 matched", () => {
    store.insertBars("600519", [bar("600519", DAY, 1235.58)]);
    store.insertBars("000001", [bar("000001", DAY, 11.35)]);
    store.insertValuation([
      valuationRow("600519", { close: 1235.58 }),
      valuationRow("000001", { close: 11.35 }),
    ]);

    const result = crossCheckValuationClose(store, DAY);
    expect(result.compared).toBe(2);
    expect(result.matched).toBe(2);
    expect(result.mismatches).toEqual([]);
  });

  it("某只不一致时被列入差异样例（这正是能发现解析问题的判据）", () => {
    store.insertBars("600519", [bar("600519", DAY, 1235.58)]);
    store.insertValuation([valuationRow("600519", { close: 123.558 })]); // 差一个数量级

    const result = crossCheckValuationClose(store, DAY);
    expect(result.compared).toBe(1);
    expect(result.matched).toBe(0);
    expect(result.mismatches[0]).toMatchObject({ code: "600519" });
  });

  it("只有日K、没有估值的标的单列计数", () => {
    store.insertBars("600519", [bar("600519", DAY, 10)]);
    const result = crossCheckValuationClose(store, DAY);
    expect(result.compared).toBe(0);
    expect(result.missingInValuation).toBe(1);
  });
});

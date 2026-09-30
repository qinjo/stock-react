import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketStore, type BarRow, type InstrumentRow } from "../src/market/store.js";
import { loadUniverseFromStore } from "../src/screener/load.js";

/**
 * 库 → 引擎的适配层：用临时文件里的真 SQLite 测（无网络、无 mock）。
 * 这一层最容易出错的是"读了哪些、读了多少根、字段有没有对错位"。
 */

let dir: string;
let store: MarketStore;

const instrument = (code: string, over: Partial<InstrumentRow> = {}): InstrumentRow => ({
  code,
  market: "sz",
  board: "main",
  name: null,
  listedStart: 20200101,
  listedEnd: 20260929,
  isLive: true,
  ...over,
});

const bar = (date: number, close: number): BarRow => ({
  date,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1000,
  amount: 1e8,
  adjFactor: 1,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "screener-load-"));
  store = new MarketStore(join(dir, "kline.sqlite"));
  store.migrate();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("loadUniverseFromStore", () => {
  it("逐只给出领域对象，字段与库内一致", () => {
    store.upsertInstruments([instrument("000001", { name: "平安银行", board: "main" })]);
    store.insertBars("000001", [bar(20260928, 11.3), bar(20260929, 11.35)]);

    const loaded = [...loadUniverseFromStore(store)];
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({
      code: "000001",
      name: "平安银行",
      board: "main",
      isLive: true,
      floatMarketCap: null, // 市值来自行情快照，当前尚未接入
    });
    expect(loaded[0]?.bars.map((b) => b.close)).toEqual([11.3, 11.35]);
  });

  it("没有日线的标的被跳过（而不是产出空序列让引擎去猜）", () => {
    store.upsertInstruments([instrument("000001"), instrument("000002")]);
    store.insertBars("000002", [bar(20260929, 10)]);

    expect([...loadUniverseFromStore(store)].map((s) => s.code)).toEqual(["000002"]);
  });

  it("只读最近 barsLimit 根，且保持升序", () => {
    store.upsertInstruments([instrument("000001")]);
    store.insertBars("000001", [1, 2, 3, 4, 5].map((i) => bar(20260920 + i, i)));

    const loaded = [...loadUniverseFromStore(store, { barsLimit: 3 })];
    expect(loaded[0]?.bars.map((b) => b.date)).toEqual([20260923, 20260924, 20260925]);
  });

  it("支持按条件过滤标的（后续用于只筛某个板块或只跑子集）", () => {
    store.upsertInstruments([
      instrument("000001", { board: "main" }),
      instrument("300750", { board: "growth" }),
    ]);
    store.insertBars("000001", [bar(20260929, 10)]);
    store.insertBars("300750", [bar(20260929, 20)]);

    const growthOnly = [
      ...loadUniverseFromStore(store, { codeFilter: (row) => row.board === "growth" }),
    ];
    expect(growthOnly.map((s) => s.code)).toEqual(["300750"]);
  });

  it("空库产出空流，不抛错", () => {
    expect([...loadUniverseFromStore(store)]).toEqual([]);
  });
});

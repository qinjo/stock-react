import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MarketStore, SCHEMA_VERSION, type BarRow, type InstrumentRow } from "../src/market/store.js";

/**
 * 库的测试用**临时文件里的真 SQLite**，不用内存库也不用 mock：
 * 这一层最容易出错的地方恰好是文件落盘、主键冲突与事务语义，
 * 用 mock 会把它们全部测掉。
 */
let dir: string;
let dbPath: string;
let store: MarketStore;

const bar = (date: number, close: number): BarRow => ({
  date,
  open: close - 1,
  high: close + 1,
  low: close - 2,
  close,
  volume: 1000,
  amount: 1_000_000,
  adjFactor: 1,
});

const instrument = (over: Partial<InstrumentRow> = {}): InstrumentRow => ({
  code: "600519",
  market: "sh",
  board: "main",
  name: null,
  listedStart: 20010827,
  listedEnd: 20260929,
  isLive: true,
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "market-store-"));
  dbPath = join(dir, "kline.sqlite");
  store = new MarketStore(dbPath);
  store.migrate();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("MarketStore 建表", () => {
  it("migrate 幂等，重复调用不报错", () => {
    expect(() => store.migrate()).not.toThrow();
  });

  it("库文件真的落在磁盘上", () => {
    store.upsertInstruments([instrument()]);
    expect(existsSync(dbPath)).toBe(true);
  });

  it("写入的数据在重开连接后仍可读（不是内存假象）", () => {
    store.upsertInstruments([instrument()]);
    store.insertBars("600519", [bar(20260929, 1235.58)]);
    store.close();

    const reopened = new MarketStore(dbPath);
    expect(reopened.latestTradeDate()).toBe(20260929);
    expect(reopened.readBars("600519")).toHaveLength(1);
    reopened.close();
  });
});

describe("bars 读写", () => {
  it("按日期升序返回", () => {
    store.insertBars("600519", [bar(20260929, 3), bar(20260925, 1), bar(20260928, 2)]);
    expect(store.readBars("600519").map((b) => b.close)).toEqual([1, 2, 3]);
  });

  it("limit 取最近 N 根，且仍按升序返回", () => {
    store.insertBars("600519", [bar(20260925, 1), bar(20260928, 2), bar(20260929, 3)]);
    const recent = store.readBars("600519", 2);
    expect(recent.map((b) => b.close)).toEqual([2, 3]);
    expect(recent.map((b) => b.date)).toEqual([20260928, 20260929]);
  });

  it("同 code + date 重复写入是覆盖而非重复行", () => {
    store.insertBars("600519", [bar(20260929, 10)]);
    store.insertBars("600519", [bar(20260929, 20)]);
    expect(store.countBars()).toBe(1);
    expect(store.readBars("600519")[0]?.close).toBe(20);
  });

  it("多只标的互不串味", () => {
    store.insertBars("600519", [bar(20260929, 1235.58)]);
    store.insertBars("000001", [bar(20260929, 11.35)]);
    expect(store.readBars("000001")[0]?.close).toBe(11.35);
    expect(store.readBars("600519")[0]?.close).toBe(1235.58);
  });

  it("不复权价与因子分别存取（口径不被冲掉）", () => {
    store.insertBars("600519", [{ ...bar(20260929, 1235.58), adjFactor: 0.243208 }]);
    const stored = store.readBars("600519")[0];
    expect(stored?.close).toBeCloseTo(1235.58, 2);
    expect(stored?.adjFactor).toBeCloseTo(0.243208, 6);
  });

  it("空库的 latestTradeDate 为 null", () => {
    expect(store.latestTradeDate()).toBeNull();
  });
});

describe("index_bars 读写", () => {
  it("指数序列与个股分开存放", () => {
    store.insertIndexBars("sh000001", [
      { date: 20260928, open: 3800, high: 3850, low: 3790, close: 3840, volume: 1 },
      { date: 20260929, open: 3840, high: 3870, low: 3820, close: 3860, volume: 2 },
    ]);
    expect(store.readIndexBars("sh000001", 1)[0]?.close).toBe(3860);
    expect(store.readBars("sh000001")).toHaveLength(0); // 不混进个股表
  });
});

describe("instruments 写入语义", () => {
  it("后写入的名称会补上先前的 null（bootstrap 无名称、快照回填）", () => {
    store.upsertInstruments([instrument({ name: null })]);
    expect(store.readInstrument("600519")?.name).toBeNull();
    store.upsertInstruments([instrument({ name: "贵州茅台" })]);
    expect(store.readInstrument("600519")?.name).toBe("贵州茅台");
  });

  it("listed_start 取更早、listed_end 取更晚（增量只扩不缩）", () => {
    store.upsertInstruments([instrument({ listedStart: 20010827, listedEnd: 20260929 })]);
    store.upsertInstruments([instrument({ listedStart: 20200101, listedEnd: 20260930 })]);
    const row = store.readInstrument("600519");
    expect(row?.listedStart).toBe(20010827);
    expect(row?.listedEnd).toBe(20260930);
  });

  it("读不到的标的存在性用 null 表达", () => {
    expect(store.readInstrument("999999")).toBeNull();
  });

  it("按板块计数", () => {
    store.upsertInstruments([
      instrument({ code: "600519", board: "main" }),
      instrument({ code: "688981", board: "star" }),
      instrument({ code: "300750", board: "growth" }),
      instrument({ code: "920002", board: "bj" }),
    ]);
    expect(store.countInstruments()).toBe(4);
    expect(store.countInstruments("star")).toBe(1);
    expect(store.countInstruments("bj")).toBe(1);
  });

  it("只数仍在交易的标的", () => {
    store.upsertInstruments([
      instrument({ code: "600519", isLive: true }),
      instrument({ code: "688981", isLive: false }),
      instrument({ code: "300750", isLive: true }),
    ]);
    expect(store.countInstruments()).toBe(3);
    expect(store.countInstruments(undefined, true)).toBe(2);
    expect(store.countInstruments("star", true)).toBe(0);
  });

  it("抽样代码等距跨越整个代码空间，且排除指数与已不交易的标的", () => {
    store.upsertInstruments([
      instrument({ code: "000001", isLive: true }),
      instrument({ code: "000002", isLive: false }),
      instrument({ code: "300750", isLive: true }),
      instrument({ code: "600519", isLive: true }),
      instrument({ code: "688981", isLive: true }),
      instrument({ code: "000300", board: "index", isLive: true }),
    ]);
    const sample = store.sampleLiveCodes(2);
    expect(sample).toHaveLength(2);
    expect(sample).not.toContain("000002"); // 已不交易
    expect(sample).not.toContain("000300"); // 指数
    expect(sample[0]).toBe("000001");
    expect(sample[1]).toBe("600519"); // 等距跨步落到后半段，而不是连着取前两个
  });

  it("抽样数量超过可用标的时返回全部", () => {
    store.upsertInstruments([instrument({ code: "600519" })]);
    expect(store.sampleLiveCodes(50)).toEqual(["600519"]);
  });
});

describe("transaction", () => {
  it("抛错时整体回滚，不留下半批数据", () => {
    expect(() =>
      store.transaction(() => {
        store.insertBars("600519", [bar(20260925, 1)]);
        throw new Error("中途失败");
      }),
    ).toThrow(/中途失败/);
    expect(store.countBars()).toBe(0);
  });

  it("成功时提交", () => {
    store.transaction(() => store.insertBars("600519", [bar(20260925, 1)]));
    expect(store.countBars()).toBe(1);
  });
});

describe("meta", () => {
  it("读写与覆盖", () => {
    store.setMeta("bootstrap_release_tag", "2026-09-29");
    expect(store.getMeta("bootstrap_release_tag")).toBe("2026-09-29");
    store.setMeta("bootstrap_release_tag", "2026-09-30");
    expect(store.getMeta("bootstrap_release_tag")).toBe("2026-09-30");
    expect(store.getMeta("不存在")).toBeNull();
  });

  it("migrate 会写入 schema_version", () => {
    expect(store.getMeta("schema_version")).toBe(SCHEMA_VERSION);
  });
});

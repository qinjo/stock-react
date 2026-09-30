import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INDEX_SYMBOLS,
  backfillIndexHistory,
  instrumentsToSymbols,
  planDailyBar,
  resolveAdjustFactor,
  runIncrement,
} from "../src/market/increment.js";
import { MarketStore, type BarRow } from "../src/market/store.js";
import type { TencentSnapshot } from "../src/tencent.js";

/**
 * 增量与除权检测。
 *
 * 除权这一块最容易"静默做错"：把普通涨跌误判成除权会按错误的倍数改因子，
 * 而改完之后价格、成交量、成交额全都"看起来正常"，只有均线悄悄偏了。
 * 所以这里对"相邻 / 不相邻"两条路径都钉死。
 */

let dir: string;
let store: MarketStore;

const D0 = 20260929;
const D1 = 20260930;

const bar = (date: number, close: number, adjFactor = 1): BarRow => ({
  date,
  open: close,
  high: close * 1.01,
  low: close * 0.99,
  close,
  volume: 1000,
  amount: 1e7,
  adjFactor,
});

function snapshot(symbol: string, over: Partial<TencentSnapshot["quote"]> = {}, date = D1): TencentSnapshot {
  return {
    symbol,
    timestamp: `${date}113000`,
    tradeDate: date,
    quote: {
      code: symbol.slice(2),
      name: "测试股",
      price: 11.6,
      open: 11.4,
      high: 11.7,
      low: 11.3,
      prevClose: 11.6,
      changePercent: 0,
      limitUp: 12.76,
      limitDown: 10.44,
      volume: 2000,
      amount: 2.3e7,
      marketCap: 5e9,
      floatMarketCap: 4e9,
      pe: 10,
      pb: 1,
      turnoverRate: 1,
      ...over,
    },
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "increment-"));
  store = new MarketStore(join(dir, "kline.sqlite"));
  store.migrate();
});

afterEach(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resolveAdjustFactor", () => {
  it("昨收与库内收盘一致 → 因子不变", () => {
    const decision = resolveAdjustFactor({
      lastRawClose: 11.6,
      lastAdjFactor: 0.5,
      snapshotPrevClose: 11.6,
      adjacentTradingDay: true,
    });
    expect(decision.kind).toBe("unchanged");
    expect(decision.adjFactor).toBe(0.5);
  });

  it("昨收低于库内收盘 → 判定除权，因子按比例放大", () => {
    // 实测案例：平安银行 2026-09-24 除权，10 派 2.49 元，除权后昨收 11.351
    const decision = resolveAdjustFactor({
      lastRawClose: 11.6,
      lastAdjFactor: 1,
      snapshotPrevClose: 11.351,
      adjacentTradingDay: true,
    });
    expect(decision.kind).toBe("ex-dividend");
    expect(decision.adjFactor).toBeCloseTo(11.6 / 11.351, 10);
    // 后复权序列在除权处保持连续：库内收盘 × 旧因子 == 除权后昨收 × 新因子
    expect(11.6 * 1).toBeCloseTo(11.351 * decision.adjFactor, 6);
  });

  it("库内最新日与快照日不相邻 → 不判定（宁可少做，不可做歪）", () => {
    const decision = resolveAdjustFactor({
      lastRawClose: 10,
      lastAdjFactor: 1,
      snapshotPrevClose: 11,
      adjacentTradingDay: false,
    });
    expect(decision.kind).toBe("unknown");
    expect(decision.adjFactor).toBe(1);
    if (decision.kind === "unknown") expect(decision.reason).toContain("不相邻");
  });

  it("价格不可用时同样不判定，并在原因里说清是哪一边不可用", () => {
    const decision = resolveAdjustFactor({
      lastRawClose: 0,
      lastAdjFactor: 1,
      snapshotPrevClose: 11,
      adjacentTradingDay: true,
    });
    expect(decision.kind).toBe("unknown");
    expect(decision.adjFactor).toBe(1); // 关键：沿用旧因子，绝不按不可用的数去放大
    if (decision.kind === "unknown") expect(decision.reason).toContain("昨收或库内收盘不可用");

    // 另一侧不可用（快照昨收为 0）走同一分支
    expect(
      resolveAdjustFactor({
        lastRawClose: 10,
        lastAdjFactor: 1,
        snapshotPrevClose: 0,
        adjacentTradingDay: true,
      }).kind,
    ).toBe("unknown");
  });
});

describe("planDailyBar", () => {
  const base = { board: "main" as const, adjacentTradingDay: true };

  it("正常交易日：写入当日 bar，沿用库内因子", () => {
    const plan = planDailyBar({
      ...base,
      snapshot: snapshot("sh600519", { prevClose: 11.6 }),
      lastBar: bar(D0, 11.6, 0.42),
    });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.bar.date).toBe(D1);
    expect(plan.bar.close).toBe(11.6);
    expect(plan.bar.adjFactor).toBe(0.42);
    expect(plan.exDiv).toBe(false);
    expect(plan.refreshed).toBe(false);
  });

  it("除权日：写入的 bar 用放大后的因子", () => {
    const plan = planDailyBar({
      ...base,
      snapshot: snapshot("sz000001", { prevClose: 11.351 }),
      lastBar: bar(D0, 11.6, 1),
    });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.exDiv).toBe(true);
    expect(plan.bar.adjFactor).toBeCloseTo(11.6 / 11.351, 10);
  });

  it("同日重复运行（盘中跑过、收盘后再跑）→ 覆盖刷新且不重复判除权", () => {
    const plan = planDailyBar({
      ...base,
      snapshot: snapshot("sh600519", { prevClose: 11.351 }),
      lastBar: bar(D1, 11.0, 1),
    });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.refreshed).toBe(true);
    expect(plan.exDiv).toBe(false);
    expect(plan.bar.adjFactor).toBe(1);
  });

  it("库内没有历史（新上市）→ 因子取 1", () => {
    const plan = planDailyBar({ ...base, snapshot: snapshot("sh600519"), lastBar: null });
    expect(plan.action).toBe("write");
    if (plan.action !== "write") return;
    expect(plan.bar.adjFactor).toBe(1);
  });

  it("停牌 / 缺价：跳过而不是写入 0 或 NaN", () => {
    for (const missing of ["price", "open", "high", "low"] as const) {
      const plan = planDailyBar({
        ...base,
        snapshot: snapshot("sh600519", { [missing]: null }),
        lastBar: bar(D0, 11.6),
      });
      expect(plan.action, missing).toBe("skip");
      if (plan.action === "skip") expect(plan.reason).toBe("no-price");
    }
  });

  it("无成交量与无交易日也跳过", () => {
    const noVolume = planDailyBar({
      ...base,
      snapshot: snapshot("sh600519", { volume: 0 }),
      lastBar: bar(D0, 11.6),
    });
    expect(noVolume).toMatchObject({ action: "skip", reason: "no-volume" });

    const noDate = planDailyBar({
      ...base,
      snapshot: { ...snapshot("sh600519"), tradeDate: null, timestamp: null },
      lastBar: bar(D0, 11.6),
    });
    expect(noDate).toMatchObject({ action: "skip", reason: "no-trade-date" });
  });


  it("快照比库内还旧时跳过（防止把历史写回去）", () => {
    const plan = planDailyBar({
      ...base,
      snapshot: snapshot("sh600519", {}, D0 - 1),
      lastBar: bar(D0, 11.6),
    });
    expect(plan).toMatchObject({ action: "skip", reason: "stale-snapshot" });
  });
});

describe("instrumentsToSymbols", () => {
  it("按市场前缀拼符号，并排除指数", () => {
    const map = instrumentsToSymbols([
      { code: "600519", market: "sh", board: "main" },
      { code: "000001", market: "sz", board: "main" },
      { code: "920002", market: "bj", board: "bj" },
      { code: "000300", market: "sh", board: "index" },
    ]);
    expect([...map.keys()]).toEqual(["sh600519", "sz000001", "bj920002"]);
    expect(map.get("bj920002")).toEqual({ code: "920002", board: "bj" });
  });
});

describe("runIncrement（临时真库 + 假快照，不触网）", () => {
  const instrument = (code: string, name: string | null = null) => ({
    code,
    market: "sz" as const,
    board: "main" as const,
    name,
    listedStart: 20200101,
    listedEnd: D0,
    isLive: true,
  });

  beforeEach(() => {
    store.upsertInstruments([instrument("000001"), instrument("000002"), instrument("000003")]);
    store.insertBars("000001", [bar(D0, 10)]);
    store.insertBars("000002", [bar(D0, 20)]);
    store.insertBars("000003", [bar(D0, 30)]);
    store.insertCalendarDates([20260925, D0, D1]);
  });

  const fakeSnapshot = async (): Promise<TencentSnapshot[]> => [
    // 正常
    snapshot("sz000001", { name: "平安银行", price: 10.5, prevClose: 10, floatMarketCap: 3e8 }),
    // 除权：昨收 19.5 < 库内 20
    snapshot("sz000002", { name: "除权股", price: 19.8, prevClose: 19.5, floatMarketCap: 4e8 }),
    // 停牌：无价
    snapshot("sz000003", { name: "停牌股", price: null, open: null, high: null, low: null }),
    // 指数
    snapshot("sh000001", { name: "上证指数", price: 3840.83, prevClose: 3830.45 }),
  ];

  it("快照里出现清单外的符号 → 计入 unknown-symbol，而不是硬塞进库", async () => {
    // 真实场景：新上市的票会先出现在快照里，而标的清单还没更新。
    // 这条分支此前没有任何测试走到过（用"代码产出的标签 vs 测试断言"扫出来的）。
    const withStranger = async (): Promise<TencentSnapshot[]> => [
      ...(await fakeSnapshot()),
      snapshot("sz300999", { name: "清单外新股", price: 20 }),
    ];
    const stats = await runIncrement(
      store,
      { fetchSnapshot: withStranger },
      { ensureCalendar: false },
    );

    expect(stats.skipped["unknown-symbol"]).toBe(1);
    // 不给它写任何日线：宁可漏，也不生成一个没有标的档案的孤儿序列
    expect(store.readBars("300999", 5)).toEqual([]);
  });

  it("追加当日 bar、回填名称与市值、写指数，并如实跳过停牌", async () => {
    const stats = await runIncrement(
      store,
      { fetchSnapshot: fakeSnapshot },
      { ensureCalendar: false },
    );

    expect(stats.snapshotDate).toBe(D1);
    expect(stats.barsWritten).toBe(2); // 000001 与 000002
    expect(stats.exDividends).toBe(1); // 000002
    expect(stats.skipped["no-price"]).toBe(1); // 000003
    expect(stats.namesUpdated).toBe(2);
    expect(stats.marketCapsUpdated).toBe(2);
    expect(stats.indexBarsWritten).toBe(1);

    expect(store.latestTradeDate()).toBe(D1);
    expect(store.readBars("000001", 1)[0]?.close).toBe(10.5);
    expect(store.readInstrument("000001")?.name).toBe("平安银行");
    expect(store.readInstrument("000001")?.floatMarketCap).toBe(3e8);
    expect(store.readIndexBars("sh000001", 1)[0]?.close).toBe(3840.83);
  });

  it("不相邻时不做除权改因子，并在 notes 里说明缺口", async () => {
    // 日历里有 09-29，但库内最后一根停在 09-25 —— 中间那天缺数据
    const sparse = new MarketStore(join(dir, "sparse.sqlite"));
    sparse.migrate();
    sparse.upsertInstruments([instrument("000001")]);
    sparse.insertBars("000001", [bar(20260925, 20)]);
    sparse.insertCalendarDates([20260925, 20260929, D1]);

    const stats = await runIncrement(
      sparse,
      { fetchSnapshot: async () => [snapshot("sz000001", { prevClose: 19.5, price: 19.8 })] },
      { ensureCalendar: false },
    );

    expect(stats.exDividends).toBe(0); // 不相邻 → 不判定
    expect(sparse.readBars("000001", 1)[0]?.adjFactor).toBe(1); // 因子未被改歪
    expect(stats.notes.join()).toContain("不是相邻交易日");
    sparse.close();
  });

  it("日历缺失时自动补指数与日历（用注入的假历史，不触网）", async () => {
    const fresh = new MarketStore(join(dir, "fresh.sqlite"));
    fresh.migrate();
    fresh.upsertInstruments([instrument("000001")]);
    fresh.insertBars("000001", [bar(D0, 10)]);

    const calls: string[] = [];
    const fakeHistory = async (symbol: string) => {
      calls.push(symbol);
      return [
        { date: "2026-09-29", open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { date: "2026-09-30", open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ];
    };

    const stats = await runIncrement(
      fresh,
      { fetchSnapshot: fakeSnapshot, fetchIndexHistory: fakeHistory },
    );

    expect(calls).toEqual([...INDEX_SYMBOLS]);
    expect(stats.calendarDates).toBe(2);
    expect(stats.notes.join()).toContain("交易日历");
    expect(fresh.calendarRange()).toEqual({ from: D0, to: D1 });
    fresh.close();
  });
});

describe("backfillIndexHistory", () => {
  it("写入指数日线并据此建立交易日历", async () => {
    const result = await backfillIndexHistory(
      store,
      {
        fetchIndexHistory: async () => [
          { date: "2026-09-25", open: 1, high: 2, low: 1, close: 2, volume: 10 },
          { date: "2026-09-29", open: 2, high: 3, low: 2, close: 3, volume: 20 },
        ],
      },
      400,
    );
    expect(result.indexBars).toBe(4); // 两个指数 × 两根
    expect(result.calendarDates).toBe(2);
    expect(store.readIndexBars("sh000001")).toHaveLength(2);
    expect(store.readIndexBars("sz399006")).toHaveLength(2);
  });
});

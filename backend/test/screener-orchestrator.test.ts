import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PromptCache } from "../src/cache.js";
import type { IncrementStats } from "../src/market/increment.js";
import { MarketStore, type BarRow } from "../src/market/store.js";
import { cacheFingerprint, runScreen, shanghaiDateKey } from "../src/screener/orchestrator.js";
import type { ScreenRequestParams } from "../src/screener/response.js";
import type { ScreenerCriteria } from "../src/screener/types.js";
import { goodSecurity, resetDates } from "./helpers/screener-fixtures.js";

/**
 * 编排层：惰性刷新 + 当日缓存。
 *
 * 全程不触网——增量入口是必填依赖，测试必须显式注入假实现，
 * 因此"忘记注入就真的打出去十几个请求"这种事在类型层面就不可能发生。
 */

let dir: string;
let dbPath: string;
let store: MarketStore;
/** 库内最新交易日（夹具生成的），用于构造"已是最新"与"落后一天"两种时钟 */
let latestDateKey: number;

const CRITERIA: ScreenerCriteria = { mode: "trend", strictness: "standard", includeBeijing: false };
const PARAMS: ScreenRequestParams = {
  mode: "trend",
  strictness: "standard",
  boards: ["main", "growth", "star"],
  ignoreMarketGate: false,
  refresh: false,
};

const emptyStats = (snapshotDate: number | null): IncrementStats => ({
  snapshotDate,
  previousLatestDate: null,
  symbolsRequested: 0,
  rowsReturned: 0,
  requests: 0,
  barsWritten: 0,
  barsRefreshed: 0,
  exDividends: 0,
  skipped: {},
  namesUpdated: 0,
  marketCapsUpdated: 0,
  indexBarsWritten: 0,
  calendarDates: 0,
  notes: [],
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "orchestrator-"));
  dbPath = join(dir, "kline.sqlite");
  store = new MarketStore(dbPath);
  store.migrate();
  resetDates();
  const security = goodSecurity({ code: "000001", name: "平安银行" });
  store.upsertInstruments([
    {
      code: "000001",
      market: "sz",
      board: "main",
      name: "平安银行",
      listedStart: 20200101,
      listedEnd: security.bars[security.bars.length - 1]!.date,
      isLive: true,
      floatMarketCap: 4e9,
    },
  ]);
  store.insertBars("000001", security.bars as BarRow[]);
  // 让"库内最新日"的下一个交易日正好是 09-30
  store.insertCalendarDates([security.bars[security.bars.length - 1]!.date, 20260930]);
  latestDateKey = store.latestTradeDate() as number;
  store.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const open = () => new MarketStore(dbPath);

/** 构造某个交易日北京时间中午的时钟。 */
function nowOn(dateKey: number): Date {
  const year = Math.floor(dateKey / 10000);
  const month = Math.floor(dateKey / 100) % 100;
  const day = dateKey % 100;
  return new Date(Date.UTC(year, month - 1, day, 4, 0));
}

function deps(over: {
  now?: () => Date;
  runIncrement?: (s: MarketStore) => Promise<IncrementStats>;
  cache?: PromptCache<{ response: import("../src/screener/response.js").ScreenResponse }>;
  throttle?: number;
}) {
  return {
    openStore: open,
    runIncrement: over.runIncrement ?? (async () => emptyStats(null)),
    // 默认时钟取库内最新交易日的当天中午 —— 即"库已是最新"
    now: over.now ?? (() => nowOn(latestDateKey)),
    ...(over.cache ? { cache: over.cache } : {}),
    ...(over.throttle !== undefined ? { incrementThrottleMs: over.throttle } : {}),
  };
}

const run = (over: Parameters<typeof deps>[0] = {}, refresh = false) =>
  runScreen(
    { criteria: CRITERIA, params: { ...PARAMS, refresh }, limit: 10, refresh },
    deps(over),
  );

describe("shanghaiDateKey", () => {
  it("按上海时区取当天，而不是 UTC 的当天", () => {
    // UTC 还是 09-29 的傍晚，上海已经是 09-30 的凌晨
    expect(shanghaiDateKey(new Date("2026-09-29T17:00:00Z"))).toBe(20260930);
    expect(shanghaiDateKey(new Date("2026-09-29T15:59:00Z"))).toBe(20260929);
    expect(shanghaiDateKey(new Date("2026-09-30T00:30:00Z"))).toBe(20260930);
  });
});

describe("惰性刷新", () => {
  it("库落后于今天就先跑增量", async () => {
    const runIncrement = vi.fn(async () => emptyStats(20260930));
    const result = await run({ runIncrement, now: () => new Date("2026-09-30T04:00:00Z") });

    expect(runIncrement).toHaveBeenCalledTimes(1);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.increment.ran).toBe(true);
    expect(result.increment.snapshotDate).toBe(20260930);
  });

  it("库已是最新交易日则不打数据源", async () => {
    const runIncrement = vi.fn(async () => emptyStats(latestDateKey));
    const result = await run({ runIncrement, now: () => nowOn(latestDateKey) });
    expect(runIncrement).not.toHaveBeenCalled();
    if (result.kind !== "ok") return;
    expect(result.increment.ran).toBe(false);
  });

  it("节流窗口内不重复尝试（休市/节假日里不该每次点击都白打十几个请求）", async () => {
    const runIncrement = vi.fn(async () => emptyStats(20260930));
    const cache = new PromptCache<{ response: never }>(60_000);

    // 第一次：跑增量并记下尝试时间
    await run({ runIncrement, now: () => new Date("2026-09-30T04:00:00Z"), cache: cache as never });
    expect(runIncrement).toHaveBeenCalledTimes(1);

    // 第二次：库仍落后，但距上次尝试只有 1 分钟 < 节流 15 分钟
    await run({
      runIncrement,
      now: () => new Date("2026-09-30T04:01:00Z"),
      cache: cache as never,
    });
    expect(runIncrement).toHaveBeenCalledTimes(1);
  });

  it("强制刷新忽略节流，再跑一次增量", async () => {
    const runIncrement = vi.fn(async () => emptyStats(20260930));
    const cache = new PromptCache<{ response: never }>(60_000);

    await run({ runIncrement, now: () => new Date("2026-09-30T04:00:00Z"), cache: cache as never });
    await run(
      { runIncrement, now: () => new Date("2026-09-30T04:01:00Z"), cache: cache as never },
      true,
    );
    expect(runIncrement).toHaveBeenCalledTimes(2);
  });

  it("增量失败不阻断筛选：本地数据照常出结果，但如实标注失败", async () => {
    const result = await run({
      runIncrement: async () => {
        throw new Error("腾讯批量快照请求失败：HTTP 502");
      },
      now: () => new Date("2026-09-30T04:00:00Z"),
    });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.increment.failed).toBe(true);
    expect(result.increment.error).toContain("502");
    // 仍然按库内既有数据给出了候选
    expect(result.response.funnel.universe).toBe(1);
  });
});

describe("当日缓存", () => {
  it("同参数重复调用命中缓存（拿到的是同一次响应）", async () => {
    const cache = new PromptCache<{ response: never }>(60_000);
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 8, 29, 4, 0, tick++));

    const first = await run({ cache: cache as never, now });
    const second = await run({ cache: cache as never, now });

    expect(first.kind).toBe("ok");
    expect(second.kind).toBe("ok");
    if (first.kind !== "ok" || second.kind !== "ok") return;
    expect(first.fromCache).toBe(false);
    expect(second.fromCache).toBe(true);
    // refreshedAt 相同 → 确实返回的是上一次的结果，而不是重算了一遍
    expect(second.response.refreshedAt).toBe(first.response.refreshedAt);
  });

  it("强制刷新绕过缓存并重算", async () => {
    const cache = new PromptCache<{ response: never }>(60_000);
    let tick = 0;
    const now = () => new Date(Date.UTC(2026, 8, 29, 4, 0, tick++));

    const first = await run({ cache: cache as never, now });
    const second = await run({ cache: cache as never, now }, true);

    if (first.kind !== "ok" || second.kind !== "ok") throw new Error("应当成功");
    expect(second.fromCache).toBe(false);
    expect(second.response.refreshedAt).not.toBe(first.response.refreshedAt);
  });

  it("数据指纹变化后缓存失效（增量刷新了 last_increment_at）", async () => {
    store = open();
    const before = cacheFingerprint(store);
    store.setMeta("last_increment_at", new Date().toISOString());
    const after = cacheFingerprint(store);
    store.close();

    expect(after).not.toBe(before);
  });

  it("参数不同即视为不同结果", async () => {
    const cache = new PromptCache<{ response: never }>(60_000);
    const now = () => new Date("2026-09-29T04:00:00Z");

    await run({ cache: cache as never, now });
    const other = await runScreen(
      {
        criteria: { ...CRITERIA, strictness: "strict" },
        params: { ...PARAMS, strictness: "strict" },
        limit: 10,
        refresh: false,
      },
      deps({ cache: cache as never, now }),
    );
    if (other.kind !== "ok") throw new Error("应当成功");
    expect(other.fromCache).toBe(false);
  });
});

describe("结果内容", () => {
  it("候选带上名称与成交价（数据层回填后界面才有东西可显示）", async () => {
    const result = await run();
    if (result.kind !== "ok") throw new Error("应当成功");
    const candidate = result.response.candidates[0];
    expect(candidate?.code).toBe("000001");
    expect(candidate?.name).toBe("平安银行");
    expect(candidate?.price).toBeGreaterThan(0);
  });

  it("库为空时返回 empty，由路由映射成 DATA_NOT_READY（而不是造一条空结果）", async () => {
    const emptyPath = join(dir, "empty.sqlite");
    const empty = new MarketStore(emptyPath);
    empty.migrate();
    empty.close();

    const result = await runScreen(
      { criteria: CRITERIA, params: PARAMS, limit: 10, refresh: false },
      { ...deps({}), openStore: () => new MarketStore(emptyPath) },
    );
    expect(result.kind).toBe("empty");
  });
});

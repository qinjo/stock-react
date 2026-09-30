import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { openMarketStore } from "../src/market/open.js";
import { MarketStore, type BarRow } from "../src/market/store.js";
import type { Board } from "../src/market/qlib.js";
import type { SecurityInput } from "../src/screener/types.js";
import { goodSecurity, resetDates } from "./helpers/screener-fixtures.js";
import type { IncrementStats } from "../src/market/increment.js";

/** 假增量：本测试的文件绝不触网；需要断言的用例再包一层 spy。 */
const noopStats = (): IncrementStats => ({
  snapshotDate: null,
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

/**
 * 筛选端点的契约测试：走 `app.inject()`，不占端口、不触网。
 * 库用临时文件里的真 SQLite，因此"库未就绪"这类状态是真的被触发出来的，不是 mock 出来的。
 */

let dir: string;
let dbPath: string;
/** 种库后库内的最新交易日，用于断言接口回传的数据截止日 */
let latestDateKey: number;
const NOW = new Date("2026-09-30T08:00:00.000Z");

function seed(store: MarketStore, security: SecurityInput, board: Board, name: string | null): void {
  store.upsertInstruments([
    {
      code: security.code,
      market: "sz",
      board,
      name,
      listedStart: 20200101,
      listedEnd: 20260929,
      isLive: true,
    },
  ]);
  store.insertBars(security.code, security.bars as BarRow[]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "screen-route-"));
  dbPath = join(dir, "kline.sqlite");
  const store = new MarketStore(dbPath);
  store.migrate();
  // 三只标的必须共用同一条时间轴：否则"全市场最新交易日"只对得上其中一只，
  // 其余会被「当日停牌」规则剔除，测的就不是想测的东西了
  resetDates();
  seed(store, goodSecurity({ code: "000001" }), "main", "平安银行");
  resetDates();
  seed(store, goodSecurity({ code: "300750" }), "growth", "宁德时代");
  resetDates();
  seed(store, goodSecurity({ code: "920002" }), "bj", "万达轴承");
  latestDateKey = store.latestTradeDate() as number;

  // 指数日线：大盘门要据此判定，因此必须真的种进去（否则只会走"缺数据"的兜底）
  const indexCloses = Array.from({ length: 150 }, (_, i) => 3000 + i * 5);
  const indexRows = indexCloses.map((close, i) => ({
    date: (goodSecurity().bars[0] as { date: number }).date + i,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
  }));
  store.insertIndexBars("sh000001", indexRows);
  store.insertIndexBars("sz399006", indexRows);
  store.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function app() {
  return buildApp({
    screener: {
      openStore: () => new MarketStore(dbPath),
      runIncrement: async () => noopStats(),
      now: () => NOW,
    },
  });
}

describe("GET /api/screen 成功路径", () => {
  it("返回统一成功形状：数据截止日、刷新时间、漏斗、候选、参数回显", async () => {
    const res = await app().inject({ method: "GET", url: "/api/screen" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.status).toBe("ok");
    // 数据截止日必须来自库内最新交易日，而不是服务器当前日期
    const expected = `${String(latestDateKey).slice(0, 4)}-${String(latestDateKey).slice(4, 6)}-${String(latestDateKey).slice(6, 8)}`;
    expect(body.dataDate).toBe(expected);
    expect(body.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.refreshedAt).toBe(NOW.toISOString());
    expect(body.params).toEqual({
      mode: "trend",
      strictness: "standard",
      boards: ["main", "growth", "star"],
      ignoreMarketGate: false,
      refresh: false,
    });
    expect(body.funnel.universe).toBe(2); // 默认不含北交所
    expect(body.candidateTotal).toBe(2);
    expect(body.candidates).toHaveLength(2);
  });

  it("候选携带真实成交价、涨跌幅与量化画像", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen" })).json();
    const candidate = body.candidates[0];
    expect(candidate.code).toBeTruthy();
    // 名称来自标的清单（bootstrap 阶段为 null，这里种了名字）
    expect(["平安银行", "宁德时代"]).toContain(candidate.name);
    expect(candidate.price).toBeGreaterThan(0);
    // 报价只到分：浮点缩放值的尾数噪声必须在这里被收口，否则界面会显示 27.13000005081679
    expect(candidate.price).toBe(Math.round(candidate.price * 100) / 100);
    expect(typeof candidate.changePercent).toBe("number");
    expect(candidate.metrics.ma100).toBeGreaterThan(0);
    expect(candidate.metrics.ma100Deviation).toBeGreaterThan(0);
  });

  it("候选带规则明细与来源标注，供界面展开核对", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen" })).json();
    const hits = body.candidates[0].ruleHits;
    expect(hits.length).toBeGreaterThan(0);
    const ma100 = hits.find((h: { id: string }) => h.id === "U-ma100");
    expect(ma100.bookRef).toBe("L597");
    expect(ma100.source).toBe("book");
    expect(ma100.detail).toContain("MA100");
  });

  it("未接入大模型复核时显式标为降级，而不是让界面以为已复核", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen" })).json();
    expect(body.degraded.llmReview).toBe(true);
    expect(body.degraded.reason).toContain("确定性规则");
  });

  it("缺流通市值数据时把市值闸门列为未生效", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen" })).json();
    expect(body.inactiveRules).toContain("U-marketCap");
    expect(body.candidates[0].deductions.join()).toContain("流通市值");
  });
});

describe("GET /api/screen 参数与板块", () => {
  it("boards 打开北交所后纳入其标的", async () => {
    const body = (
      await app().inject({ method: "GET", url: "/api/screen?boards=main,growth,star,bj" })
    ).json();
    expect(body.funnel.universe).toBe(3);
    expect(body.candidates.map((c: { code: string }) => c.code)).toContain("920002");
  });

  it("只选主板时北交所与创业板都不在池内", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen?boards=main" })).json();
    expect(body.funnel.universe).toBe(1);
    expect(body.candidates.map((c: { code: string }) => c.code)).toEqual(["000001"]);
  });

  it("limit 截断候选但候选总数仍如实反映", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen?limit=1" })).json();
    expect(body.candidates).toHaveLength(1);
    expect(body.candidateTotal).toBe(2);
  });

  it("严格度与模式被接受并回显", async () => {
    const body = (
      await app().inject({
        method: "GET",
        url: "/api/screen?mode=event&strictness=strict&ignoreMarketGate=true&refresh=true",
      })
    ).json();
    expect(body.params).toEqual({
      mode: "event",
      strictness: "strict",
      boards: ["main", "growth", "star"],
      ignoreMarketGate: true,
      refresh: true,
    });
  });

  it("三档严格度都会被执行（严格档要求 250 根，300 根的标的仍通过）", async () => {
    for (const tier of ["loose", "standard", "strict"]) {
      const res = await app().inject({ method: "GET", url: `/api/screen?strictness=${tier}` });
      expect(res.statusCode, tier).toBe(200);
      expect(res.json().candidateTotal).toBe(2);
    }
  });
});

describe("GET /api/screen 错误契约", () => {
  it("非法参数返回 400 INVALID_INPUT，并指出合法取值", async () => {
    const cases = [
      "/api/screen?mode=打板",
      "/api/screen?strictness=turbo",
      "/api/screen?boards=main,港股",
      "/api/screen?limit=0",
      "/api/screen?limit=abc",
      "/api/screen?refresh=maybe",
    ];
    for (const url of cases) {
      const res = await app().inject({ method: "GET", url });
      expect(res.statusCode, url).toBe(400);
      expect(res.json().code, url).toBe("INVALID_INPUT");
    }
  });

  it("库文件不存在时返回 503 DATA_NOT_READY，并给出可操作提示", async () => {
    const missing = buildApp({
      screener: {
        openStore: () => openMarketStore(join(dir, "不存在.sqlite")),
        runIncrement: async () => noopStats(),
      },
    });
    const res = await missing.inject({ method: "GET", url: "/api/screen" });
    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.code).toBe("DATA_NOT_READY");
    // 与 SOURCE_UNAVAILABLE 的区别正是这条：它告诉用户该做什么
    expect(body.message).toContain("bootstrap:kline");
  });

  it("库存在但没有日线时同样是 DATA_NOT_READY（不是「筛出 0 只」）", async () => {
    const emptyPath = join(dir, "empty.sqlite");
    const empty = new MarketStore(emptyPath);
    empty.migrate();
    empty.close();

    const emptyApp = buildApp({
      screener: { openStore: () => new MarketStore(emptyPath), runIncrement: async () => noopStats() },
    });
    const res = await emptyApp.inject({ method: "GET", url: "/api/screen" });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("DATA_NOT_READY");
    expect(res.json().message).toContain("空的");
  });

  it("筛出 0 只是正常 200，与故障态区分开", async () => {
    const strictPath = join(dir, "no-candidate.sqlite");
    const store = new MarketStore(strictPath);
    store.migrate();
    // 一根日线都没有的标的会被适配层跳过；这里种一只跌破 MA100 的票，规则层把它筛掉
    resetDates();
    seed(
      store,
      goodSecurity({
        code: "600001",
        bars: goodSecurity().bars.map((b, i) => ({ ...b, close: 30 - i * 0.05 })),
      }),
      "main",
      "下跌股",
    );
    store.close();

    const strictApp = buildApp({
      screener: { openStore: () => new MarketStore(strictPath), runIncrement: async () => noopStats() },
    });
    const res = await strictApp.inject({ method: "GET", url: "/api/screen" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidateTotal).toBe(0);
    expect(body.candidates).toEqual([]);
    expect(body.funnel.shortlisted).toBe(0);
  });
});

/* ------------------------------- 大盘门（#22） ------------------------------- */

describe("GET /api/screen 的大盘门", () => {
  it("响应带上大盘门判定与建议总仓位", async () => {
    const body = (await app().inject({ method: "GET", url: "/api/screen" })).json();
    expect(body.marketGate).toBeTruthy();
    expect(body.marketGate.state).toBe("offense");
    expect(body.marketGate.positionAdvice).toBeGreaterThan(0);
    expect(body.marketGate.reason).toContain("进攻档");
    expect(body.suppressed).toBe(false);
  });

  it("空仓档默认不出票：候选清空，但候选总数与漏斗仍如实给出", async () => {
    const emptyPath = join(dir, "empty-gate.sqlite");
    const store = new MarketStore(emptyPath);
    store.migrate();
    resetDates();
    seed(store, goodSecurity({ code: "000001" }), "main", "平安银行");
    const last = store.latestTradeDate() as number;
    // 指数一路下跌 → 跌破 MA100 → 空仓档
    const falling = Array.from({ length: 150 }, (_, i) => ({ date: last - 149 + i, open: 3000 - i * 5, high: 3000 - i * 5, low: 3000 - i * 5, close: 3000 - i * 5, volume: 1 }));
    store.insertIndexBars("sh000001", falling);
    store.insertIndexBars("sz399006", falling);
    store.close();

    const emptyApp = buildApp({
      screener: { openStore: () => new MarketStore(emptyPath), runIncrement: async () => noopStats() },
    });
    const res = await emptyApp.inject({ method: "GET", url: "/api/screen" });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.marketGate.state).toBe("empty");
    expect(body.suppressed).toBe(true);
    expect(body.candidates).toEqual([]);
    // 但"本来有几只符合个股条件"必须还能看到，否则用户无从判断要不要用逃生开关
    expect(body.candidateTotal).toBe(1);
    expect(body.funnel.signalEligible).toBe(1);
  });

  it("ignoreMarketGate=true 时照常出票（逃生开关）", async () => {
    const openPath = join(dir, "empty-gate-2.sqlite");
    const store = new MarketStore(openPath);
    store.migrate();
    resetDates();
    seed(store, goodSecurity({ code: "000001" }), "main", "平安银行");
    const last = store.latestTradeDate() as number;
    const falling = Array.from({ length: 150 }, (_, i) => ({ date: last - 149 + i, open: 3000 - i * 5, high: 3000 - i * 5, low: 3000 - i * 5, close: 3000 - i * 5, volume: 1 }));
    store.insertIndexBars("sh000001", falling);
    store.insertIndexBars("sz399006", falling);
    store.close();

    const openApp = buildApp({
      screener: { openStore: () => new MarketStore(openPath), runIncrement: async () => noopStats() },
    });
    const res = await openApp.inject({ method: "GET", url: "/api/screen?ignoreMarketGate=true" });
    const body = res.json();
    expect(body.params.ignoreMarketGate).toBe(true);
    expect(body.suppressed).toBe(false);
    expect(body.candidates).toHaveLength(1);
  });
});

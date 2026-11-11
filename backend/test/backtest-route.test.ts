import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MarketStore, type BarRow } from "../src/market/store.js";
import { openMarketStore } from "../src/market/open.js";
import { bar, barsFromCloses } from "./helpers/backtest-fixtures.js";

/**
 * `GET /api/backtest` 的契约测试：走 `app.inject()`，不占端口、不触网。
 *
 * 库用临时文件里的真 SQLite——"库未就绪"这类状态是被真的触发出来的，不是 mock 出来的。
 */

let dir: string;
let dbPath: string;
const NOW = new Date("2026-09-30T08:00:00.000Z");

/** 造一段必有金叉/死叉的收盘序列：先跌、再涨、再跌。 */
function scenarioCloses(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 20; i++) closes.push(12 - i * 0.2);
  for (let i = 0; i < 20; i++) closes.push(8.2 + 0.28 * (i + 1));
  for (let i = 0; i < 20; i++) closes.push(13.8 - 0.22 * (i + 1));
  return closes;
}

function seed(store: MarketStore, code: string, name: string, closes: number[]): void {
  const raw = barsFromCloses(closes, 20250102);
  // 第 8 根做成涨停（前收 × 1.1 精确封板），供宇宙的「有过涨停」条件
  const prevClose = closes[7] as number;
  const limit = Math.round(prevClose * 1.1 * 100) / 100;
  raw[8] = bar(raw[8]!.date, limit, {
    open: (closes[7] as number) + 0.01,
    high: limit,
    low: (closes[7] as number) - 0.01,
    amount: 9e8,
  });
  // 之后的价格必须从涨停价接续，否则序列断裂
  const rest = raw.slice(9).map((item, index) => {
    const scale = limit / (closes[8] as number);
    return { ...item, close: item.close * scale, open: item.open * scale, high: item.high * scale, low: item.low * scale };
  });

  store.upsertInstruments([
    {
      code,
      market: "sh",
      board: "main",
      name,
      listedStart: 20240101,
      listedEnd: raw[raw.length - 1]!.date,
      isLive: true,
    },
  ]);
  store.insertBars(code, [...raw.slice(0, 9), ...rest] as BarRow[]);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "backtest-route-"));
  dbPath = join(dir, "kline.sqlite");
  const store = new MarketStore(dbPath);
  store.migrate();

  const closes = scenarioCloses();
  seed(store, "600001", "甲股票", closes);
  // 第二只：成交额小，用来确认"全市场"分母；内容与第一只相同即可
  seed(store, "600002", "乙股票", closes);
  store.fillCalendarFromBars();
  store.close();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function app(overrides: { openStore?: () => MarketStore } = {}) {
  return buildApp({
    backtest: {
      openStore: overrides.openStore ?? (() => new MarketStore(dbPath)),
      now: () => NOW,
    },
  });
}

describe("GET /api/backtest 成功路径", () => {
  it("返回参数回显、样本漏斗、统计、分桶与两端个股", async () => {
    const instance = app();
    try {
      const res = await instance.inject({
        method: "GET",
        url: "/api/backtest?from=2025-01-02&hotTop=10&window=20&boards=main",
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.status).toBe("ok");
      expect(body.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(body.from).toBe("2025-01-02");
      expect(body.params.hotTopN).toBe(10);
      expect(body.params.hotWindow).toBe(20);
      expect(body.params.kdjPeriod).toBe(9);
      expect(body.universe).toContain("成交额横截面排名前 10");
      expect(body.window.instruments).toBe(2);
      expect(body.window.backtested).toBe(2);
      expect(body.summary.stocks).toBe(2);
      // 夹具里构造了金叉 + 宇宙条件，必须真的成交出交易
      expect(body.summary.trades).toBeGreaterThan(0);
      expect(body.stocks.traded).toBeGreaterThan(0);
      expect(body.stocks.best.length).toBeGreaterThan(0);
      expect(body.stocks.worst.length).toBeGreaterThan(0);
      expect(body.buckets.year.length).toBeGreaterThan(0);
      expect(body.buckets.board.length).toBeGreaterThan(0);
      expect(Array.isArray(body.histogram)).toBe(true);
      expect(body.fromCache).toBe(false);
      expect(typeof body.elapsedMs).toBe("number");
    } finally {
      await instance.close();
    }
  });

  it("同一天同参数第二次请求直接命中缓存", async () => {
    const instance = app();
    try {
      const url = "/api/backtest?from=2025-01-02&hotTop=10&window=20&boards=main";
      const first = await instance.inject({ method: "GET", url });
      expect(first.json().fromCache).toBe(false);
      const second = await instance.inject({ method: "GET", url });
      expect(second.statusCode).toBe(200);
      expect(second.json().fromCache).toBe(true);
      // 缓存命中也必须返回完整结果，而不是空壳
      expect(second.json().summary.trades).toBe(first.json().summary.trades);
    } finally {
      await instance.close();
    }
  });

  it("refresh=true 绕过缓存重算", async () => {
    const instance = app();
    try {
      const url = "/api/backtest?from=2025-01-02&hotTop=10&window=20&boards=main";
      await instance.inject({ method: "GET", url });
      const refreshed = await instance.inject({ method: "GET", url: `${url}&refresh=true` });
      expect(refreshed.json().fromCache).toBe(false);
    } finally {
      await instance.close();
    }
  });

  it("sample 限制抽样只跑一部分标的", async () => {
    const instance = app();
    try {
      const res = await instance.inject({
        method: "GET",
        url: "/api/backtest?from=2025-01-02&hotTop=10&window=20&sample=100",
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().sample).toBe(100);
      expect(res.json().window.instruments).toBe(2);
    } finally {
      await instance.close();
    }
  });
});

describe("GET /api/backtest 错误契约", () => {
  it("库不存在 → DATA_NOT_READY(503)，而不是 SOURCE_UNAVAILABLE", async () => {
    const instance = app({
      openStore: () => openMarketStore(join(dir, "missing.sqlite")),
    });
    try {
      const res = await instance.inject({ method: "GET", url: "/api/backtest" });
      expect(res.statusCode).toBe(503);
      expect(res.json().code).toBe("DATA_NOT_READY");
    } finally {
      await instance.close();
    }
  });

  it("参数非法 → INVALID_INPUT(400)", async () => {
    const instance = app();
    try {
      const badHotTop = await instance.inject({
        method: "GET",
        url: "/api/backtest?hotTop=1",
      });
      expect(badHotTop.statusCode).toBe(400);
      expect(badHotTop.json().code).toBe("INVALID_INPUT");

      const badDate = await instance.inject({
        method: "GET",
        url: "/api/backtest?from=2025/01/02",
      });
      expect(badDate.statusCode).toBe(400);

      const badBoard = await instance.inject({
        method: "GET",
        url: "/api/backtest?boards=main,nyse",
      });
      expect(badBoard.statusCode).toBe(400);

      const badRange = await instance.inject({
        method: "GET",
        url: "/api/backtest?from=2025-06-01&to=2025-01-02",
      });
      expect(badRange.statusCode).toBe(400);
    } finally {
      await instance.close();
    }
  });
});

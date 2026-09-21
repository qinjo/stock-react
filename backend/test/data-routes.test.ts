import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/datasource.js", () => ({
  fetchQuote: vi.fn(),
  fetchKline: vi.fn(),
}));

vi.mock("../src/tencent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tencent.js")>();
  return { ...actual, fetchSuggest: vi.fn() };
});

import { buildApp } from "../src/app.js";
import { fetchKline, fetchQuote } from "../src/datasource.js";
import { fetchSuggest } from "../src/tencent.js";

const app = buildApp();

afterEach(() => {
  vi.clearAllMocks();
});

describe("数据路由的输入校验与错误契约", () => {
  it("/api/quote 缺少 code 返回 400 INVALID_INPUT", async () => {
    const res = await app.inject({ method: "GET", url: "/api/quote" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error", code: "INVALID_INPUT" });
  });

  it("/api/kline 缺少 code 返回 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/kline" });
    expect(res.statusCode).toBe(400);
  });

  it("/api/search 空查询返回空候选而非报错", async () => {
    const res = await app.inject({ method: "GET", url: "/api/search?q=" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ candidates: [] });
    expect(fetchSuggest).not.toHaveBeenCalled();
  });

  it("数据源故障映射为 502 SOURCE_UNAVAILABLE", async () => {
    vi.mocked(fetchQuote).mockRejectedValue(new Error("IP 级反爬触发"));

    const res = await app.inject({ method: "GET", url: "/api/quote?code=600519" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ status: "error", code: "SOURCE_UNAVAILABLE" });
  });

  it("无法识别的代码映射为 400 而非 502", async () => {
    vi.mocked(fetchQuote).mockRejectedValue(new Error("无法识别的股票代码：茅台"));

    const res = await app.inject({ method: "GET", url: "/api/quote?code=茅台" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("kline limit 被限制在 1..500", async () => {
    vi.mocked(fetchKline).mockResolvedValue([]);

    await app.inject({ method: "GET", url: "/api/kline?code=600519&limit=9999" });
    expect(fetchKline).toHaveBeenLastCalledWith("600519", 500);

    await app.inject({ method: "GET", url: "/api/kline?code=600519&limit=0" });
    expect(fetchKline).toHaveBeenLastCalledWith("600519", 1);

    await app.inject({ method: "GET", url: "/api/kline?code=600519" });
    expect(fetchKline).toHaveBeenLastCalledWith("600519", 60);
  });
});

describe("/api/indicators", () => {
  it("默认拉取 250 根以便计算 SMA200", async () => {
    vi.mocked(fetchKline).mockResolvedValue([]);

    await app.inject({ method: "GET", url: "/api/indicators?code=600519" });
    expect(fetchKline).toHaveBeenLastCalledWith("600519", 250);
  });

  it("数据不足映射为 400 INSUFFICIENT_DATA（abstain 契约）", async () => {
    const few = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      open: 1,
      close: 1,
      high: 1,
      low: 1,
      volume: 1,
      amount: null,
      amplitude: null,
      changePercent: null,
      changeAmount: null,
      turnoverRate: null,
    }));
    vi.mocked(fetchKline).mockResolvedValue(few);

    const res = await app.inject({ method: "GET", url: "/api/indicators?code=600519" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ status: "error", code: "INSUFFICIENT_DATA" });
  });

  it("缺少 code 返回 400", async () => {
    const res = await app.inject({ method: "GET", url: "/api/indicators" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });
});

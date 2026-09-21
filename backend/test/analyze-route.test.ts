import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/datasource.js", () => ({
  fetchQuote: vi.fn(),
  fetchKline: vi.fn(),
}));

import { buildApp } from "../src/app.js";
import { fetchKline, fetchQuote } from "../src/datasource.js";
import type { Kline, Quote } from "../src/domain.js";
import type { ChatFn } from "../src/analysis/llm.js";

const quote: Quote = {
  code: "600519",
  name: "贵州茅台",
  price: 1257.12,
  open: 1262.99,
  high: 1265.88,
  low: 1256.1,
  prevClose: 1266.98,
  changePercent: -0.78,
  limitUp: 1393.68,
  limitDown: 1140.28,
  volume: 24891,
  amount: 3135849108,
  marketCap: 1571503000000,
  floatMarketCap: 1571503000000,
  pe: 17.65,
  pb: 6.25,
  turnoverRate: 0.2,
};

/** 生成 n 根可用的日 K（价格带轻微波动，保证指标可算）。 */
function makeKlines(n: number): Kline[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 1200 + Math.sin(i / 5) * 50;
    return {
      date: `2026-${String(Math.floor(i / 28) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`,
      open: close - 5,
      close,
      high: close + 10,
      low: close - 10,
      volume: 20000 + i,
      amount: null,
      amplitude: null,
      changePercent: null,
      changeAmount: null,
      turnoverRate: null,
    };
  });
}

const goodAnalysis = JSON.stringify({
  rating: "hold",
  confidence: 55,
  reasoning: "多空交织",
  price_target: null,
  time_horizon: null,
  sections: { snapshot: "s", fundamentals: "f", technicals: "t", risks: ["r"], conclusion: "c" },
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/analyze", () => {
  it("缺少 code 返回 400", async () => {
    const app = buildApp({ chat: vi.fn() });
    const res = await app.inject({ method: "GET", url: "/api/analyze" });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("未配置 API key 时返回 503 且提示配置缺失（不泄露细节）", async () => {
    const app = buildApp({ chat: undefined, apiKey: "" });
    // 确保不受宿主环境变量影响
    const prev = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      const res = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });
      expect(res.statusCode).toBe(503);
      const body = res.json();
      expect(body.code).toBe("ANALYSIS_FAILED");
      expect(body.message).toContain("DEEPSEEK_API_KEY");
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
    }
  });

  it("正常链路返回结构化分析（fake LLM，不触网）", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(250));
    const chat: ChatFn = vi.fn().mockResolvedValue(goodAnalysis);

    const app = buildApp({ chat, model: "deepseek-chat" });
    const res = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("ok");
    expect(body.analysis.rating).toBe("hold");
    expect(body.model).toBe("deepseek-chat");
    expect(body.input).toEqual({ code: "600519", name: "贵州茅台", dataDate: expect.any(String) });
  });

  it("数据不足时返回 400 INSUFFICIENT_DATA（abstain 契约，不强行给结论）", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(10));
    const chat: ChatFn = vi.fn().mockResolvedValue(goodAnalysis);

    const app = buildApp({ chat });
    const res = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("INSUFFICIENT_DATA");
    expect(chat).not.toHaveBeenCalled(); // 数据不足不该浪费一次 LLM 调用
  });

  it("LLM 持续失败时返回 502 ANALYSIS_FAILED", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(250));
    const chat: ChatFn = vi.fn().mockRejectedValue(new Error("LLM 返回 HTTP 503"));

    const app = buildApp({ chat });
    const res = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    expect(res.statusCode).toBe(502);
    expect(res.json().code).toBe("ANALYSIS_FAILED");
  });

  it("只向提示词喂入 60 根截尾日 K（指标用全量 250 根）", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(250));
    const chat: ChatFn = vi.fn().mockResolvedValue(goodAnalysis);

    const app = buildApp({ chat });
    await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    const prompt = vi.mocked(chat).mock.calls[0]![0];
    const klineRows = prompt.user.split("\n").filter((l) => /^\d{4}-\d{2}-\d{2},/.test(l));
    expect(klineRows).toHaveLength(60);
    // 指标样本数仍为全量，证明「指标用长历史、提示词用截尾」两条路径并存
    expect(prompt.user).toContain("sampleSize: 250");
  });

  it("健康检查暴露分析就绪状态（前端可提示未配置 key）", async () => {
    const withKey = buildApp({ chat: vi.fn() });
    const withoutKey = buildApp({ apiKey: "" });
    const prev = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    try {
      expect((await withKey.inject({ method: "GET", url: "/api/health" })).json().analysisReady).toBe(
        true,
      );
      expect(
        (await withoutKey.inject({ method: "GET", url: "/api/health" })).json().analysisReady,
      ).toBe(false);
    } finally {
      if (prev !== undefined) process.env.DEEPSEEK_API_KEY = prev;
    }
  });
});

describe("/api/analyze 缓存（同票重复查询）", () => {
  it("同一股票连续两次查询：第二次命中缓存、LLM 只调用一次", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(250));
    const chat: ChatFn = vi.fn().mockResolvedValue(goodAnalysis);

    const app = buildApp({ chat, model: "deepseek-chat", cacheTtlMs: 60_000 });

    const first = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });
    const second = await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    expect(first.json().fromCache).toBe(false);
    expect(second.json().fromCache).toBe(true);
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("TTL 极短时第二次查询会重新调用 LLM", async () => {
    vi.mocked(fetchQuote).mockResolvedValue(quote);
    vi.mocked(fetchKline).mockResolvedValue(makeKlines(250));
    const chat: ChatFn = vi.fn().mockResolvedValue(goodAnalysis);

    const app = buildApp({ chat, model: "deepseek-chat", cacheTtlMs: 1 });

    await app.inject({ method: "GET", url: "/api/analyze?code=600519" });
    await new Promise((r) => setTimeout(r, 5));
    await app.inject({ method: "GET", url: "/api/analyze?code=600519" });

    expect(chat).toHaveBeenCalledTimes(2);
  });
});

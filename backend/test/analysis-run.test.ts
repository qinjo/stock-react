import { describe, expect, it, vi } from "vitest";
import { runAnalysis, type CachedAnalysis } from "../src/analysis/index.js";
import { PromptCache } from "../src/cache.js";
import type { ChatFn } from "../src/analysis/llm.js";
import type { AnalysisInput } from "../src/analysis/types.js";

const input: AnalysisInput = {
  code: "600519",
  name: "贵州茅台",
  dataDate: "2026-09-18",
  quote: {
    price: 1257.12,
    changePercent: -0.78,
    open: 1262.99,
    high: 1265.88,
    low: 1256.1,
    prevClose: 1266.98,
    marketCap: 1571503000000,
    pe: 17.65,
    pb: 6.25,
    turnoverRate: 0.2,
  },
  indicators: { sma50: 1300.97, rsi14: 37.02 },
  klines: [
    { date: "2026-09-18", open: 1262.99, close: 1257.12, high: 1265.88, low: 1256.1, volume: 24891 },
  ],
};

const cleanJson = JSON.stringify({
  rating: "overweight",
  confidence: 72,
  reasoning: "估值偏低但趋势未反转",
  price_target: 1400,
  time_horizon: "3-6 个月",
  sections: {
    snapshot: "快照",
    fundamentals: "基本面",
    technicals: "技术面",
    risks: ["风险一"],
    conclusion: "结论",
  },
});

const fixedNow = () => new Date("2026-08-30T10:00:00.000Z");

describe("runAnalysis 主 seam（fake LLM，永不触网）", () => {
  it("夹具①干净 JSON：返回 ok 与结构化信号", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat", now: fixedNow });

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.analysis.rating).toBe("overweight");
    expect(out.analysis.confidence).toBe(72);
    expect(out.analysis.priceTarget).toBe(1400);
    expect(out.model).toBe("deepseek-chat");
    expect(out.analyzedAt).toBe("2026-08-30T10:00:00.000Z");
    expect(chat).toHaveBeenCalledTimes(1);
  });

  it("夹具②杂散文本：经三级回退仍解析成功", async () => {
    const chat: ChatFn = vi
      .fn()
      .mockResolvedValue({
        content: `好的，以下是分析结果：\n\`\`\`json\n${cleanJson}\n\`\`\`\n希望对你有帮助。`,
      });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.analysis.rating).toBe("overweight");
  });

  it("夹具③空值字符串：可选字段落为 null 而非字符串", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({
      content: JSON.stringify({
        rating: "hold",
        confidence: 50,
        reasoning: "证据不足",
        price_target: "N/A",
        time_horizon: "None",
        sections: { risks: "-" },
      }),
    });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.analysis.priceTarget).toBeNull();
    expect(out.analysis.timeHorizon).toBeNull();
    expect(out.analysis.sections.risks).toEqual([]);
  });

  it("夹具④抛错：重试一次后 abstain，绝不静默变中性", async () => {
    const chat: ChatFn = vi.fn().mockRejectedValue(new Error("LLM 返回 HTTP 503"));

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("abstained");
    if (out.status !== "abstained") throw new Error("unreachable");
    expect(out.reason).toBe("ANALYSIS_FAILED");
    expect(out.detail).toContain("503");
    expect(chat).toHaveBeenCalledTimes(2); // 首次 + 重试一次
  });

  it("首次失败、重试成功时返回 ok（重试有意义）", async () => {
    const chat: ChatFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("偶发超时"))
      .mockResolvedValueOnce({ content: cleanJson });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("ok");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("评级枚举非法：重试后仍失败则 abstain", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: '{"rating":"strong_buy","confidence":90}' });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("abstained");
    if (out.status !== "abstained") throw new Error("unreachable");
    expect(out.detail).toContain("评级");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("retries 可配置（0 表示不重试）", async () => {
    const chat: ChatFn = vi.fn().mockRejectedValue(new Error("失败"));

    const out = await runAnalysis(input, { chat, model: "deepseek-chat", retries: 0 });

    expect(out.status).toBe("abstained");
    expect(chat).toHaveBeenCalledTimes(1);
  });
});

describe("runAnalysis 缓存行为（提示词哈希 + TTL）", () => {
  it("第二次相同输入命中缓存，不再调用 LLM 并标记 fromCache", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    const first = await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    const second = await runAnalysis(input, { chat, model: "deepseek-chat", cache });

    expect(chat).toHaveBeenCalledTimes(1); // 第二次零调用
    expect(first.status === "ok" && first.fromCache).toBe(false);
    expect(second.status === "ok" && second.fromCache).toBe(true);
    // 命中时回传首次的分析时间，便于前端诚实展示
    if (first.status === "ok" && second.status === "ok") {
      expect(second.analyzedAt).toBe(first.analyzedAt);
    }
  });

  it("同一交易日内价格微幅波动仍命中缓存（盘中 tick 不应让缓存永不命中）", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    await runAnalysis(
      { ...input, quote: { ...input.quote, price: input.quote.price! + 1 } },
      { chat, model: "deepseek-chat", cache },
    );

    expect(chat).toHaveBeenCalledTimes(1); // 仍复用，避免每次查询都真实调用
  });

  it("跨交易日（dataDate 变化）缓存失效，绝不返回隔日结论", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    await runAnalysis(
      { ...input, dataDate: "2026-09-19" },
      { chat, model: "deepseek-chat", cache },
    );

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("不同股票互不串用缓存", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    await runAnalysis({ ...input, code: "000001" }, { chat, model: "deepseek-chat", cache });

    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("abstain 结果不写缓存（偶发失败不应在 TTL 内被持续复用）", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockRejectedValue(new Error("瞬时故障"));

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    // 故障恢复后应能正常分析，而不是命中失败缓存
    vi.mocked(chat).mockResolvedValue({ content: cleanJson });
    const out = await runAnalysis(input, { chat, model: "deepseek-chat", cache });

    expect(out.status).toBe("ok");
    expect(cache.stats().size).toBe(1);
  });

  it("缓存过期后重新调用 LLM", async () => {
    let now = 0;
    const cache = new PromptCache<CachedAnalysis>(1000, 200, () => now);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    now += 1001;
    await runAnalysis(input, { chat, model: "deepseek-chat", cache });

    expect(chat).toHaveBeenCalledTimes(2);
  });
});

describe("runAnalysis 透传 token 用量（成本可观测）", () => {
  const usage = { promptTokens: 2686, completionTokens: 612, totalTokens: 3298, cachedTokens: 2432 };

  it("结果携带 LLM 返回的 usage", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson, usage });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.usage).toEqual(usage);
  });

  it("缓存命中时回传首次的 usage，而不是 undefined", async () => {
    const cache = new PromptCache<CachedAnalysis>(60_000);
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson, usage });

    await runAnalysis(input, { chat, model: "deepseek-chat", cache });
    const second = await runAnalysis(input, { chat, model: "deepseek-chat", cache });

    expect(second.status).toBe("ok");
    if (second.status !== "ok") throw new Error("unreachable");
    expect(second.fromCache).toBe(true);
    expect(second.usage).toEqual(usage);
  });

  it("LLM 未返回 usage 时为 undefined（不伪造 0）", async () => {
    const chat: ChatFn = vi.fn().mockResolvedValue({ content: cleanJson });

    const out = await runAnalysis(input, { chat, model: "deepseek-chat" });

    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.usage).toBeUndefined();
  });
});

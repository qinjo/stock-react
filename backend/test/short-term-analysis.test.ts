import { describe, expect, it, vi } from "vitest";
import { runAnalysis } from "../src/analysis/index.js";
import { buildShortTermPrompt, SHORT_TERM_SYSTEM_PROMPT } from "../src/analysis/prompt.js";
import type { AnalysisInput } from "../src/analysis/types.js";
import type { ChatFn } from "../src/analysis/llm.js";

/**
 * 短线视角的深度分析（筛选器候选卡片上的「深度分析」）。
 *
 * 与通用投研视角共用同一条链路（取数 / LLM / 解析 / 缓存 / 错误契约），
 * 唯一但关键的差别是**不出目标价**——源书的逻辑是跟随趋势直到结构破坏。
 */

const input: AnalysisInput = {
  code: "600519",
  name: "贵州茅台",
  dataDate: "2026-09-30",
  quote: {
    price: 1235.58,
    changePercent: -0.67,
    open: 1244.6,
    high: 1245.87,
    low: 1230.88,
    prevClose: 1243.88,
    marketCap: 1.5e12,
    pe: 19,
    pb: 6.1,
    turnoverRate: 1.2,
  },
  indicators: { ma: { ma100: 1180 }, priceVsMa100: 4.7 },
  implied: null,
  tally: null,
  klines: [{ date: "2026-09-30", open: 1244, high: 1246, low: 1230, close: 1235.58, volume: 26366 }],
} as unknown as AnalysisInput;

const validReport = {
  rating: "overweight",
  confidence: 62,
  reasoning: "站上 MA100 且形成低位 123，结构清晰",
  price_target: 1400, // 模型仍然编了一个——必须被抹掉
  price_target_basis: "前高",
  time_horizon: "2-5 个交易日",
  invalidation: { price: 1168.2, basis: "123 结构低点 3", distance_percent: -5.4 },
  sections: {
    snapshot: "①收盘 1235.58，在 MA100（1180）之上，偏离 +4.7%",
    fundamentals: "②低位 123：低点3 1140 高于低点1 1120，已突破高点2",
    technicals: "③止损取结构低点 3 = 1168.20，跌破即结构破坏",
    risks: ["④仓位建议半仓：大盘站上 MA100 但三个月趋势不成立"],
  },
  data_limits: [],
  what_would_change_my_mind: "跌破低点 3",
  monitoring: ["收盘与 MA100 的距离"],
};

const chatOf = (content: string) => vi.fn(async () => ({ content: JSON.stringify(content) })) as unknown as ChatFn;

describe("短线视角的提示词", () => {
  it("四项判据齐全，并明确禁止目标价与量能指标", () => {
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("MA100 位置");
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("结构形态");
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("离场条件");
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("仓位建议");
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("不要给出目标价");
    // 这套方法不研究成交量，提示词要挡住模型"补量能指标"的冲动
    expect(SHORT_TERM_SYSTEM_PROMPT).toContain("不研究成交量");
  });

  it("契约里目标价必须是 null，且分节沿用既有四段结构", () => {
    const { system, user } = buildShortTermPrompt(input);
    expect(system).toBe(SHORT_TERM_SYSTEM_PROMPT);
    expect(user).toContain('"price_target": null');
    for (const key of ["snapshot", "fundamentals", "technicals", "risks"]) {
      expect(user).toContain(key);
    }
    // 数据段与通用视角一致
    expect(user).toContain("600519");
    expect(user).toContain("数据截至日：2026-09-30");
  });
});

describe("短线视角的编排", () => {
  it("即使模型编了目标价，也会被抹成 null", async () => {
    const outcome = await runAnalysis(
      input,
      { chat: chatOf(validReport), model: "deepseek-chat" },
      { view: "short" },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.analysis.priceTarget).toBeNull();
    expect(outcome.analysis.priceTargetBasis).toBeNull();
    // 其余字段照常
    expect(outcome.analysis.rating).toBe("overweight");
    expect(outcome.analysis.invalidation?.price).toBeCloseTo(1168.2, 1);
  });

  it("通用视角不受影响（仍可给目标价）", async () => {
    const outcome = await runAnalysis(input, { chat: chatOf(validReport), model: "deepseek-chat" });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.analysis.priceTarget).toBe(1400);
  });

  it("两个视角的缓存互不串味（否则短线报告会被通用请求命中）", async () => {
    const { PromptCache } = await import("../src/cache.js");
    const cache = new PromptCache<never>(60_000);
    const chat = chatOf(validReport);

    await runAnalysis(input, { chat, model: "m", cache: cache as never }, { view: "short" });
    await runAnalysis(input, { chat, model: "m", cache: cache as never }, { view: "general" });

    expect(chat).toHaveBeenCalledTimes(2); // 第二次没有命中第一次的缓存
  });

  it("模型失败时仍然 abstain（与筛选器的降级是两回事）", async () => {
    const chat = vi.fn(async () => {
      throw new Error("LLM 调用失败：HTTP 500");
    }) as unknown as ChatFn;
    const outcome = await runAnalysis(input, { chat, model: "m", retries: 0 }, { view: "short" });
    expect(outcome.status).toBe("abstained");
  });
});

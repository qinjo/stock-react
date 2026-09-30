import { describe, expect, it, vi } from "vitest";
import { applyReview, buildReviewPrompt, parseReview, reviewCandidates } from "../src/screener/review.js";
import type { ScreenCandidate, ScreenResponse } from "../src/screener/response.js";
import type { ChatFn } from "../src/analysis/llm.js";

/**
 * 大模型档内复核。
 *
 * 职责被刻意收窄：只在同一档内排序 + 写理由。因此这里最要紧的两条断言是
 * **档序不被改变**与**越界候选被丢弃**——模型一旦能引入候选或跨档排序，
 * "结果可溯源"这件事就没了。
 */

function candidate(code: string, tier: number, over: Partial<ScreenCandidate> = {}): ScreenCandidate {
  return {
    code,
    name: `股票${code}`,
    price: 10,
    changePercent: 1,
    metrics: {
      lastClose: 10,
      changePercent: 1,
      ma100: 9,
      ma100Deviation: 0.11,
      barsSinceMa100Cross: 2,
      trendR2: 0.9,
      floatMarketCap: 4e9,
      turnoverAmount: 1e8,
    },
    ruleHits: [],
    deductions: [],
    signals: { signals: [], bestTier: tier },
    signalTier: tier,
    exit: {
      entry: 10,
      stop: 9.5,
      stopBasis: "ma-pairing",
      stopBasisLabel: "均线配对",
      stopSpace: 0.05,
      invalidation: "跌破 9.50 即离场",
      scaleOut: "冲高分批卖出",
      bookRef: "L1877",
    },
    resistance: [],
    reasoning: null,
    ...over,
  };
}

function responseOf(candidates: ScreenCandidate[]): ScreenResponse {
  return {
    status: "ok",
    dataDate: "2026-09-30",
    refreshedAt: "2026-09-30T04:00:00.000Z",
    params: {
      mode: "trend",
      strictness: "standard",
      boards: ["main"],
      ignoreMarketGate: false,
      refresh: false,
    },
    funnel: {
      universe: 10,
      afterExclusions: 10,
      afterHardFilters: 10,
      shortlisted: candidates.length,
      signalEligible: candidates.length,
    },
    candidateTotal: candidates.length,
    candidates,
    inactiveRules: [],
    degraded: { llmReview: true, reason: "尚未复核" },
    marketGate: null,
    suppressed: false,
    fromCache: false,
    increment: {
      ran: false,
      failed: false,
      error: null,
      snapshotDate: null,
      barsWritten: 0,
      barsRefreshed: 0,
      exDividends: 0,
      namesUpdated: 0,
      marketCapsUpdated: 0,
      skippedTotal: 0,
      durationMs: 0,
    },
  } as ScreenResponse;
}

const chatReturning = (content: string): ChatFn =>
  vi.fn(async () => ({ content, usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 } }));

describe("提示词契约", () => {
  it("明确要求只在同档内排序、禁止新增候选、不要给目标价", () => {
    const { system, user } = buildReviewPrompt([candidate("600519", 2)], "trend");
    expect(system).toContain("同一档内");
    expect(system).toContain("禁止新增候选");
    expect(system).toContain("不要给出目标价");
    // 喂给模型的是档序、信号、离场位与量化画像
    expect(user).toContain("600519");
    expect(user).toContain("止损空间");
  });
});

describe("输出解析", () => {
  const allowed = new Set(["600519", "000001"]);

  it("支持 JSON 围栏与裸 JSON", () => {
    const fenced = parseReview('```json\n{"reviewed":[{"code":"600519","reason":"结构清晰"}]}\n```', allowed);
    expect(fenced?.order).toEqual(["600519"]);
    const bare = parseReview('{"reviewed":[{"code":"000001","reason":"回调到位"}]}', allowed);
    expect(bare?.order).toEqual(["000001"]);
  });

  it("丢弃名单之外的代码", () => {
    const parsed = parseReview('{"reviewed":[{"code":"999999","reason":"编的"},{"code":"600519","reason":"ok"}]}', allowed);
    expect(parsed?.order).toEqual(["600519"]);
    expect(parsed?.reasons.has("999999")).toBe(false);
  });

  it("全部越界时视为失败", () => {
    expect(parseReview('{"reviewed":[{"code":"999999","reason":"编的"}]}', allowed)).toBeNull();
  });

  it("无法解析时返回 null（而不是抛错）", () => {
    expect(parseReview("模型今天不想说话", allowed)).toBeNull();
    expect(parseReview("", allowed)).toBeNull();
  });
});

describe("四种模型夹具", () => {
  const candidates = [candidate("600519", 2), candidate("000001", 2), candidate("300750", 3)];

  it("正常：贴理由并在同档内按模型次序重排", async () => {
    const chat = chatReturning('{"reviewed":[{"code":"000001","reason":"回调更浅"},{"code":"600519","reason":"量能一般"}]}');
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });

    expect(review.degraded).toBe(false);
    expect(review.reason).toBeNull();
    expect(review.usage?.totalTokens).toBe(120);
    expect(chat).toHaveBeenCalledTimes(1); // 每次筛选最多一次调用

    const applied = applyReview(responseOf(candidates), review);
    // 同档（档 2）内按模型次序：000001 在前
    expect(applied.candidates.map((c) => c.code)).toEqual(["000001", "600519", "300750"]);
    expect(applied.candidates[0]?.reasoning).toBe("回调更浅");
    expect(applied.degraded.llmReview).toBe(false);
  });

  it("越界候选：被丢弃，其余照常应用；不因此整次降级", async () => {
    const chat = chatReturning('{"reviewed":[{"code":"999999","reason":"编的"},{"code":"300750","reason":"事件驱动"}]}');
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });

    expect(review.degraded).toBe(false);
    const applied = applyReview(responseOf(candidates), review);
    expect(applied.candidates.map((c) => c.code)).not.toContain("999999");
    expect(applied.candidates).toHaveLength(3);
    expect(applied.candidates.find((c) => c.code === "300750")?.reasoning).toBe("事件驱动");
  });

  it("解析失败：整体降级，规则排序原样保留", async () => {
    const chat = chatReturning("我觉得今天都不错，但我说不清为什么");
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });

    expect(review.degraded).toBe(true);
    expect(review.reason).toContain("无法解析");
    const applied = applyReview(responseOf(candidates), review);
    expect(applied.candidates.map((c) => c.code)).toEqual(["600519", "000001", "300750"]);
    expect(applied.candidates.every((c) => c.reasoning === null)).toBe(true);
  });

  it("抛错：整体降级，并如实带上错误原因", async () => {
    const chat = vi.fn(async () => {
      throw new Error("LLM 调用失败：HTTP 429");
    }) as unknown as ChatFn;
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });

    expect(review.degraded).toBe(true);
    expect(review.reason).toContain("429");
    const applied = applyReview(responseOf(candidates), review);
    expect(applied.candidates.map((c) => c.code)).toEqual(["600519", "000001", "300750"]);
    expect(applied.degraded.llmReview).toBe(true);
  });

  it("未配置密钥：不调用模型，直接降级（而不是让筛选失败）", async () => {
    const review = await reviewCandidates(candidates, { chat: null, mode: "trend" });
    expect(review.degraded).toBe(true);
    expect(review.reason).toContain("未配置大模型密钥");
    expect(review.order).toBeNull();
  });

  it("没有候选时不调用模型", async () => {
    const chat = chatReturning('{"reviewed":[]}');
    const review = await reviewCandidates([], { chat, mode: "trend" });
    expect(chat).not.toHaveBeenCalled();
    expect(review.degraded).toBe(false);
  });
});

describe("档序由规则固定，模型不能跨档排序", () => {
  it("模型把档 3 的票排在前面也不生效", async () => {
    const candidates = [candidate("600519", 2), candidate("000001", 3)];
    const chat = chatReturning('{"reviewed":[{"code":"000001","reason":"想插队"},{"code":"600519","reason":"ok"}]}');
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });
    const applied = applyReview(responseOf(candidates), review);

    // 档 2 仍然排在档 3 前面
    expect(applied.candidates.map((c) => c.code)).toEqual(["600519", "000001"]);
    expect(applied.candidates.every((c) => c.reasoning !== null)).toBe(true);
  });

  it("未被模型提到的候选保持原有相对顺序，且排在提到过的之后", async () => {
    const candidates = [candidate("A1", 2), candidate("A2", 2), candidate("A3", 2)];
    const chat = chatReturning('{"reviewed":[{"code":"A3","reason":"最好"}]}');
    const review = await reviewCandidates(candidates, { chat, mode: "trend" });
    const applied = applyReview(responseOf(candidates), review);

    expect(applied.candidates.map((c) => c.code)).toEqual(["A3", "A1", "A2"]);
  });
});

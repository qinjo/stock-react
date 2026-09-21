import { buildAnalysisPrompt } from "./prompt.js";
import { parseAnalysis } from "./parse.js";
import { PromptCache } from "../cache.js";
import type { ChatFn } from "./llm.js";
import type { Analysis, AnalysisInput, AnalysisOutcome } from "./types.js";

/** 缓存中保存的分析快照（含首次分析时间，命中时如实回传）。 */
export type CachedAnalysis = {
  analysis: Analysis;
  model: string;
  analyzedAt: string;
};

export type RunAnalysisDeps = {
  /** 对话函数（测试注入 fake LLM；生产用 createDeepSeekChat） */
  chat: ChatFn;
  /** 记录到结果中的模型名 */
  model: string;
  now?: () => Date;
  /** 失败重试次数（默认 1 次重试，即最多 2 次调用） */
  retries?: number;
  /** 提示词哈希缓存；缺省则不缓存 */
  cache?: PromptCache<CachedAnalysis>;
};

/**
 * 编排一次分析：构造提示词 → 查缓存 → 调用 LLM → 解析。
 *
 * 失败契约（调研笔记核心教训）：调用或解析失败 → 重试一次 → 仍失败则 **abstain**，
 * 绝不静默降级为「中性」结论（看空 ≠ 无法判断会污染信号语义）。
 * abstain 结果不写入缓存，避免偶发失败在 TTL 内被持续复用。
 */
export async function runAnalysis(
  input: AnalysisInput,
  deps: RunAnalysisDeps,
): Promise<AnalysisOutcome> {
  const prompt = buildAnalysisPrompt(input);
  const cacheKey = PromptCache.keyFor(prompt.system, prompt.user);

  const cached = deps.cache?.get(cacheKey);
  if (cached) {
    return {
      status: "ok",
      analysis: cached.analysis,
      model: cached.model,
      analyzedAt: cached.analyzedAt,
      fromCache: true,
    };
  }

  const maxAttempts = (deps.retries ?? 1) + 1;
  let lastDetail = "未知错误";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await deps.chat(prompt);
      const analysis = parseAnalysis(text);
      const analyzedAt = (deps.now?.() ?? new Date()).toISOString();
      deps.cache?.set(cacheKey, { analysis, model: deps.model, analyzedAt });
      return { status: "ok", analysis, model: deps.model, analyzedAt, fromCache: false };
    } catch (err) {
      lastDetail = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    status: "abstained",
    reason: "ANALYSIS_FAILED",
    detail: `分析失败（已尝试 ${maxAttempts} 次）：${lastDetail}`,
  };
}

import { buildAnalysisPrompt } from "./prompt.js";
import { parseAnalysis } from "./parse.js";
import type { ChatFn } from "./llm.js";
import type { AnalysisInput, AnalysisOutcome } from "./types.js";

export type RunAnalysisDeps = {
  /** 对话函数（测试注入 fake LLM；生产用 createDeepSeekChat） */
  chat: ChatFn;
  /** 记录到结果中的模型名 */
  model: string;
  now?: () => Date;
  /** 失败重试次数（默认 1 次重试，即最多 2 次调用） */
  retries?: number;
};

/**
 * 编排一次分析：构造提示词 → 调用 LLM → 解析。
 *
 * 失败契约（调研笔记核心教训）：调用或解析失败 → 重试一次 → 仍失败则 **abstain**，
 * 绝不静默降级为「中性」结论（看空 ≠ 无法判断会污染信号语义）。
 */
export async function runAnalysis(
  input: AnalysisInput,
  deps: RunAnalysisDeps,
): Promise<AnalysisOutcome> {
  const prompt = buildAnalysisPrompt(input);
  const maxAttempts = (deps.retries ?? 1) + 1;
  let lastDetail = "未知错误";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const text = await deps.chat(prompt);
      const analysis = parseAnalysis(text);
      return {
        status: "ok",
        analysis,
        model: deps.model,
        analyzedAt: (deps.now?.() ?? new Date()).toISOString(),
        fromCache: false,
      };
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

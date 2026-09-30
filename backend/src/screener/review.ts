import type { ChatFn } from "../analysis/llm.js";
import type { TokenUsage } from "../analysis/types.js";
import type { ScreenCandidate, ScreenResponse } from "./response.js";
import type { ScreenerMode } from "./types.js";

/**
 * 大模型档内复核（Q3 混合架构的最后一环）。
 *
 * 职责被刻意收窄到两件事：**在同一信号档内调整先后** + **为每只候选写一句理由**。
 * 它不得引入新候选、不得改变档序、不得触碰止损位与仓位——那些全部来自确定性计算。
 * 因此模型挂掉时丢的只是"复核"，而不是数据。
 *
 * 这与单票分析里的取舍**刻意不同**：那里模型是主体，失败必须 abstain（见 ADR 说明）。
 */

export type ReviewOutcome = {
  /** code → 一句话理由 */
  reasons: Map<string, string>;
  /** 档内顺序（模型给出、已过滤越界项）；降级时为 null */
  order: string[] | null;
  /** true 表示本次未经模型复核（未配置密钥 / 调用失败 / 输出不合法） */
  degraded: boolean;
  reason: string | null;
  usage: TokenUsage | null;
};

const MAX_REASON_LENGTH = 60;

export const REVIEW_SYSTEM_PROMPT = [
  "你是 A 股短线操盘的复核助手。",
  "候选名单已经由确定性规则排好序，**信号档序由规则固定，你不能改变它**。",
  "你只能做两件事：①在**同一档内**调整先后；②为每只候选写一句不超过 40 字的理由。",
  "硬规则：",
  "- 理由必须来自给出的信号与量化数据，不得引入任何外部信息或预测涨幅；",
  "- **禁止新增候选**：名单之外的代码一律无效；",
  "- 不要给出目标价（这套方法跟随趋势直到结构被破坏，不做价位预测）；",
  '- 只输出 JSON，形如 {"reviewed":[{"code":"600519","reason":"…"}]}。',
].join("\n");

function fy(value: number | null | undefined, digits = 2): string {
  return value === null || value === undefined ? "—" : value.toFixed(digits);
}

/** 只把模型判得动的东西喂给它：档序、信号、离场位、量化画像。 */
export function buildReviewPrompt(
  candidates: readonly ScreenCandidate[],
  mode: ScreenerMode,
): { system: string; user: string } {
  const payload = {
    模式: mode === "trend" ? "均线跟随" : "事件驱动",
    候选: candidates.map((candidate) => ({
      code: candidate.code,
      name: candidate.name,
      档: candidate.signalTier,
      信号: candidate.signals.signals[0]?.label ?? null,
      入场: candidate.exit.entry,
      止损: candidate.exit.stop,
      止损空间: `${(candidate.exit.stopSpace * 100).toFixed(1)}%`,
      MA100偏离: candidate.metrics.ma100Deviation === null ? null : `${(candidate.metrics.ma100Deviation * 100).toFixed(1)}%`,
      成交额: candidate.metrics.turnoverAmount === null ? null : `${(candidate.metrics.turnoverAmount / 1e8).toFixed(2)}亿`,
      规则命中数: candidate.ruleHits.length,
      未判定数: candidate.ruleHits.filter((hit) => hit.unknown).length,
    })),
  };
  return { system: REVIEW_SYSTEM_PROMPT, user: JSON.stringify(payload) };
}

/** 三级回退取 JSON：```json 围栏 → 整串 → 首个平衡花括号块。 */
function extractJson(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed];
  for (const text of candidates) {
    if (!text) continue;
    try {
      return JSON.parse(text);
    } catch {
      // 继续回退
    }
  }
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 解析模型输出，并**过滤掉名单之外的代码**。
 *
 * 越界项被丢弃而不是让整次复核失败：模型偶尔多写一个代码，不该让用户白等一次调用。
 * 但如果过滤后一个有效项都没有，就视为复核失败（降级）。
 */
export function parseReview(
  raw: string,
  allowed: ReadonlySet<string>,
): { reasons: Map<string, string>; order: string[] } | null {
  const parsed = extractJson(raw) as { reviewed?: unknown } | null;
  const list = parsed?.reviewed;
  if (!Array.isArray(list)) return null;

  const reasons = new Map<string, string>();
  const order: string[] = [];
  for (const item of list) {
    const entry = item as { code?: unknown; reason?: unknown };
    const code = typeof entry.code === "string" ? entry.code.trim() : "";
    if (!code || !allowed.has(code) || reasons.has(code)) continue;
    const reason = typeof entry.reason === "string" ? entry.reason.trim().slice(0, MAX_REASON_LENGTH) : "";
    reasons.set(code, reason);
    order.push(code);
  }
  if (order.length === 0) return null;
  return { reasons, order };
}

export async function reviewCandidates(
  candidates: readonly ScreenCandidate[],
  options: { chat: ChatFn | null; mode: ScreenerMode },
): Promise<ReviewOutcome> {
  const unavailable = (reason: string): ReviewOutcome => ({
    reasons: new Map(),
    order: null,
    degraded: true,
    reason,
    usage: null,
  });

  if (!options.chat) return unavailable("未配置大模型密钥，本次结果全部来自确定性规则");
  if (candidates.length === 0) {
    return { reasons: new Map(), order: [], degraded: false, reason: null, usage: null };
  }

  const allowed = new Set(candidates.map((candidate) => candidate.code));
  try {
    const result = await options.chat(buildReviewPrompt(candidates, options.mode));
    const parsed = parseReview(result.content, allowed);
    if (!parsed) {
      return unavailable("大模型输出无法解析，已回退为规则排序");
    }
    return {
      reasons: parsed.reasons,
      order: parsed.order,
      degraded: false,
      reason: null,
      usage: result.usage ?? null,
    };
  } catch (err) {
    // 模型挂掉不该让整个功能变砖：规则结果本来就已经算完了
    return unavailable(
      `大模型复核失败，已回退为规则排序：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * 把复核结果套回响应：贴理由 + **只在同一档内**重排。
 *
 * 档序由规则固定，模型给不出跨档的顺序——这正是"不得改变档序"的落点。
 */
export function applyReview(response: ScreenResponse, review: ReviewOutcome): ScreenResponse {
  const reasons = review.reasons;
  const orderIndex = new Map<string, number>();
  (review.order ?? []).forEach((code, index) => orderIndex.set(code, index));

  // 稳定排序：档号优先（规则固定），同档内按模型给的次序，未提到的排在后面并保持原相对顺序
  const withIndex = response.candidates.map((candidate, index) => ({ candidate, index }));
  withIndex.sort((a, b) => {
    const tierA = a.candidate.signalTier ?? Number.MAX_SAFE_INTEGER;
    const tierB = b.candidate.signalTier ?? Number.MAX_SAFE_INTEGER;
    if (tierA !== tierB) return tierA - tierB;
    const orderA = orderIndex.get(a.candidate.code) ?? Number.MAX_SAFE_INTEGER;
    const orderB = orderIndex.get(b.candidate.code) ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    return a.index - b.index;
  });

  const candidates = withIndex.map(({ candidate }) => ({
    ...candidate,
    reasoning: reasons.get(candidate.code) ?? candidate.reasoning,
  }));

  return {
    ...response,
    candidates,
    // 漏斗的最后一档：复核过了几只。降级时为 0，而 signalEligible 不动
    funnel: { ...response.funnel, reviewed: candidates.filter((c) => c.reasoning !== null).length },
    degraded: { llmReview: review.degraded, reason: review.reason },
  };
}

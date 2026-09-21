import type { Analysis, AnalysisSections, Rating } from "./types.js";
import { RATINGS } from "./types.js";

/**
 * LLM 输出解析器（纯函数）。
 *
 * 两个实测坑（调研笔记第 4.2 节）：
 * - 模型常输出带杂散文本/markdown 包裹的 JSON → 三级回退提取；
 * - 可选数值字段会被填 `"None"`/`"N/A"`/`"-"` 等字符串 → 强制转 null。
 *
 * 校验策略：核心字段（rating/confidence）严格，外围字段（sections/reasoning）宽容填充 ——
 * 避免因某个描述性字段缺失就丢弃整份可用分析。
 */

/** LLM 输出被判定为不可用。 */
export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

const NULLISH = new Set(["", "none", "n/a", "na", "-", "--", "null", "undefined", "无数据", "无"]);

function isNullish(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return NULLISH.has(v.trim().toLowerCase());
  return false;
}

/** 可空数值：空值字符串→null，非有限数→null。 */
function nullableNumber(v: unknown): number | null {
  if (isNullish(v)) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 可空文本：空值字符串→null。 */
function nullableString(v: unknown): string | null {
  if (isNullish(v)) return null;
  return typeof v === "string" ? v.trim() : String(v);
}

function asText(v: unknown, fallback = ""): string {
  return nullableString(v) ?? fallback;
}

/** 风险清单：接受数组或单个字符串（模型两种写法都常见）。 */
function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) {
    return v.map((item) => nullableString(item)).filter((s): s is string => s !== null);
  }
  const single = nullableString(v);
  return single === null ? [] : [single];
}

/**
 * 三级回退提取 JSON：
 * ① markdown 代码块（```json … ``` 或 ``` … ```）
 * ② 整串即为 JSON
 * ③ 第一个平衡的 `{…}` 块（跳过字符串内的花括号）
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new ParseError("模型返回空内容");

  // ① 代码块
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return parseJson(fenced[1].trim());

  // ② 整串
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续回退 */
  }

  // ③ 第一个平衡的 {} 块
  const start = trimmed.indexOf("{");
  if (start >= 0) {
    const end = findBalancedEnd(trimmed, start);
    if (end > start) return parseJson(trimmed.slice(start, end + 1));
  }

  throw new ParseError("无法从模型输出中提取 JSON");
}

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new ParseError(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 从 start 处的 `{` 起找到匹配的 `}`，正确跳过字符串与转义。 */
function findBalancedEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function normalizeSections(raw: unknown): AnalysisSections {
  const s = (raw ?? {}) as Record<string, unknown>;
  return {
    snapshot: asText(s.snapshot),
    fundamentals: asText(s.fundamentals),
    technicals: asText(s.technicals),
    risks: asStringArray(s.risks),
    conclusion: asText(s.conclusion),
  };
}

/**
 * 解析并校验 LLM 输出为 `Analysis`。
 * @throws ParseError 当核心字段（rating/confidence）不合法时
 */
export function parseAnalysis(text: string): Analysis {
  const raw = extractJson(text);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ParseError("模型输出不是 JSON 对象");
  }
  const obj = raw as Record<string, unknown>;

  const rating = typeof obj.rating === "string" ? obj.rating.trim().toLowerCase() : "";
  if (!RATINGS.includes(rating as Rating)) {
    throw new ParseError(`评级不在 5 档枚举内：${JSON.stringify(obj.rating)}`);
  }

  const confidenceRaw = nullableNumber(obj.confidence);
  if (confidenceRaw === null) {
    throw new ParseError(`置信度不是有效数字：${JSON.stringify(obj.confidence)}`);
  }
  // 轻微越界按边界收敛，而不是丢弃整份分析
  const confidence = Math.min(100, Math.max(0, Math.round(confidenceRaw)));

  return {
    rating: rating as Rating,
    confidence,
    reasoning: asText(obj.reasoning, "（模型未给出理由）"),
    priceTarget: nullableNumber(obj.price_target ?? obj.priceTarget),
    timeHorizon: nullableString(obj.time_horizon ?? obj.timeHorizon),
    sections: normalizeSections(obj.sections),
  };
}

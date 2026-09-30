#!/usr/bin/env tsx
/**
 * 用手动方式验证**大模型那条路径**（不属于测试套件）。
 *
 *   npx tsx --env-file-if-exists=.env scripts/verify-llm-paths.ts
 *
 * 为什么需要它：仓库的铁律是"测试永不触网"，所以所有测试都注入假模型，
 * 而假模型返回的永远是规整 JSON。**如果真实模型的输出被我们的解析器拒掉，
 * 生产上会静默降级，而没有任何测试能发现**——降级路径本身是对的（结果照出，
 * 只标"未经 AI 复核"），所以这不会报错，只会让复核功能事实上从不生效。
 *
 * 这里把真实提示词发给真实模型，检查三件事：
 *   1. 复核提示词的输出能被 parseReview 接住，且不引入名单外的候选；
 *   2. 复核是否真的按"档内排序"改写顺序（而不是无视档序）；
 *   3. 短线视角提示词的输出能被 parseAnalysis 接住，且目标价确实为空。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeepSeekChat } from "../src/analysis/llm.js";
import { buildShortTermPrompt } from "../src/analysis/prompt.js";
import { parseAnalysis } from "../src/analysis/parse.js";
import { buildReviewPrompt, parseReview } from "../src/screener/review.js";
import { loadUniverseFromStore } from "../src/screener/load.js";
import { screenUniverse } from "../src/screener/engine.js";
import { toScreenResponse } from "../src/screener/response.js";
import { evaluateMarketGate } from "../src/screener/market-gate.js";
import { openMarketStore } from "../src/market/open.js";
import type { AnalysisInput } from "../src/analysis/types.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const apiKey = process.env.DEEPSEEK_API_KEY;
if (!apiKey) {
  console.error("✗ 未配置 DEEPSEEK_API_KEY，无法验证（用 --env-file-if-exists=.env 运行）");
  process.exit(1);
}
const chat = createDeepSeekChat({ apiKey, model: process.env.DEEPSEEK_MODEL || "deepseek-chat" });

let failed = 0;
const check = (ok: boolean, name: string, detail = ""): void => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${detail ? ` —— ${detail}` : ""}`);
  if (!ok) failed++;
};

// ── 1) 复核路径：用真实库里的真实候选 ──
console.log("\n[1/2] 复核提示词 → 真实模型 → parseReview\n");

const store = openMarketStore(join(BACKEND_ROOT, "data", "kline.sqlite"));
const gate = evaluateMarketGate({
  shanghai: { code: "sh000001", closes: store.readIndexBars("sh000001", 200).map((b) => b.close) },
  growth: { code: "sz399006", closes: store.readIndexBars("sz399006", 200).map((b) => b.close) },
});
const outcome = screenUniverse(
  loadUniverseFromStore(store),
  { mode: "trend", strictness: "standard", includeBeijing: false, ignoreMarketGate: true },
  { marketGate: gate },
);
const response = toScreenResponse(outcome, {
  dataDateKey: store.latestTradeDate() as number,
  refreshedAt: new Date(),
  params: { mode: "trend", strictness: "standard", boards: ["main", "growth", "star"], ignoreMarketGate: true, refresh: false },
  limit: 8,
});
store.close();

const candidates = response.candidates;
console.log(`  取自真实库：${candidates.length} 只候选（${candidates.map((c) => c.code).join(" ")}）`);
check(candidates.length > 0, "有候选可送审");
if (candidates.length === 0) process.exit(1);

const allowed = new Set(candidates.map((c) => c.code));
const prompt = buildReviewPrompt(candidates, "trend");
console.log(`  提示词：system ${prompt.system.length} 字 / user ${prompt.user.length} 字`);

const reviewStart = Date.now();
const reviewResult = await chat(prompt);
console.log(`  模型返回 ${reviewResult.content.length} 字，耗时 ${((Date.now() - reviewStart) / 1000).toFixed(1)}s`);
console.log(`  ── 原始输出（截断 400 字）──\n${reviewResult.content.slice(0, 400)}\n`);

const parsed = parseReview(reviewResult.content, allowed);
check(parsed !== null, "parseReview 接得住真实输出");
if (parsed) {
  check(parsed.order.length > 0, `解析出 ${parsed.order.length} 条复核`);
  const outOfList = parsed.order.filter((code) => !allowed.has(code));
  check(outOfList.length === 0, "没有引入名单外的候选", outOfList.join(",") || "无");
  const withReason = parsed.order.filter((code) => (parsed.reasons.get(code) ?? "") !== "");
  check(withReason.length === parsed.order.length, `${withReason.length}/${parsed.order.length} 条带理由`);
  console.log(`  模型给的档内顺序：${parsed.order.join(" → ")}`);
  console.log(`  规则给的顺序：    ${candidates.map((c) => c.code).join(" → ")}`);
}

// ── 2) 短线视角路径：用一个最小输入，只验解析与"无目标价" ──
console.log("\n[2/2] 短线视角提示词 → 真实模型 → parseAnalysis\n");

const bars = Array.from({ length: 60 }, (_, i) => {
  const close = 10 + i * 0.08;
  return { date: `2026-07-${String((i % 28) + 1).padStart(2, "0")}`, open: close, high: close * 1.01, low: close * 0.99, close, volume: 10000 };
});
const input = {
  code: "600519",
  name: "验证用标的",
  dataDate: "2026-09-30",
  quote: { price: bars.at(-1)!.close, changePercent: 0.8, open: 14.6, high: 14.8, low: 14.5, prevClose: 14.5, marketCap: null, pe: null, pb: null, turnoverRate: null },
  indicators: { ma: { ma100: 12.0 }, priceVsMa100: 22.5 },
  implied: null,
  tally: null,
  klines: bars,
} as unknown as AnalysisInput;

const shortResult = await chat(buildShortTermPrompt(input));
console.log(`  模型返回 ${shortResult.content.length} 字`);
console.log(`  ── 原始输出（截断 500 字）──\n${shortResult.content.slice(0, 500)}\n`);
try {
  const analysis = parseAnalysis(shortResult.content);
  check(true, "parseAnalysis 接得住真实输出");
  check(analysis.priceTarget === null, "目标价为空", String(analysis.priceTarget));
  check(analysis.sections.snapshot.length > 0, "①MA100 位置有内容");
  check(analysis.sections.fundamentals.length > 0, "②结构形态有内容");
  check(analysis.sections.technicals.length > 0, "③离场条件有内容");
  check(analysis.sections.risks.length > 0, "④仓位建议有内容");
} catch (err) {
  check(false, "parseAnalysis 接得住真实输出", err instanceof Error ? err.message : String(err));
}

console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
if (failed > 0) process.exitCode = 1;

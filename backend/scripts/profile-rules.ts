#!/usr/bin/env tsx
/**
 * 规则归因画像：在全市场真实数据上统计**每条规则究竟拦下了多少只**。
 *
 *   npm run profile:rules                 # 标准档（趋势模式）
 *   npm run profile:rules -- --mode event --strictness strict
 *
 * 为什么需要它：漏斗只告诉你"从 5555 到 337"，不告诉你**是谁拦的**。
 * 一个从不触发的规则可能是死重量（或阈值写错了），一个拦下 57% 的规则值得复核是否过激。
 * 单测能证明"规则按声明的条件判断"，证明不了"它在真实数据上到底起作用没有"。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMarketStore } from "../src/market/open.js";
import { loadUniverseFromStore } from "../src/screener/load.js";
import { RULES, buildContext, evaluateRules } from "../src/screener/rules.js";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { evaluateMarketGate } from "../src/screener/market-gate.js";
import type { ScreenerMode, Strictness } from "../src/screener/types.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let mode: ScreenerMode = "trend";
let strictness: Strictness = "standard";
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--mode") mode = argv[++i] as ScreenerMode;
  else if (argv[i] === "--strictness") strictness = argv[++i] as Strictness;
}

const store = openMarketStore(process.env.MARKET_DB_PATH || join(BACKEND_ROOT, "data", "kline.sqlite"));
const params = paramsFor(strictness);
const criteria = { ...DEFAULT_CRITERIA, mode, strictness };

// 大盘门要传：不传的话 U-growthIndexGate 会一律走"数据缺失"分支，
// 画像里就会假出一个"从不触发"的规则（第一版探针就是这么误报的）
const gate = evaluateMarketGate({
  shanghai: { code: "sh000001", closes: store.readIndexBars("sh000001", 200).map((b) => b.close) },
  growth: { code: "sz399006", closes: store.readIndexBars("sz399006", 200).map((b) => b.close) },
});

const rejectedBy = new Map<string, number>();
const unknownCount = new Map<string, number>();
let total = 0;
let passed = 0;

for (const security of loadUniverseFromStore(store, {
  codeFilter: (row) => criteria.mode === "event" || row.board !== "bj",
})) {
  total++;
  const ctx = buildContext(security, params, criteria, gate);
  const result = evaluateRules(ctx);
  // 到过这条规则的标的数（不管判定结果），用于区分"没触发"与"没走到"
  for (const hit of result.hits) {
    if (hit.outcome.unknown) unknownCount.set(hit.id, (unknownCount.get(hit.id) ?? 0) + 1);
  }
  if (result.passed) {
    passed++;
    continue;
  }
  const id = result.rejectedBy?.id ?? "(未归类)";
  rejectedBy.set(id, (rejectedBy.get(id) ?? 0) + 1);
}
store.close();

console.log(`模式 ${mode} · 严格度 ${strictness} · 大盘门 ${gate.state}`);
console.log(`全市场 ${total} 只 → 通过基础池 ${passed} 只（${((passed / total) * 100).toFixed(1)}%）\n`);
console.log("各规则真实拦下的数量（升序）：");
for (const [id, n] of [...rejectedBy.entries()].sort((a, b) => a[1] - b[1])) {
  const label = RULES.find((r) => r.id === id)?.label ?? "?";
  const bar = "█".repeat(Math.max(1, Math.round((n / total) * 40)));
  console.log(`  ${id.padEnd(24)} ${String(n).padStart(5)}  ${((n / total) * 100).toFixed(1).padStart(5)}%  ${bar}  ${label}`);
}

const applicable = RULES.filter((r) => !r.modes || r.modes.includes(mode));
const never = applicable.filter((r) => !rejectedBy.has(r.id));
console.log(`\n适用但从未拦下任何一只（${never.length} 条）：`);
for (const rule of never) console.log(`  · ${rule.id.padEnd(24)} ${rule.label}`);

console.log("\n出现「未判定」的规则及次数：");
const unknowns = [...unknownCount.entries()].sort((a, b) => b[1] - a[1]);
if (unknowns.length === 0) console.log("  无");
for (const [id, n] of unknowns) console.log(`  ${id.padEnd(24)} ${n} 次`);

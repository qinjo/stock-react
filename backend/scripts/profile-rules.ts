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
/**
 * 每条规则**走到了多少只**。
 *
 * 这一步是必需的：规则是分层短路的，后段规则只面对通过了前置规则的少数标的。
 * 只看"拦下多少只"会把"分母小"误读成"阈值松"——`U-notRange` 只拦 4 只，
 * 但若只有 6 只走到了它，那是 67% 而不是 0.07%。
 */
const reachedCount = new Map<string, number>();
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
    reachedCount.set(hit.id, (reachedCount.get(hit.id) ?? 0) + 1);
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
// 按"走到了多少只"排序——这才是判断阈值松紧的口径
const rows = [...reachedCount.entries()]
  .map(([id, reached]) => ({ id, reached, rejected: rejectedBy.get(id) ?? 0 }))
  .sort((a, b) => a.rejected / Math.max(1, a.reached) - b.rejected / Math.max(1, b.reached));

console.log("各规则：走到了多少只 → 拦下多少只（按拒绝率升序）\n");
console.log(`  ${"规则".padEnd(24)} ${"走到".padStart(6)} ${"拦下".padStart(6)} ${"拒绝率".padStart(8)}`);
for (const r of rows) {
  const label = RULES.find((x) => x.id === r.id)?.label ?? "?";
  const rate = r.rejected / Math.max(1, r.reached);
  const bar = r.rejected === 0 ? "" : "█".repeat(Math.max(1, Math.round(rate * 20)));
  console.log(
    `  ${r.id.padEnd(24)} ${String(r.reached).padStart(6)} ${String(r.rejected).padStart(6)} ` +
      `${(rate * 100).toFixed(1).padStart(7)}%  ${bar} ${label}`,
  );
}

const applicable = RULES.filter((r) => !r.modes || r.modes.includes(mode));
const never = applicable.filter((r) => (rejectedBy.get(r.id) ?? 0) === 0);
console.log(`\n适用但从未拦下任何一只（${never.length} 条）：`);
for (const rule of never) console.log(`  · ${rule.id.padEnd(24)} ${rule.label}`);

console.log("\n出现「未判定」的规则及次数：");
const unknowns = [...unknownCount.entries()].sort((a, b) => b[1] - a[1]);
if (unknowns.length === 0) console.log("  无");
for (const [id, n] of unknowns) console.log(`  ${id.padEnd(24)} ${n} 次`);

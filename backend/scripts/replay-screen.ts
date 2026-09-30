#!/usr/bin/env tsx
/**
 * 历史交易日回放（#26 的人工验收载体）。
 *
 *   npm run replay:screen -- --date 2026-09-29 --top 3 --out /tmp/replay.md
 *
 * 为什么需要它：单测只能证明"实现符合我们声明的规则"，**证明不了"我们声明的规则忠实于那本书"**。
 * 后者只能人工核对——所以这个脚本的任务是把"核对所需的全部证据"一次性摆出来：
 * 每个候选命中了哪条规则、阈值与实际值各是多少、止损位怎么来的、排除了什么。
 *
 * 回放会把每只标的的日线**截断到指定交易日**，绝不让未来数据漏进来。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { openMarketStore } from "../src/market/open.js";
import { loadUniverseFromStore } from "../src/screener/load.js";
import { screenUniverse } from "../src/screener/engine.js";
import { toScreenResponse, rankShortlist } from "../src/screener/response.js";
import { evaluateMarketGate } from "../src/screener/market-gate.js";
import { paramsFor } from "../src/screener/params.js";
import { fromDateKey, toDateKey } from "../src/market/qlib.js";
import type { ScreenerMode, Strictness } from "../src/screener/types.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const MODES: ScreenerMode[] = ["trend", "event"];
const TIERS: Strictness[] = ["loose", "standard", "strict"];
const STAGE_LABEL = { exclusions: "排除层", hardFilters: "硬门槛", shortlist: "基础池" } as const;
const SOURCE_LABEL = { book: "书", inferred: "推断", offbook: "书外" } as const;

type Options = { db: string; date: number | null; top: number; out: string | null };

function parseArgs(argv: string[]): Options {
  const opts: Options = { db: join(BACKEND_ROOT, "data", "kline.sqlite"), date: null, top: 3, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = argv[++i] as string;
    else if (arg === "--date") opts.date = toDateKey(argv[++i] as string);
    else if (arg === "--top") opts.top = Number(argv[++i]);
    else if (arg === "--out") opts.out = argv[++i] as string;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：npm run replay:screen -- [--db <path>] [--date YYYY-MM-DD] [--top N] [--out <file.md>]");
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

function main(): void {
  const opts = parseArgs(process.argv.slice(2));
  const store = openMarketStore(opts.db);
  const lines: string[] = [];

  try {
    const latest = store.latestTradeDate();
    if (latest === null) throw new Error("库内没有日线：先跑 npm run bootstrap:kline");

    // 默认取最近 5 个交易日里倒数第二个（最后一个的估值/数据可能仍在更新中）
    const recent = store.recentTradingDates(latest, 5);
    const asOf = opts.date ?? (recent.length >= 2 ? (recent[recent.length - 2] as number) : latest);
    const dataDate = store.latestTradeDateUpTo(asOf) as number;

    // 大盘门同样截断到回放日
    const gate = evaluateMarketGate({
      shanghai: { code: "sh000001", closes: store.readIndexBarsUpTo("sh000001", asOf, 200).map((b) => b.close) },
      growth: { code: "sz399006", closes: store.readIndexBarsUpTo("sz399006", asOf, 200).map((b) => b.close) },
    });

    const say = (text = "") => {
      lines.push(text);
      console.log(text);
    };

    say(`# 历史交易日回放 —— ${fromDateKey(dataDate)}`);
    say();
    say(`回放日：**${fromDateKey(dataDate)}**（日线截断于此，不含之后任何数据）`);
    say();
    say(`大盘门：**${gate.state}** · 建议总仓位 ${Math.round(gate.positionAdvice * 100)}%`);
    say();
    say(`> ${gate.reason}`);
    say();

    for (const mode of MODES) {
      for (const tier of TIERS) {
        const criteria = { mode, strictness: tier, includeBeijing: false, ignoreMarketGate: true };
        const outcome = screenUniverse(
          loadUniverseFromStore(store, { asOfDate: asOf }),
          criteria,
          { marketGate: gate },
        );
        const response = toScreenResponse(outcome, {
          dataDateKey: dataDate,
          refreshedAt: new Date(),
          params: { mode, strictness: tier, boards: ["main", "growth", "star"], ignoreMarketGate: true, refresh: false },
          limit: opts.top,
        });
        const f = outcome.funnel;

        say(`## ${mode === "trend" ? "均线跟随" : "事件驱动"} · ${tier}`);
        say();
        say(`漏斗：全市场 ${f.universe} → 排除池 ${f.afterExclusions} → 硬门槛 ${f.afterHardFilters} → 基础池 ${f.shortlisted} → 有信号 ${f.signalEligible}`);
        if (outcome.inactiveRules.length > 0) say(`未生效规则：${outcome.inactiveRules.join("、")}`);
        say();

        for (const candidate of response.candidates) {
          const exit = candidate.exit;
          say(`### ${candidate.code} ${candidate.name ?? ""}　档${candidate.signalTier} ${candidate.signals.signals[0]?.label ?? ""}`);
          say();
          say(`- 现价 ${candidate.price} · 涨跌幅 ${candidate.changePercent}% · 流通市值 ${candidate.metrics.floatMarketCap === null ? "—" : `${(candidate.metrics.floatMarketCap / 1e8).toFixed(1)}亿`}`);
          say(`- 信号：${candidate.signals.signals.map((s) => `${s.label}（书 ${s.bookRef}）`).join("；")}`);
          say(`- 入场 ${exit.entry} · **止损 ${exit.stop}**（${exit.stopBasisLabel}，空间 ${(exit.stopSpace * 100).toFixed(1)}%）`);
          say(`- 失效：${exit.invalidation}`);
          say(`- 参考压力位：${candidate.resistance.map((r) => r.price).join(" / ") || "—"}`);
          say();
          say("  逐条规则核对（规则名 / 阈值与实际值 / 来源）：");
          for (const hit of candidate.ruleHits) {
            const badge = hit.source === "book" ? `书 ${hit.bookRef ?? ""}` : SOURCE_LABEL[hit.source];
            say(`  - [${STAGE_LABEL[hit.stage]}] ${hit.label} — ${hit.detail} 〔${badge}〕${hit.unknown ? "（未判定）" : ""}`);
          }
          say();
        }
        if (response.candidates.length === 0) say("（无候选）\n");
      }
    }

    say("---");
    say();
    say("## 人工核对清单");
    say();
    say("逐条回答，把「否」的候选编号与理由记下来：");
    say();
    say("1. **命中规则是否真实成立**：随便挑 1–2 只候选，打开它的日 K 图，核对");
    say("   规则明细里报的阈值与实际值（尤其是 MA100 位置、123 结构的三个点、缺口宽度）。");
    say("2. **止损位是否有依据**：止损是否落在结构低点 / 均线 / 固定比例三者之一，");
    say("   空间是否在本档上限之内（宽松 10% / 标准 8% / 严格 5%）。");
    say("3. **排除项是否被正确应用**：有没有明显该被剔除的票（ST、停牌、高位涨停、连板）混了进来；");
    say("   反过来，有没有该出现却被挡掉的形态。");
    say("4. **档序是否符合直觉**：涨停+低位123 是否排在缺口之前；");
    say("   同档内止损空间小的是否排在前面。");
    say("5. **有没有「看起来就不像那本书挑的票」**——这一条最重要，也最容易被忽略。");
    say();
    say("> 单测只能证明「实现符合我们声明的规则」；证明「声明的规则忠实于那本书」只能靠上面这五条。");

    if (opts.out) {
      writeFileSync(opts.out, lines.join("\n"), "utf8");
      console.log(`\n已写入 ${opts.out}`);
    }
  } finally {
    store.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`\n✗ 回放失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

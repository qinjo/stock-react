#!/usr/bin/env tsx
/**
 * 在本地日K库上跑一次筛选，打印漏斗分档与候选样本。
 *
 *   npm run screen:preview
 *   npm run screen:preview -- --tier strict --sample 20
 *   npm run screen:preview -- --date-check
 *
 * 用途是把「规则层相对全市场到底有多严」变成可看见的数字：
 * 三档各剩多少只、哪条规则当前没生效、候选长什么样。
 * 这是规则引擎唯一的验收方式——阈值翻译错了不会有任何报错，只会静默给出错误的名单。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarketStore } from "../src/market/store.js";
import { screenUniverse } from "../src/screener/engine.js";
import { rankShortlist } from "../src/screener/response.js";
import { loadUniverseFromStore } from "../src/screener/load.js";
import { DEFAULT_CRITERIA } from "../src/screener/params.js";
import type { ScreenOutcome, Strictness } from "../src/screener/types.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB = join(BACKEND_ROOT, "data", "kline.sqlite");
const TIERS: Strictness[] = ["loose", "standard", "strict"];

type Options = { db: string; tiers: Strictness[]; sample: number };

function parseArgs(argv: string[]): Options {
  const opts: Options = { db: DEFAULT_DB, tiers: TIERS, sample: 10 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = argv[++i] as string;
    else if (arg === "--sample") opts.sample = Number(argv[++i]);
    else if (arg === "--tier") {
      const tier = argv[++i] as Strictness;
      if (!TIERS.includes(tier)) throw new Error(`未知严格度：${tier}`);
      opts.tiers = [tier];
    } else if (arg === "--help" || arg === "-h") {
      console.log("用法：npm run screen:preview -- [--db <path>] [--tier loose|standard|strict] [--sample N]");
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

const pct = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(1)}%`;
const yi = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v / 1e8).toFixed(1)}亿`;

function printOutcome(outcome: ScreenOutcome, sample: number): void {
  const { funnel } = outcome;
  const drop = (from: number, to: number) => (from === 0 ? "—" : `−${(((from - to) / from) * 100).toFixed(1)}%`);
  console.log(`\n严格度 ${outcome.criteria.strictness}`);
  console.log(
    `  全市场 ${funnel.universe} → 排除池 ${funnel.afterExclusions} (${drop(funnel.universe, funnel.afterExclusions)})` +
      ` → 硬门槛 ${funnel.afterHardFilters} (${drop(funnel.afterExclusions, funnel.afterHardFilters)})` +
      ` → 基础池 ${funnel.shortlisted} (${drop(funnel.afterHardFilters, funnel.shortlisted)})` +
      ` → 有信号 ${funnel.signalEligible} (${drop(funnel.shortlisted, funnel.signalEligible)})`,
  );
  if (outcome.inactiveRules.length > 0) {
    console.log(`  ⚠ 当前未生效的规则：${outcome.inactiveRules.join("、")}（多为缺数据，见规则层的 unknown 说明）`);
  }
  if (outcome.shortlisted.length === 0) return;

  // 用与接口一致的排序，否则预览看到的顺序和界面不一样，失去诊断价值
  const ranked = rankShortlist(outcome.shortlisted);

  const tierCounts = new Map<number, number>();
  for (const row of ranked) {
    const tier = row.signals.bestTier ?? 0;
    tierCounts.set(tier, (tierCounts.get(tier) ?? 0) + 1);
  }
  const tierLabel: Record<number, string> = {
    1: "底背离双突破",
    2: "低位123",
    3: "三档入场",
    4: "MA20 上穿",
    5: "阻力突破/支撑回踩",
  };
  console.log(
    `  信号档分布：${[...tierCounts.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([tier, n]) => `${tierLabel[tier] ?? "无信号"} ${n}`)
      .join(" / ")}`,
  );

  console.log(`  候选样本（按信号档序，再按止损空间升序）：`);
  for (const row of ranked.slice(0, sample)) {
    const strongest = row.signals.signals[0];
    console.log(
      `    ${row.code}  档${row.signals.bestTier} ${strongest?.label ?? "—"}` +
        `  止损 ${row.exit.stop.toFixed(2)}（${(row.exit.stopSpace * 100).toFixed(1)}%，${row.exit.stopBasis}）` +
        `  压力位 ${row.resistance[0]?.price.toFixed(2) ?? "—"}`,
    );
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const store = new MarketStore(opts.db);
  try {
    const latest = store.latestTradeDate();
    if (latest === null) throw new Error("库内没有日线：先跑 npm run bootstrap:kline");
    console.log(
      `库内 ${store.countInstruments()} 只标的（仍在交易 ${store.countInstruments(undefined, true)} 只）、` +
        `${store.countBars().toLocaleString("en-US")} 行，最新交易日 ${latest}`,
    );

    for (const tier of opts.tiers) {
      const started = Date.now();
      const outcome = screenUniverse(loadUniverseFromStore(store), {
        ...DEFAULT_CRITERIA,
        strictness: tier,
      });
      printOutcome(outcome, opts.sample);
      console.log(`  （耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`);
    }
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ 预览失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

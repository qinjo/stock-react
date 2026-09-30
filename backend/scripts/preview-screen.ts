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
      ` → 基础池 ${funnel.shortlisted} (${drop(funnel.afterHardFilters, funnel.shortlisted)})`,
  );
  if (outcome.inactiveRules.length > 0) {
    console.log(`  ⚠ 当前未生效的规则：${outcome.inactiveRules.join("、")}（多为缺数据，见规则层的 unknown 说明）`);
  }
  if (outcome.shortlisted.length === 0) return;

  console.log(`  候选样本（按上穿 MA100 时点升序，刚突破的排前面）：`);
  const sampleRows = [...outcome.shortlisted]
    .sort((a, b) => {
      const x = a.metrics.barsSinceMa100Cross ?? Number.MAX_SAFE_INTEGER;
      const y = b.metrics.barsSinceMa100Cross ?? Number.MAX_SAFE_INTEGER;
      return x - y;
    })
    .slice(0, sample);
  for (const row of sampleRows) {
    const since = row.metrics.barsSinceMa100Cross;
    console.log(
      `    ${row.code}  MA100 偏离 ${pct(row.metrics.ma100Deviation)}` +
        `  上穿距今 ${since === null ? "全程在上" : `${since} 根`}` +
        `  成交额 ${yi(row.metrics.turnoverAmount)}`,
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

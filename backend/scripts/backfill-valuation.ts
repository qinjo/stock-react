#!/usr/bin/env tsx
/**
 * 按交易日回填全市场估值与行业归属（`datacenter-web`）。
 *
 *   npm run backfill:valuation -- --from 2026-09-01
 *   npm run backfill:valuation -- --days 60
 *   npm run backfill:valuation -- --check-only
 *
 * 这条通道**按交易日一次请求取全市场**（实测 pageSize=6000 一次拿全），
 * 六年约一千余次请求，没有任何逐票扇出；且它与日K dump 完全独立，
 * 因此 `--check-only` 的交叉校验能发现某一方的解析问题。
 *
 * 断点续跑：已落地的交易日不再重复请求，中断后重跑即可。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMarketStore } from "../src/market/open.js";
import { crossCheckValuationClose, ingestValuation } from "../src/market/valuation.js";
import { fromDateKey, toDateKey } from "../src/market/qlib.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Options = { db: string; from: number; checkOnly: boolean };

function parseArgs(argv: string[]): Options {
  const opts: Options = { db: join(BACKEND_ROOT, "data", "kline.sqlite"), from: 0, checkOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = argv[++i] as string;
    else if (arg === "--from") opts.from = toDateKey(argv[++i] as string);
    else if (arg === "--days") {
      const days = Number(argv[++i]);
      opts.from = -days; // 负数表示"最近 N 个交易日"，下面按日历折算
    } else if (arg === "--check-only") opts.checkOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：npm run backfill:valuation -- [--db <path>] [--from YYYY-MM-DD | --days N] [--check-only]");
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const store = openMarketStore(opts.db);
  const started = Date.now();

  try {
    const latest = store.latestTradeDate();
    if (latest === null) throw new Error("库内没有日线：先跑 npm run bootstrap:kline");

    // --days N：取日历里的最后 N 个交易日
    const from = opts.from >= 0 ? opts.from || 19700101 : store.calendarDatesBetween(19700101, latest).slice(opts.from)[0] ?? 19700101;

    if (opts.checkOnly) {
      // 估值数据当晚才发布，最新交易日往往还没覆盖；自动退到"最近一个有估值的交易日"
      const target = store.latestValuationDate() ?? latest;
      if (target !== latest) {
        console.log(`（${fromDateKey(latest)} 的估值数据尚未发布，改校验 ${fromDateKey(target)}）`);
      }
      const result = crossCheckValuationClose(store, target);
      console.log(
        [
          `交叉校验 ${fromDateKey(target)}：`,
          `  两源都有    ${result.compared} 只`,
          `  收盘一致    ${result.matched} 只`,
          `  只有日K     ${result.missingInValuation} 只（估值表尚未覆盖该日）`,
          result.mismatches.length > 0 ? `  差异样例：` : "  ✓ 无不一致",
        ].join("\n"),
      );
      for (const item of result.mismatches) {
        console.log(`    ${item.code}  日K ${item.barClose}  vs  估值 ${item.valuationClose}`);
      }
      if (result.mismatches.length > 0) process.exitCode = 1;
      return;
    }

    console.log(`回填区间：${fromDateKey(from || 19700101)} → ${fromDateKey(latest)}`);
    const stats = await ingestValuation(store, { from: from || 19700101, to: latest });
    console.log(
      [
        "",
        "✓ 估值与行业回填完成",
        `  请求交易日  ${stats.daysRequested}`,
        `  有数据      ${stats.daysWithData}`,
        `  写入行数    ${stats.rowsWritten.toLocaleString("en-US")}`,
        `  失败        ${stats.failedDays}（断点续跑可补）`,
        `  耗时        ${((Date.now() - started) / 1000).toFixed(1)}s`,
      ].join("\n"),
    );
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ 估值回填失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

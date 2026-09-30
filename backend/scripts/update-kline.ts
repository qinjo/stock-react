#!/usr/bin/env tsx
/**
 * 每日增量：把当天那一根全市场日 K 补进本地库。
 *
 *   npm run update:kline
 *   npm run update:kline -- --db data/kline.sqlite
 *   npm run update:kline -- --index-only     # 只补指数日线与交易日历
 *
 * 全市场约十余个请求（腾讯批量快照，实测无限流），**没有任何逐票扇出**。
 * 首次运行会顺带补齐上证指数与创业板指的日线并建立交易日历——
 * 后者是除权检测的前提：只有知道"库内最新日是不是快照日的前一个交易日"，
 * 才能把「快照昨收 ≠ 库内收盘」正确地解读为除权，而不是当成普通涨跌。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { backfillIndexHistory, runIncrement } from "../src/market/increment.js";
import { openMarketStore } from "../src/market/open.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Options = { db: string; indexOnly: boolean };

function parseArgs(argv: string[]): Options {
  const opts: Options = { db: join(BACKEND_ROOT, "data", "kline.sqlite"), indexOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = argv[++i] as string;
    else if (arg === "--index-only") opts.indexOnly = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("用法：npm run update:kline -- [--db <path>] [--index-only]");
      process.exit(0);
    } else throw new Error(`未知参数：${arg}`);
  }
  return opts;
}

const wan = (v: number): string => `${(v / 1e4).toFixed(0)}万`;

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const store = openMarketStore(opts.db);
  const started = Date.now();

  try {
    const before = store.latestTradeDate();
    console.log(`增量前：库内最新交易日 ${before ?? "无"}，标的 ${store.countInstruments()} 只`);

    if (opts.indexOnly) {
      const result = await backfillIndexHistory(store);
      console.log(`✓ 指数日线 ${result.indexBars} 根，交易日历 ${result.calendarDates} 个交易日`);
      return;
    }

    const stats = await runIncrement(store);

    console.log(
      [
        "",
        "✓ 增量完成",
        `  快照交易日    ${stats.snapshotDate ?? "未识别"}`,
        `  请求 / 返回   ${stats.requests} 次 / ${stats.rowsReturned} 行（请求 ${stats.symbolsRequested} 个符号）`,
        `  追加日线      ${stats.barsWritten} 只`,
        `  同日刷新      ${stats.barsRefreshed} 只`,
        `  除权除息      ${stats.exDividends} 只（因子已就地放大，历史 bar 不动）`,
        `  指数日线      ${stats.indexBarsWritten} 根`,
        `  回填名称      ${stats.namesUpdated} 只`,
        `  回填流通市值  ${stats.marketCapsUpdated} 只`,
        `  跳过          ${Object.entries(stats.skipped)
          .filter(([, n]) => n > 0)
          .map(([reason, n]) => `${reason} ${n}`)
          .join(" / ") || "无"}`,
        `  库内最新日    ${store.latestTradeDate() ?? "无"}`,
        `  耗时          ${((Date.now() - started) / 1000).toFixed(1)}s`,
      ].join("\n"),
    );

    for (const note of stats.notes) console.log(`  ⚠ ${note}`);
    void wan;
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ 增量失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

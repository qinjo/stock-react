#!/usr/bin/env tsx
/**
 * KDJ 金叉/死叉策略回测（issue #31）。
 *
 *   npm run backtest:kdj
 *   npm run backtest:kdj -- --from 2021-01-01 --to 2026-09-30 --hot-top 100 \
 *     --out backend/reports/backtest-kdj.md --trades-out /tmp/trades.csv
 *
 * 用户策略：近一个月出现在热门列表、且有过涨停的股票 → KDJ 金叉买入、死叉清仓。
 * 仓库没有历史热门榜，V1 的宇宙是**可重建的代理**（成交额排名 Top-N），
 * 真实人气榜历史由 issue #32 的数据层补齐。
 *
 * 全流程只读本地库（`backend/data/kline.sqlite`），不发任何网络请求。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openMarketStore } from "../src/market/open.js";
import { fromDateKey, toDateKey } from "../src/market/qlib.js";
import type { Board } from "../src/market/qlib.js";
import { DEFAULT_BACKTEST_PARAMS } from "../src/backtest/params.js";
import { runBacktest } from "../src/backtest/service.js";
import { summarize } from "../src/backtest/metrics.js";
import {
  renderReport,
  stocksToCsv,
  tradesToCsv,
  type ReportContext,
} from "../src/backtest/report.js";
import type { BacktestParams } from "../src/backtest/types.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

type Options = {
  db: string;
  from: number;
  to: number | null;
  hotTop: number;
  window: number;
  kdjPeriod: number;
  kdjKSmooth: number;
  kdjDSmooth: number;
  minBars: number;
  capital: number;
  boards: Board[] | null;
  maxStocks: number | null;
  out: string;
  tradesOut: string | null;
  stocksOut: string | null;
};

function usage(): void {
  console.log(
    [
      "用法：npm run backtest:kdj -- [选项]",
      "",
      "  --db <path>         本地日K库（默认 backend/data/kline.sqlite）",
      "  --from YYYY-MM-DD   回测起点（默认 2021-01-01）",
      "  --to YYYY-MM-DD     回测终点（默认库内最新交易日）",
      "  --hot-top N         「热门」代理：当日成交额排名前 N（默认 100）",
      "  --window N          「近一个月」= N 个交易日（默认 20）",
      "  --kdj N,K,D         KDJ 参数（默认 9,3,3）",
      "  --min-bars N        参与统计的最少 K 线根数（默认 60）",
      "  --capital N         每票初始资金（默认 100000）",
      "  --boards a,b        只跑指定板块：main,growth,star,bj（默认全部）",
      "  --max-stocks N      只跑抽样后的 N 只（快速试跑，确定性等距抽样）",
      "  --out <path>        报告输出路径（默认 backend/reports/backtest-kdj.md）",
      "  --trades-out <path> 交易明细 CSV 输出路径",
      "  --stocks-out <path> 逐票汇总 CSV 输出路径",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    db: process.env.MARKET_DB_PATH ?? join(BACKEND_ROOT, "data", "kline.sqlite"),
    from: toDateKey("2021-01-01"),
    to: null,
    hotTop: DEFAULT_BACKTEST_PARAMS.hotTopN,
    window: DEFAULT_BACKTEST_PARAMS.hotWindow,
    kdjPeriod: DEFAULT_BACKTEST_PARAMS.kdjPeriod,
    kdjKSmooth: DEFAULT_BACKTEST_PARAMS.kdjKSmooth,
    kdjDSmooth: DEFAULT_BACKTEST_PARAMS.kdjDSmooth,
    minBars: DEFAULT_BACKTEST_PARAMS.minBars,
    capital: DEFAULT_BACKTEST_PARAMS.capital,
    boards: null,
    maxStocks: null,
    out: join(BACKEND_ROOT, "reports", "backtest-kdj.md"),
    tradesOut: null,
    stocksOut: null,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`参数 ${arg} 缺少取值`);
      return value;
    };
    switch (arg) {
      case "--db":
        opts.db = next();
        break;
      case "--from":
        opts.from = toDateKey(next());
        break;
      case "--to":
        opts.to = toDateKey(next());
        break;
      case "--hot-top":
        opts.hotTop = Number(next());
        break;
      case "--window":
        opts.window = Number(next());
        break;
      case "--kdj": {
        const parts = next().split(",").map(Number);
        if (parts.length !== 3 || parts.some((value) => !Number.isInteger(value))) {
          throw new Error("--kdj 需要三个整数，例如 9,3,3");
        }
        opts.kdjPeriod = parts[0] as number;
        opts.kdjKSmooth = parts[1] as number;
        opts.kdjDSmooth = parts[2] as number;
        break;
      }
      case "--min-bars":
        opts.minBars = Number(next());
        break;
      case "--capital":
        opts.capital = Number(next());
        break;
      case "--boards":
        opts.boards = next()
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean) as Board[];
        break;
      case "--max-stocks":
        opts.maxStocks = Number(next());
        break;
      case "--out":
        opts.out = next();
        break;
      case "--trades-out":
        opts.tradesOut = next();
        break;
      case "--stocks-out":
        opts.stocksOut = next();
        break;
      case "--help":
      case "-h":
        usage();
        process.exit(0);
        break;
      default:
        throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    }
  }
  for (const [name, value] of [
    ["--hot-top", opts.hotTop],
    ["--window", opts.window],
    ["--min-bars", opts.minBars],
    ["--capital", opts.capital],
  ] as const) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  }
  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const params: BacktestParams = {
    ...DEFAULT_BACKTEST_PARAMS,
    hotTopN: opts.hotTop,
    hotWindow: opts.window,
    kdjPeriod: opts.kdjPeriod,
    kdjKSmooth: opts.kdjKSmooth,
    kdjDSmooth: opts.kdjDSmooth,
    minBars: opts.minBars,
    capital: opts.capital,
  };

  const store = openMarketStore(opts.db);
  try {
    const latest = store.latestTradeDate();
    if (latest === null) throw new Error("库内没有日线：先跑 npm run bootstrap:kline");
    const requestedTo = opts.to === null ? latest : opts.to;
    const fromDate = opts.from;
    if (fromDate >= requestedTo) {
      throw new Error(`回测区间为空：${fromDateKey(fromDate)} → ${fromDateKey(requestedTo)}`);
    }

    console.error(
      `基准数据：${fromDateKey(fromDate)} → ${fromDateKey(Math.min(requestedTo, latest))}；库内最新 ${fromDateKey(latest)}`,
    );
    const started = Date.now();
    const run = runBacktest(store, {
      fromDate,
      toDate: requestedTo,
      params,
      boards: opts.boards,
      maxStocks: opts.maxStocks,
    });
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const results = run.results;
    const windowStats = run.stats;

    const summary = summarize(results);

    const context: ReportContext = {
      generatedAt: new Date().toISOString(),
      dbPath: opts.db,
      dataLatestDate: latest,
      fromDate,
      toDate: Math.min(requestedTo, latest),
      universeLabel:
        `成交额横截面排名前 ${params.hotTopN}（代理「热门列表」）+ ` +
        `${params.hotWindow} 个交易日内至少一次收盘涨停`,
      hotCalendarDays: run.hotCalendarDays,
      params,
      window: windowStats,
      command: `npm run backtest:kdj -- ${process.argv.slice(2).join(" ")}`.trim(),
    };

    const report = renderReport(results, context);
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, report);
    if (opts.tradesOut) {
      mkdirSync(dirname(opts.tradesOut), { recursive: true });
      writeFileSync(opts.tradesOut, tradesToCsv(results));
    }
    if (opts.stocksOut) {
      mkdirSync(dirname(opts.stocksOut), { recursive: true });
      writeFileSync(opts.stocksOut, stocksToCsv(results));
    }

    const pct = (value: number | null) =>
      value === null ? "—" : `${(value * 100).toFixed(2)}%`;
    console.log("");
    console.log(`回测完成（${elapsed}s）：${windowStats.backtested} 只标的、${summary.trades} 笔交易`);
    console.log(
      `  胜率 ${pct(summary.winRate)}　平均单笔 ${pct(summary.avgNetReturn)}　` +
        `中位单笔 ${pct(summary.medianNetReturn)}　盈亏比 ${summary.profitFactor?.toFixed(2) ?? "—"}`,
    );
    console.log(
      `  逐票平均总收益 ${pct(summary.avgTotalReturn)}　买入持有 ${pct(summary.avgBuyHold)}　` +
        `跑赢 ${summary.beatBuyHoldStocks}/${summary.stocksWithBuyHold}`,
    );
    console.log(`  剔除：区间内无日线 ${windowStats.noBarsInRange}、样本过短 ${windowStats.shortSample}`);
    console.log(`  报告 → ${opts.out}`);
    if (opts.tradesOut) console.log(`  交易明细 → ${opts.tradesOut}`);
    if (opts.stocksOut) console.log(`  逐票汇总 → ${opts.stocksOut}`);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(`回测失败：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

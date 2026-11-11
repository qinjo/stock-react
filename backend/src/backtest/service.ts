import type { Board } from "../market/qlib.js";
import type { MarketStore } from "../market/store.js";
import { backtestStock } from "./engine.js";
import { detectLimits, isStName, limitRatiosFor } from "./limits.js";
import type { BacktestParams, StockResult } from "./types.js";
import { buildAmountRankIndex, eligibilityFlags } from "./universe.js";

/**
 * 回测编排层：把「本地日K库 + 参数」变成逐票结果。
 *
 * 刻意做成**生成器**而不是一条龙函数：CLI 同步消费它，HTTP 路由则分片消费
 * （每 N 只 `await` 一次让出事件循环）。全市场一次约 40–60 秒，同步阻塞会让
 * 同一进程里的健康检查与行情请求全部卡住——那正是"界面看起来死掉"的来源。
 *
 * 本模块只做 I/O 编排与逐票循环，判据全在纯函数层（`engine`/`limits`/`universe`/`kdj`）。
 */

export type BacktestRunOptions = {
  /** 回测区间（含端点），`YYYYMMDD` */
  fromDate: number;
  toDate: number;
  params: BacktestParams;
  /** 只跑指定板块；null 表示全部 */
  boards?: readonly Board[] | null;
  /** 抽样上限（确定性等距），用于快速试跑；null 表示全市场 */
  maxStocks?: number | null;
};

export type BacktestRunStats = {
  instruments: number;
  noBarsInRange: number;
  shortSample: number;
  backtested: number;
};

export type BacktestRun = {
  results: StockResult[];
  stats: BacktestRunStats;
  /** 参与宇宙判定的交易日数 */
  hotCalendarDays: number;
  /** 回测区间内的交易日数 */
  rangeTradingDays: number;
  dataLatestDate: number;
  elapsedMs: number;
};

export type BacktestProgress = {
  done: number;
  total: number;
};

export type BacktestStep =
  | { kind: "progress"; done: number; total: number }
  | { kind: "stock"; result: StockResult; done: number; total: number }
  | { kind: "dropped"; reason: "noBars" | "short"; done: number; total: number }
  | { kind: "done"; run: BacktestRun };

/** 确定性等距抽样：不改变代码顺序偏好，也能覆盖各板块。 */
export function sampleEvenly<T>(items: readonly T[], limit: number | null | undefined): T[] {
  const size = limit ?? items.length;
  if (size <= 0 || items.length <= size) return [...items];
  const stride = items.length / size;
  const out: T[] = [];
  for (let i = 0; i < size; i++) out.push(items[Math.floor(i * stride)] as T);
  return out;
}

/**
 * 逐票推进回测。每次 `next()` 返回一只票的结果或"被剔除"的原因，
 * 最后一步是 `done`（含汇总与耗时）。
 *
 * 调用方负责给每只票之间的边界让出事件循环——CLI 不需要，HTTP 需要。
 */
export function* iterateBacktest(
  store: MarketStore,
  options: BacktestRunOptions,
): Generator<BacktestStep> {
  const started = Date.now();
  const { params } = options;

  const latest = store.latestTradeDate();
  if (latest === null) throw new Error("库内没有日线：先跑 npm run bootstrap:kline");
  const toDate = Math.min(options.toDate, latest);
  const fromDate = options.fromDate;
  if (fromDate >= toDate) {
    throw new Error(`回测区间为空：${fromDate} → ${toDate}`);
  }

  // 宇宙窗口需要区间起点之前的交易日；指标预热直接读全量历史。
  const warmup = store
    .recentTradingDates(fromDate, params.hotWindow)
    .filter((date) => date < fromDate);
  const rangeDates = store.calendarDatesBetween(fromDate, toDate);
  if (rangeDates.length === 0) {
    throw new Error("交易日历为空；库可能不完整，先跑 npm run verify:invariants");
  }
  const hotDates = [...warmup, ...rangeDates];
  const hotIndex = buildAmountRankIndex(store, hotDates, params.hotTopN);

  const instruments = store
    .listInstruments()
    .filter((row) => row.board !== "index")
    .filter((row) => !options.boards || options.boards.includes(row.board));

  const stride = options.maxStocks ?? undefined;
  const universeRows = sampleEvenly(instruments, stride ?? null);

  const stats: BacktestRunStats = {
    instruments: universeRows.length,
    noBarsInRange: 0,
    shortSample: 0,
    backtested: 0,
  };
  const results: StockResult[] = [];

  for (let index = 0; index < universeRows.length; index++) {
    const row = universeRows[index] as (typeof universeRows)[number];
    const bars = store.readBarsUpTo(row.code, toDate);
    if (bars.length === 0 || (bars[bars.length - 1] as { date: number }).date < fromDate) {
      stats.noBarsInRange++;
      yield { kind: "dropped", reason: "noBars", done: index + 1, total: universeRows.length };
      continue;
    }

    const limits = detectLimits(bars, {
      ratios: limitRatiosFor(row.board, isStName(row.name)),
    });
    const eligible = eligibilityFlags(bars, row.code, hotIndex, limits.upClose, params.hotWindow);
    const result = backtestStock(
      { code: row.code, name: row.name, board: row.board, bars, eligible },
      { params, fromDate, toDate, keepEquityCurve: false },
    );
    if (result === null) {
      stats.shortSample++;
      yield { kind: "dropped", reason: "short", done: index + 1, total: universeRows.length };
      continue;
    }
    stats.backtested++;
    results.push(result);
    yield { kind: "stock", result, done: index + 1, total: universeRows.length };
  }

  yield {
    kind: "done",
    run: {
      results,
      stats,
      hotCalendarDays: hotDates.length,
      rangeTradingDays: rangeDates.length,
      dataLatestDate: latest,
      elapsedMs: Date.now() - started,
    },
  };
}

/** 同步跑完（CLI 用）。 */
export function runBacktest(store: MarketStore, options: BacktestRunOptions): BacktestRun {
  const iterator = iterateBacktest(store, options);
  let step = iterator.next();
  while (!step.done) {
    if (step.value.kind === "done") return step.value.run;
    step = iterator.next();
  }
  // 生成器正常应在 done 步返回汇总；走不到这里
  throw new Error("回测未产出结果");
}

/**
 * 分片异步跑完（HTTP 用）：每处理 `yieldEvery` 只票让出一次事件循环，
 * 避免一次 40–60 秒的同步计算把整个后端卡死。
 */
export async function runBacktestAsync(
  store: MarketStore,
  options: BacktestRunOptions,
  hooks: { yieldEvery?: number; onProgress?: (progress: BacktestProgress) => void } = {},
): Promise<BacktestRun> {
  const yieldEvery = hooks.yieldEvery ?? 200;
  const iterator = iterateBacktest(store, options);
  let processed = 0;

  for (;;) {
    const step = iterator.next();
    if (step.done) break;
    const value = step.value;
    if (value.kind === "done") return value.run;
    if (value.kind === "stock" || value.kind === "dropped") {
      processed++;
      if (processed % yieldEvery === 0) {
        hooks.onProgress?.({ done: value.done, total: value.total });
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
  }
  throw new Error("回测未产出结果");
}

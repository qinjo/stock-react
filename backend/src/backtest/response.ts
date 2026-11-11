import { fromDateKey } from "../market/qlib.js";
import {
  BOARD_LABELS,
  bucketByBoard,
  bucketByYear,
  returnHistogram,
  summarize,
  type Summary,
  type TradeBucket,
} from "./metrics.js";
import type { BacktestRun } from "./service.js";
import type { BacktestParams, StockResult } from "./types.js";

/**
 * HTTP 响应 DTO。
 *
 * 刻意**不**返回逐日权益曲线与全部交易：全市场一次约万笔交易，
 * 塞进 JSON 会让前端白等几十 MB。这里只给"回答用户问题所需的最小集"：
 * 分布、分桶、指标、两端个股。明细留给 CLI 的 CSV。
 */

export type BacktestParamsEcho = {
  kdjPeriod: number;
  kdjKSmooth: number;
  kdjDSmooth: number;
  hotWindow: number;
  hotTopN: number;
  minBars: number;
  capital: number;
  commissionRate: number;
  commissionMin: number;
  stampTaxRate: number;
  transferFeeRate: number;
};

export type BacktestStockRow = {
  code: string;
  name: string | null;
  board: string;
  boardLabel: string;
  trades: number;
  winRate: number | null;
  totalReturn: number;
  buyHoldReturn: number | null;
  maxDrawdown: number;
};

export type BacktestWindowStats = {
  instruments: number;
  noBarsInRange: number;
  shortSample: number;
  backtested: number;
};

export type BacktestResponse = {
  status: "ok";
  /** 库内最新交易日 `YYYY-MM-DD` */
  dataDate: string;
  /** 实际回测区间（已按库内最新日截断） */
  from: string;
  to: string;
  params: BacktestParamsEcho;
  universe: string;
  sample: number | null;
  window: BacktestWindowStats;
  summary: Summary;
  tradedSummary: Summary;
  buckets: { year: TradeBucket[]; board: TradeBucket[] };
  histogram: Array<{ from: number; to: number; count: number }>;
  stocks: {
    /** 有交易的标的数（两端表的分母） */
    traded: number;
    best: BacktestStockRow[];
    worst: BacktestStockRow[];
  };
  elapsedMs: number;
  fromCache: boolean;
};

const BOARD_ORDER = ["main", "growth", "star", "bj"];

function stockRow(result: StockResult): BacktestStockRow {
  const summary = summarize([result]);
  return {
    code: result.code,
    name: result.name,
    board: result.board,
    boardLabel: BOARD_LABELS[result.board] ?? result.board,
    trades: result.trades.length,
    winRate: summary.winRate,
    totalReturn: result.totalReturn,
    buyHoldReturn: result.buyHoldReturn,
    maxDrawdown: result.maxDrawdown,
  };
}

export function toBacktestResponse(
  run: BacktestRun,
  options: {
    fromDate: number;
    toDate: number;
    params: BacktestParams;
    sample: number | null;
    fromCache: boolean;
  },
): BacktestResponse {
  const params = options.params;
  const traded = run.results.filter((result) => result.trades.length > 0);
  const ranked = [...traded].sort((a, b) => b.totalReturn - a.totalReturn);
  const boards = bucketByBoard(run.results).sort(
    (a, b) =>
      BOARD_ORDER.indexOf(boardKeyOf(a.key)) - BOARD_ORDER.indexOf(boardKeyOf(b.key)),
  );

  return {
    status: "ok",
    dataDate: fromDateKey(run.dataLatestDate),
    from: fromDateKey(options.fromDate),
    to: fromDateKey(options.toDate),
    params: {
      kdjPeriod: params.kdjPeriod,
      kdjKSmooth: params.kdjKSmooth,
      kdjDSmooth: params.kdjDSmooth,
      hotWindow: params.hotWindow,
      hotTopN: params.hotTopN,
      minBars: params.minBars,
      capital: params.capital,
      commissionRate: params.commissionRate,
      commissionMin: params.commissionMin,
      stampTaxRate: params.stampTaxRate,
      transferFeeRate: params.transferFeeRate,
    },
    universe: `成交额横截面排名前 ${params.hotTopN}（代理「热门列表」）+ ${params.hotWindow} 个交易日内至少一次收盘涨停`,
    sample: options.sample,
    window: run.stats,
    summary: summarize(run.results),
    tradedSummary: summarize(traded),
    buckets: {
      year: bucketByYear(run.results),
      board: boards,
    },
    histogram: returnHistogram(run.results),
    stocks: {
      traded: traded.length,
      best: ranked.slice(0, 10).map(stockRow),
      worst: ranked.slice(-10).reverse().map(stockRow),
    },
    elapsedMs: run.elapsedMs,
    fromCache: options.fromCache,
  };
}

function boardKeyOf(label: string): string {
  const entry = Object.entries(BOARD_LABELS).find(([, value]) => value === label);
  return entry ? entry[0] : label;
}

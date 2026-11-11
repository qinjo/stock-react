import type { StockResult, Trade } from "./types.js";

/**
 * 统计层（纯函数）。
 *
 * 一个刻意的设计：`summarize` 统计的是**传入的集合**，不做隐式的筛选。
 * 报告里"全部样本 / 有交易的样本 / 跑赢基准的样本"三张表，是同一次函数的三次调用——
 * 这样"分母是谁"永远显式可见，而不是藏在某个 `if` 里。
 */

export type Summary = {
  /** 传入的标的总数 */
  stocks: number;
  /** 其中至少成交过一笔的标的数 */
  tradedStocks: number;
  trades: number;
  /** 期末仍未平仓的笔数（按收盘价计值，未计卖出费用） */
  openTrades: number;
  wins: number;
  /** 胜率；无成交时为 null */
  winRate: number | null;
  avgNetReturn: number | null;
  medianNetReturn: number | null;
  /** 盈亏比 = 盈利单总和 / 亏损单绝对值总和；无亏损单时为 null */
  profitFactor: number | null;
  /** 最差单笔净收益 */
  maxLoss: number | null;
  avgHoldingDays: number | null;
  avgTotalReturn: number | null;
  medianTotalReturn: number | null;
  p25TotalReturn: number | null;
  p75TotalReturn: number | null;
  avgBuyHold: number | null;
  medianBuyHold: number | null;
  /** 策略总收益高于同期买入持有的标的数 */
  beatBuyHoldStocks: number;
  /** 有买入持有基准的标的数（分母） */
  stocksWithBuyHold: number;
  avgMaxDrawdown: number | null;
  eligibleSignals: number;
  unfilledSignals: number;
};

export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (q <= 0) return sorted[0] as number;
  if (q >= 1) return sorted[sorted.length - 1] as number;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return quantile(sorted, 0.5);
}

export function summarize(results: readonly StockResult[]): Summary {
  const trades = results.flatMap((result) => result.trades);
  const wins = trades.filter((trade) => trade.netReturn > 0).length;
  const netReturns = trades.map((trade) => trade.netReturn);
  const gains = trades.filter((trade) => trade.netReturn > 0).reduce((sum, t) => sum + t.netReturn, 0);
  const losses = trades
    .filter((trade) => trade.netReturn < 0)
    .reduce((sum, t) => sum + Math.abs(t.netReturn), 0);
  const totalReturns = results.map((result) => result.totalReturn).sort((a, b) => a - b);
  const buyHolds = results
    .map((result) => result.buyHoldReturn)
    .filter((value): value is number => value !== null)
    .sort((a, b) => a - b);
  const drawdowns = results.map((result) => result.maxDrawdown);
  const holdingDays = trades.map((trade) => trade.holdingDays);
  const beatBuyHold = results.filter(
    (result) => result.buyHoldReturn !== null && result.totalReturn > result.buyHoldReturn,
  ).length;

  return {
    stocks: results.length,
    tradedStocks: results.filter((result) => result.trades.length > 0).length,
    trades: trades.length,
    openTrades: trades.filter((trade) => trade.openAtEnd).length,
    wins,
    winRate: trades.length > 0 ? wins / trades.length : null,
    avgNetReturn: mean(netReturns),
    medianNetReturn: median(netReturns),
    profitFactor: losses > 0 ? gains / losses : null,
    maxLoss: netReturns.length > 0 ? Math.min(...netReturns) : null,
    avgHoldingDays: mean(holdingDays),
    avgTotalReturn: mean(totalReturns),
    medianTotalReturn: quantile(totalReturns, 0.5),
    p25TotalReturn: quantile(totalReturns, 0.25),
    p75TotalReturn: quantile(totalReturns, 0.75),
    avgBuyHold: mean(buyHolds),
    medianBuyHold: quantile(buyHolds, 0.5),
    beatBuyHoldStocks: beatBuyHold,
    stocksWithBuyHold: buyHolds.length,
    avgMaxDrawdown: mean(drawdowns),
    eligibleSignals: results.reduce((sum, result) => sum + result.eligibleSignals, 0),
    unfilledSignals: results.reduce((sum, result) => sum + result.unfilledSignals, 0),
  };
}

export type TradeBucket = {
  key: string;
  trades: number;
  wins: number;
  winRate: number | null;
  avgNetReturn: number | null;
  medianNetReturn: number | null;
};

/**
 * 按任意键给**交易**分桶（年份、板块、持有天数区间……）。
 * 不按标的聚合：同一只票跨年度的交易应该落进不同的桶，否则"某年行情好坏"会被摊平。
 */
export function bucketTrades(
  results: readonly StockResult[],
  keyOf: (trade: Trade, result: StockResult) => string,
): TradeBucket[] {
  const buckets = new Map<string, Trade[]>();
  for (const result of results) {
    for (const trade of result.trades) {
      const key = keyOf(trade, result);
      const list = buckets.get(key);
      if (list) list.push(trade);
      else buckets.set(key, [trade]);
    }
  }
  return [...buckets.entries()]
    .map(([key, trades]) => {
      const wins = trades.filter((trade) => trade.netReturn > 0).length;
      const returns = trades.map((trade) => trade.netReturn);
      return {
        key,
        trades: trades.length,
        wins,
        winRate: trades.length > 0 ? wins / trades.length : null,
        avgNetReturn: mean(returns),
        medianNetReturn: median(returns),
      };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 按买入年份分桶。 */
export function bucketByYear(results: readonly StockResult[]): TradeBucket[] {
  return bucketTrades(results, (trade) => String(trade.entryDate).slice(0, 4));
}

export const BOARD_LABELS: Record<string, string> = {
  main: "主板",
  growth: "创业板",
  star: "科创板",
  bj: "北交所",
  index: "指数",
};

/** 按板块分桶。 */
export function bucketByBoard(results: readonly StockResult[]): TradeBucket[] {
  return bucketTrades(results, (_trade, result) => BOARD_LABELS[result.board] ?? result.board);
}

/** 单笔收益率的直方图（用于报告里的分布描述）。 */
export function returnHistogram(
  results: readonly StockResult[],
  bucketSize = 0.05,
): Array<{ from: number; to: number; count: number }> {
  const trades = results.flatMap((result) => result.trades);
  if (trades.length === 0) return [];
  const returns = trades.map((trade) => trade.netReturn);
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const from = Math.floor(min / bucketSize) * bucketSize;
  const to = Math.ceil(max / bucketSize) * bucketSize;
  const buckets: Array<{ from: number; to: number; count: number }> = [];
  for (let edge = from; edge < to - 1e-12; edge += bucketSize) {
    buckets.push({ from: edge, to: edge + bucketSize, count: 0 });
  }
  for (const value of returns) {
    const idx = Math.min(buckets.length - 1, Math.max(0, Math.floor((value - from) / bucketSize)));
    (buckets[idx] as { count: number }).count++;
  }
  return buckets;
}

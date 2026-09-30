import type { Board } from "../market/qlib.js";
import type { DailyBar } from "./types.js";

/**
 * 结构原语（纯函数，零 I/O）。
 *
 * 源书是一套**几何化**系统：它不给量价阈值，给的是均线位置与结构位置。
 * 这里把"位置"落成可计算、可单测的原语——显著高低点、下降趋势线、震荡区间、
 * 均线穿越计数、涨停判定。信号层（123 结构、缺口、涨停位置）在它们之上搭建。
 */

/** 后复权收盘序列：跨除权保持连续，均线类指标必须用它。 */
export function adjustedCloses(bars: readonly DailyBar[]): number[] {
  return bars.map((bar) => bar.close * bar.adjFactor);
}

/** 后复权价（任一字段）：`不复权价 × 因子`。 */
export function adjustedPrice(value: number, adjFactor: number): number {
  return value * adjFactor;
}

/**
 * 简单移动平均序列，与输入**同长度对齐**（不足处为 null）。
 *
 * 刻意不用指标库：库只返回可计算的那一段，与日 K 下标做对齐时极易差一位，
 * 而"差一位"在穿越计数与结构回溯里会静默给出错误结论。
 */
export function smaSeries(values: readonly number[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(values.length).fill(null);
  if (period <= 0 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i] as number;
    if (i >= period) sum -= values[i - period] as number;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export type SwingPoint = { index: number; price: number };

/**
 * 显著高点：左右各 `window` 根的高点都不超过它。
 * 最后一根不参与判定——右侧还没有足够的 K 线确认它是高点。
 */
export function findSwingHighs(bars: readonly DailyBar[], window: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const price = (bars[i] as DailyBar).high;
    let isSwing = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if ((bars[j] as DailyBar).high > price) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) out.push({ index: i, price });
  }
  return out;
}

/** 显著低点：左右各 `window` 根的低点都不低于它。 */
export function findSwingLows(bars: readonly DailyBar[], window: number): SwingPoint[] {
  const out: SwingPoint[] = [];
  for (let i = window; i < bars.length - window; i++) {
    const price = (bars[i] as DailyBar).low;
    let isSwing = true;
    for (let j = i - window; j <= i + window; j++) {
      if (j === i) continue;
      if ((bars[j] as DailyBar).low < price) {
        isSwing = false;
        break;
      }
    }
    if (isSwing) out.push({ index: i, price });
  }
  return out;
}

/**
 * 下降趋势线：把最近两个显著高点相连并延长，返回**最后一根 K 线处**的取值。
 *
 * 书 L585：高点与次高点相连并延长。趋势线只有在"后一个高点低于前一个"时才是下降线，
 * 否则返回 null（不能把上升趋势线当成下跌压力线用）。
 */
export function fallingTrendlineAt(
  bars: readonly DailyBar[],
  window: number,
  lookback: number,
): number | null {
  if (bars.length < lookback) return null;
  const from = bars.length - lookback;
  const highs = findSwingHighs(bars, window).filter((p) => p.index >= from);
  if (highs.length < 2) return null;

  const last = highs[highs.length - 1] as SwingPoint;
  const prev = highs[highs.length - 2] as SwingPoint;
  if (last.price >= prev.price) return null; // 不是下降趋势线

  const span = last.index - prev.index;
  if (span <= 0) return null;
  const slope = (last.price - prev.price) / span;
  return last.price + slope * (bars.length - 1 - last.index);
}

export type RangeBounds = {
  low: number;
  high: number;
  /** 带宽 / 收盘价 */
  width: number;
  /**
   * 净位移 / 带宽：区间起点到现在的位移占整个带宽的比例。
   *
   * 这个量是"震荡"与"缓慢上涨"的判别式——只看带宽会把稳步上涨的票误判成震荡
   * （涨得慢 ⇒ 60 日带宽自然就窄）。真正来回震荡的票净位移接近于 0。
   */
  progress: number;
};

/**
 * 震荡区间：最近 `window` 根（**不含最后一根**）的最高与最低构成的价格带。
 *
 * 刻意排除最后一根：否则最后一根自己的最高价必然就是区间上沿，
 * "收盘突破区间上沿"这个判断永远不成立。
 */
export function rangeBounds(bars: readonly DailyBar[], window: number): RangeBounds | null {
  if (bars.length < window + 1 || window <= 0) return null;
  const slice = bars.slice(-(window + 1), -1);
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const bar of slice) {
    if (bar.low < low) low = bar.low;
    if (bar.high > high) high = bar.high;
  }
  const close = (bars[bars.length - 1] as DailyBar).close;
  const startClose = (slice[0] as DailyBar).close;
  const span = high - low;

  return {
    low,
    high,
    width: close > 0 ? span / close : 0,
    progress: span > 0 ? Math.abs(close - startClose) / span : 0,
  };
}

/** 窗口内 `close` 相对某参考序列（如 MA100）的穿越次数。 */
export function countCrossings(
  values: readonly number[],
  reference: ReadonlyArray<number | null>,
  window: number,
): number {
  const start = Math.max(1, values.length - window);
  let crossings = 0;
  let previousSign = 0;

  for (let i = start - 1; i < values.length; i++) {
    const ref = reference[i];
    if (ref === null || ref === undefined) continue;
    const diff = (values[i] as number) - ref;
    const sign = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (sign !== 0 && previousSign !== 0 && sign !== previousSign) crossings++;
    if (sign !== 0) previousSign = sign;
  }
  return crossings;
}

/* ------------------------------- 涨停判定 ------------------------------- */

/** 各板块的涨停幅度。北交所 30%，创业板/科创板 20%，其余 10%。 */
export function limitUpRatio(board: Board): number {
  if (board === "bj") return 0.3;
  if (board === "star" || board === "growth") return 0.2;
  return 0.1;
}

/** 涨停价：交易所按「前收盘 × (1 + 幅度)」四舍五入到分。 */
export function limitUpPrice(prevClose: number, board: Board): number {
  return Math.round(prevClose * (1 + limitUpRatio(board)) * 100) / 100;
}

/**
 * 逐根标记涨停。
 *
 * 基数用**前一交易日的不复权收盘**（真实成交价空间）；这是交易所口径的近似——
 * 严格说除权日的基数应是「除权后昨收」，但那一天的不复权收益率本身就被除权打歪了，
 * 而我们每日的除权检测会在增量时把这类标的单独标出来复核。
 */
export function limitUpFlags(bars: readonly DailyBar[], board: Board): boolean[] {
  const flags: boolean[] = bars.map(() => false);
  for (let i = 1; i < bars.length; i++) {
    const prevClose = (bars[i - 1] as DailyBar).close;
    if (prevClose <= 0) continue;
    const target = limitUpPrice(prevClose, board);
    flags[i] = (bars[i] as DailyBar).close >= target - 1e-6;
  }
  return flags;
}

/** 一字板：当日最高等于最低，实际上买不到。 */
export function isOneWordBoard(bar: DailyBar): boolean {
  return bar.high === bar.low;
}

/* ------------------------------- 走势流畅度 ------------------------------- */

/**
 * 20 日对数价格的线性回归 R²（走势流畅度）。
 * 书用「走势流畅 / 凌厉」描述强势股，严格档据此再筛一道。
 */
export function trendR2(bars: readonly DailyBar[], window = 20): number | null {
  if (bars.length < window) return null;
  const closes = bars.slice(-window).map((bar) => Math.log(bar.close));
  const n = closes.length;
  const xs = closes.map((_, i) => i);
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = closes.reduce((a, b) => a + b, 0) / n;

  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = (xs[i] as number) - meanX;
    const dy = (closes[i] as number) - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return (sxy * sxy) / (sxx * syy);
}

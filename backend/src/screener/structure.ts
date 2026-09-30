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

/** 一次摆动点：低点或高点，按时间顺序排列后用于识别形态。 */
type Swing = SwingPoint & { kind: "low" | "high" };

/**
 * 低位 123 结构（书 A-3.1，全书最重要的形态规则）。
 *
 * 形状：低点 1 → 高点 2 → 低点 3，且**低点 3 高于低点 1**（底部抬高的上升结构）。
 * 书的用法（L681/L689/L707）：
 * - 入场 = 突破高点 2
 * - 止损 = 低点 3（轻仓可用低点 1；跌破 3 减半、跌破 1 清仓）
 */
export type Low123Structure = {
  /** 低点 1 */
  l1: SwingPoint;
  /** 高点 2 */
  h2: SwingPoint;
  /** 低点 3 */
  l3: SwingPoint;
  /** 最新收盘是否已突破高点 2 */
  brokenOut: boolean;
  /** 收盘相对高点 2 的偏离（比值）：未突破时为负 */
  breakoutRatio: number;
  /** 止损位 = 低点 3 */
  stop: number;
  /** 结构跨度（交易日） */
  span: number;
};

/**
 * 识别最近一次有效的低位 123 结构；没有则返回 null。
 *
 * 从**最近的高点往回找**：这样拿到的是"最新形成"的那个结构，
 * 而不是历史上第一个碰巧成立的形态——后者早已失效，拿它当入场依据会错过当下。
 *
 * `lookback` 按严格度三档取值（宽松 120 / 标准 60 / 严格 30 个交易日）：
 * 放宽窗口会捞到更久远的老结构，收紧则只认近期刚形成的。
 */
export function detectLow123(
  bars: readonly DailyBar[],
  options: { swingWindow?: number; lookback?: number } = {},
): Low123Structure | null {
  const window = options.swingWindow ?? 5;
  const lookback = options.lookback ?? 60;
  if (bars.length < window * 2 + 3) return null;

  const from = Math.max(0, bars.length - lookback);
  const swings: Swing[] = [
    ...findSwingLows(bars, window).map((p) => ({ ...p, kind: "low" as const })),
    ...findSwingHighs(bars, window).map((p) => ({ ...p, kind: "high" as const })),
  ]
    .filter((p) => p.index >= from)
    .sort((a, b) => a.index - b.index);

  const close = (bars[bars.length - 1] as DailyBar).close;

  // 从最近的高点往前找：最近的高点若两侧都有低点、且低点 3 高于低点 1，即为有效结构
  for (let i = swings.length - 1; i >= 0; i--) {
    const h2 = swings[i] as Swing;
    if (h2.kind !== "high") continue;

    let l1: SwingPoint | null = null;
    for (let j = i - 1; j >= 0; j--) {
      const candidate = swings[j] as Swing;
      if (candidate.kind === "low") {
        l1 = candidate;
        break;
      }
    }
    let l3: SwingPoint | null = null;
    for (let j = i + 1; j < swings.length; j++) {
      const candidate = swings[j] as Swing;
      if (candidate.kind === "low") {
        l3 = candidate;
        break;
      }
    }
    if (!l1 || !l3) continue;
    // 书 L689：低点 3 必须高于低点 1，否则是继续下行的结构而不是底部抬高
    if (l3.price <= l1.price) continue;

    return {
      l1,
      h2,
      l3,
      brokenOut: close > h2.price,
      breakoutRatio: h2.price > 0 ? close / h2.price - 1 : 0,
      stop: l3.price,
      span: l3.index - l1.index,
    };
  }
  return null;
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

/**
 * 指数移动平均序列，与输入**同长度对齐**（采用首值播种）。
 *
 * 刻意自己算而不用指标库：库返回的是可计算的那一段，与日 K 下标对齐时极易差一位，
 * 而底背离判定比的正是"两个低点处的 DIF"，差一位就会把背离判反。
 */
export function emaSeries(values: readonly number[], period: number): number[] {
  const out: number[] = [];
  if (values.length === 0) return out;
  const k = 2 / (period + 1);
  let previous = values[0] as number;
  out.push(previous);
  for (let i = 1; i < values.length; i++) {
    previous = (values[i] as number) * k + previous * (1 - k);
    out.push(previous);
  }
  return out;
}

/** MACD 快线 DIF = EMA(12) − EMA(26)，与输入同长度对齐。 */
export function macdDifSeries(values: readonly number[]): number[] {
  const fast = emaSeries(values, 12);
  const slow = emaSeries(values, 26);
  return values.map((_, i) => (fast[i] as number) - (slow[i] as number));
}

/* ------------------------------ 波动与缺口 ------------------------------ */

/** 真实波幅：max(高−低, |高−昨收|, |低−昨收|)。 */
export function trueRange(bar: DailyBar, prevClose: number | null): number {
  if (prevClose === null) return bar.high - bar.low;
  return Math.max(bar.high - bar.low, Math.abs(bar.high - prevClose), Math.abs(bar.low - prevClose));
}

/** ATR 序列，与输入同长度对齐（前 period 根为 null）。 */
export function atrSeries(bars: readonly DailyBar[], period: number): Array<number | null> {
  const out: Array<number | null> = new Array(bars.length).fill(null);
  if (bars.length < period + 1 || period <= 0) return out;

  const ranges = bars.map((bar, i) =>
    trueRange(bar, i === 0 ? null : (bars[i - 1] as DailyBar).close),
  );
  // 首个 ATR 用简单均值播种，其后按 Wilder 平滑（与常用口径一致）
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += ranges[i] as number;
  let value = sum / period;
  out[period] = value;
  for (let i = period + 1; i < bars.length; i++) {
    value = (value * (period - 1) + (ranges[i] as number)) / period;
    out[i] = value;
  }
  return out;
}

/** 一次向上跳空。 */
export type UpwardGap = {
  /** 跳空日下标 */
  index: number;
  /** 缺口下沿 = 前一根的最高价；跌破它即视为缺口被回补 */
  lower: number;
  /** 跳空日的最高价 */
  upper: number;
  /** 缺口宽度（价格） */
  size: number;
  /** 缺口宽度 / ATR；ATR 不可用时为 null */
  atrMultiple: number | null;
  /** 是否向上**突破性**缺口：跳空越过了前 `lookback` 根的最高价 */
  breakout: boolean;
  /** 是否已被回补 */
  filled: boolean;
  /** 距今多少根（0 = 当天） */
  age: number;
};

/**
 * 找最近一次向上跳空。
 *
 * 书把缺口分成两类（L1286/L1330）：
 * - **突破性缺口**：跳空越过前期高点 / 区间上沿 —— 起涨的第一跳
 * - **持续性缺口**：已确立上涨趋势途中的跳空 —— 趋势中继
 * 两者的分界就是"这一跳有没有越过前面那段区间的最高价"。
 */
export function detectUpwardGap(
  bars: readonly DailyBar[],
  options: { lookback: number; maxAge: number; atr?: Array<number | null> },
): UpwardGap | null {
  const { lookback, maxAge } = options;
  if (bars.length < 3) return null;

  const newest = bars.length - 1;
  const oldest = Math.max(1, newest - maxAge);
  for (let t = newest; t >= oldest; t--) {
    const bar = bars[t] as DailyBar;
    const prev = bars[t - 1] as DailyBar;
    if (!(bar.low > prev.high)) continue;

    const lower = prev.high;
    const size = bar.low - lower;
    const rangeStart = Math.max(0, t - 1 - lookback);
    let priorHigh = Number.NEGATIVE_INFINITY;
    for (let i = rangeStart; i <= t - 2; i++) {
      const high = (bars[i] as DailyBar).high;
      if (high > priorHigh) priorHigh = high;
    }
    const breakout = Number.isFinite(priorHigh) ? bar.low > priorHigh : false;
    // 回补：跳空日之后有任一根的最低价跌回缺口下沿之下
    let filled = false;
    for (let i = t + 1; i <= newest; i++) {
      if ((bars[i] as DailyBar).low <= lower) {
        filled = true;
        break;
      }
    }
    const atr = options.atr?.[t] ?? null;
    return {
      index: t,
      lower,
      upper: bar.high,
      size,
      atrMultiple: atr !== null && atr > 0 ? size / atr : null,
      breakout,
      filled,
      age: newest - t,
    };
  }
  return null;
}

/**
 * 区间内是否存在**向下**跳空，返回它的上沿（= 跳空前一低点）。
 *
 * 书 L1477 的「涨停 B 形态」要求"当日大阳线收复回调时的下跌缺口"，
 * 所以这里要找的是回调途中的那个下跌缺口的边界。
 */
export function findDownwardGapUpper(
  bars: readonly DailyBar[],
  from: number,
  to: number,
): number | null {
  for (let t = Math.max(1, from); t <= Math.min(to, bars.length - 1); t++) {
    const bar = bars[t] as DailyBar;
    const prev = bars[t - 1] as DailyBar;
    if (bar.high < prev.low) return prev.low;
  }
  return null;
}

/** 窗口内涨停次数。 */
export function countLimitUp(flags: readonly boolean[], window: number): number {
  const from = Math.max(0, flags.length - window);
  let count = 0;
  for (let i = from; i < flags.length; i++) if (flags[i]) count++;
  return count;
}

/** 窗口内的最大回撤（从区间内最高收盘到此后最低收盘，正数表示跌幅）。 */
export function drawdownInWindow(bars: readonly DailyBar[], window: number): number {
  const from = Math.max(0, bars.length - window);
  let peak = Number.NEGATIVE_INFINITY;
  let worst = 0;
  for (let i = from; i < bars.length; i++) {
    const close = (bars[i] as DailyBar).close;
    if (close > peak) peak = close;
    if (peak > 0) {
      const drop = (peak - close) / peak;
      if (drop > worst) worst = drop;
    }
  }
  return worst;
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

import { ATR, MACD, RSI, SMA } from "technicalindicators";
import type { Kline } from "./domain.js";

/**
 * 派生技术指标层（纯函数，无网络）。
 *
 * 设计原则（来自调研笔记第 4 节）：**派生指标由代码算好再喂模型，不让 LLM 做算术**，
 * 以消除计算不一致与「微积分幻觉」。
 *
 * 数据不足时各指标独立返回 null（如样本 < 200 时 SMA200 为 null），
 * 只有样本少于最小要求（MIN_SAMPLES）才整体判为数据不足并抛错。
 */

/**
 * 少于该样本数视为数据不足，无法产出有意义的分析输入。
 *
 * 取 60 的依据：MACD 需 26+9=35 点、SMA50 需 50 点、20 日指标需 21 点；
 * 低于 60 根时多数指标只能返回 null，分析价值不足（新股上市过短即属此列）。
 */
export const MIN_SAMPLES = 60;

/** 数据不足（如新股上市过短），由路由映射为 INSUFFICIENT_DATA。 */
export class InsufficientDataError extends Error {
  constructor(readonly samples: number) {
    super(`历史数据不足：仅 ${samples} 根，至少需要 ${MIN_SAMPLES} 根`);
    this.name = "InsufficientDataError";
  }
}

export type Macd = {
  /** DIF（快慢线之差） */
  dif: number | null;
  /** DEA（DIF 的信号线） */
  dea: number | null;
  /** 柱状图（DIF − DEA） */
  hist: number | null;
};

export type Indicators = {
  /** 参与计算的日 K 根数 */
  sampleSize: number;
  /** 样本区间（便于与行情日期对齐，避免点时间错配） */
  fromDate: string;
  toDate: string;
  sma50: number | null;
  sma200: number | null;
  /** 最新收盘相对均线的偏离（%）：正=在均线上方 */
  priceVsSma50: number | null;
  priceVsSma200: number | null;
  /** RSI(14)，取值 0–100；强趋势中可能长期处于极端区（提示词需注明） */
  rsi14: number | null;
  macd: Macd;
  /** ATR(14)，价格单位 */
  atr14: number | null;
  /** ATR 占最新收盘的百分比（波动幅度可读化） */
  atrPercent: number | null;
  /** 近 20 个交易日涨跌幅（%） */
  return20d: number | null;
  /** 近 60 个交易日涨跌幅（%） */
  return60d: number | null;
  /** 近 20 日年化波动率（%），按 252 交易日折算 */
  volatility20d: number | null;
  /** 样本区间最高价 */
  periodHigh: number;
  /** 样本区间最低价 */
  periodLow: number;
  /** 最新收盘处于区间的位置（0=最低，100=最高） */
  positionInRange: number | null;
};

/** 截取最后 n 个元素，样本不足时返回 null。 */
function last<T>(arr: T[], n = 1): T | null {
  return arr.length >= n ? (arr[arr.length - n] as T) : null;
}

function round(v: number | null | undefined, digits = 2): number | null {
  return v === null || v === undefined || !Number.isFinite(v)
    ? null
    : Number(v.toFixed(digits));
}

/** 区间涨跌幅（%）：最新收盘相对 n 个交易日前收盘。 */
function periodReturn(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const now = closes[closes.length - 1] as number;
  const then = closes[closes.length - 1 - n] as number;
  if (then === 0) return null;
  return round(((now - then) / then) * 100);
}

/** 年化波动率（%）：日对数收益标准差 × √252。 */
function annualizedVolatility(closes: number[], n: number): number | null {
  if (closes.length < n + 1) return null;
  const window = closes.slice(-(n + 1));
  const returns: number[] = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1] as number;
    const cur = window[i] as number;
    if (prev > 0 && cur > 0) returns.push(Math.log(cur / prev));
  }
  if (returns.length < 2) return null;
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((sum, r) => sum + (r - mean) ** 2, 0) / (returns.length - 1);
  return round(Math.sqrt(variance) * Math.sqrt(252) * 100);
}

/**
 * 计算派生技术指标。输入应尽量长（≥200 根日 K 才能给出 SMA200）。
 * @throws InsufficientDataError 当样本少于 MIN_SAMPLES
 */
export function computeIndicators(klines: Kline[]): Indicators {
  if (klines.length < MIN_SAMPLES) throw new InsufficientDataError(klines.length);

  const closes = klines.map((k) => k.close);
  const highs = klines.map((k) => k.high);
  const lows = klines.map((k) => k.low);
  const latestClose = closes[closes.length - 1] as number;

  const sma50 = round(last(SMA.calculate({ period: 50, values: closes })));
  const sma200 = round(last(SMA.calculate({ period: 200, values: closes })));

  const rsiRaw = last(RSI.calculate({ period: 14, values: closes }));
  // 边界校验：RSI 必须落在 0–100，越界说明数据或库行为异常
  const rsi14 = rsiRaw === null ? null : round(Math.min(100, Math.max(0, rsiRaw)));

  const macdRaw = last(
    MACD.calculate({
      values: closes,
      fastPeriod: 12,
      slowPeriod: 26,
      signalPeriod: 9,
      SimpleMAOscillator: false,
      SimpleMASignal: false,
    }),
  );

  const atrRaw = last(ATR.calculate({ high: highs, low: lows, close: closes, period: 14 }));

  const periodHigh = Math.max(...highs);
  const periodLow = Math.min(...lows);

  return {
    sampleSize: klines.length,
    fromDate: klines[0]!.date,
    toDate: klines[klines.length - 1]!.date,
    sma50,
    sma200,
    priceVsSma50: sma50 ? round(((latestClose - sma50) / sma50) * 100) : null,
    priceVsSma200: sma200 ? round(((latestClose - sma200) / sma200) * 100) : null,
    rsi14,
    macd: {
      dif: round(macdRaw?.MACD),
      dea: round(macdRaw?.signal),
      hist: round(macdRaw?.histogram),
    },
    atr14: round(atrRaw),
    atrPercent: atrRaw ? round((atrRaw / latestClose) * 100) : null,
    return20d: periodReturn(closes, 20),
    return60d: periodReturn(closes, 60),
    volatility20d: annualizedVolatility(closes, 20),
    periodHigh: round(periodHigh) as number,
    periodLow: round(periodLow) as number,
    positionInRange:
      periodHigh === periodLow
        ? null
        : round(((latestClose - periodLow) / (periodHigh - periodLow)) * 100, 1),
  };
}

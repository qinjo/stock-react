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

/** 书里使用的均线阶梯。源书只给均线参数，不给量价阈值（作者明言「根本不研究成交量」）。 */
export type MaSet = {
  ma5: number | null;
  ma10: number | null;
  ma20: number | null;
  ma60: number | null;
  ma100: number | null;
  ma120: number | null;
  ma144: number | null;
};

/** 周线重采样后的 bar。书的「看长做短」依赖周线级别判断。 */
export type WeeklyBar = {
  /** ISO 8601 周键，如 `2026-W39` */
  week: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 成交量（手），本周各日之和 */
  volume: number;
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
  /** 书的均线阶梯：核心选股判据是「收盘价 > MA100」 */
  ma: MaSet;
  /** 最新收盘相对 MA100 的偏离（%）：正=在 MA100 上方 */
  priceVsMa100: number | null;
  /** 周线重采样后的 MA20。书 L500：周线 MA20 其实就相当于日线 MA100 */
  weeklyMa20: number | null;
  /** 周线样本根数（含当前尚未走完的一周） */
  weeklySampleSize: number;
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
 * ISO 8601 周键（周一为一周之始），如 `2026-W39`。
 *
 * 用 UTC 计算：本地时区会把 `2026-01-01`（周四）这类跨年日期挪到相邻周，
 * 从而把周线切错——这类错误在年度边界上只影响一周，但会让 MA20 悄悄偏一点。
 */
export function isoWeekKey(date: string): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(year, month - 1, day));
  const weekday = dt.getUTCDay() || 7; // 周日算第 7 天
  dt.setUTCDate(dt.getUTCDate() + 4 - weekday); // 移到本周的周四
  const isoYear = dt.getUTCFullYear();
  const yearStart = Date.UTC(isoYear, 0, 1);
  const week = Math.ceil(((dt.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

/**
 * 把日 K 重采样为周线。
 *
 * 输入必须按日期升序。**当前尚未走完的一周也会出现**——这是有意的：
 * 实时看盘时「本周到目前为止」就是该周的现状，剔除它会让周线滞后一周。
 */
export function resampleWeekly(klines: Kline[]): WeeklyBar[] {
  const out: WeeklyBar[] = [];
  let current: WeeklyBar | null = null;

  for (const k of klines) {
    const week = isoWeekKey(k.date);
    if (!current || current.week !== week) {
      current = {
        week,
        open: k.open,
        high: k.high,
        low: k.low,
        close: k.close,
        volume: k.volume,
      };
      out.push(current);
      continue;
    }
    current.high = Math.max(current.high, k.high);
    current.low = Math.min(current.low, k.low);
    current.close = k.close; // 最近一根的收盘即本周收盘
    current.volume += k.volume;
  }
  return out;
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

  // 书的均线阶梯。样本不足的那几条各自为 null，不影响其余字段。
  const maSet: MaSet = {
    ma5: round(last(SMA.calculate({ period: 5, values: closes }))),
    ma10: round(last(SMA.calculate({ period: 10, values: closes }))),
    ma20: round(last(SMA.calculate({ period: 20, values: closes }))),
    ma60: round(last(SMA.calculate({ period: 60, values: closes }))),
    ma100: round(last(SMA.calculate({ period: 100, values: closes }))),
    ma120: round(last(SMA.calculate({ period: 120, values: closes }))),
    ma144: round(last(SMA.calculate({ period: 144, values: closes }))),
  };

  const weekly = resampleWeekly(klines);
  const weeklyMa20 = round(
    last(
      SMA.calculate({
        period: 20,
        values: weekly.map((w) => w.close),
      }),
    ),
  );

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
    ma: maSet,
    priceVsMa100: maSet.ma100 ? round(((latestClose - maSet.ma100) / maSet.ma100) * 100) : null,
    weeklyMa20,
    weeklySampleSize: weekly.length,
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

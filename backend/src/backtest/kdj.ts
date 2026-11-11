import type { DailyBar } from "../screener/types.js";

/**
 * KDJ（随机指标）——手写，不用 `technicalindicators`：该库根本没有 KDJ，
 * 而它的 KD/Stochastic 用的是 EMA 口径，与 A 股软件（通达信/同花顺）算出来的数**不一样**。
 *
 * 口径（本项目的权威定义，报告会原样披露）：
 *   RSV = (C − LLV(L, n)) / (HHV(H, n) − LLV(L, n)) × 100
 *   K   = SMA(RSV, k, 1)   // 中国式 SMA：Y_t = (1×X_t + (k−1)×Y_{t−1}) / k
 *   D   = SMA(K, d, 1)
 *   J   = 3K − 2D
 * 默认 n=9、k=d=3。
 *
 * 价格用**后复权**（`不复权价 × adjFactor`）：跨除权日若用不复权价，
 * RSV 会因为价格跳空产生假信号，这是这类系统最隐蔽的错误来源。
 * RSV 是比例量，复权因子的绝对尺度不影响它，但不复权会破坏 9 日窗口内的相对关系。
 */

export type KdjOptions = {
  period?: number;
  kSmooth?: number;
  dSmooth?: number;
};

export type KdjSeries = {
  /** 与输入同长度；不可计算的早期位置为 null */
  k: Array<number | null>;
  d: Array<number | null>;
  j: Array<number | null>;
  rsv: Array<number | null>;
};

/**
 * 中国式 SMA（通达信 `SMA(X, N, M)`）：`Y_t = (M·X_t + (N−M)·Y_{t−1}) / N`。
 *
 * 与 EMA 的区别在**初始值**与权重定义：这里首个有效值直接取 `X`，
 * 之后权重恒为 `M/N`（所以 `M=1, N=3` 即「新值占 1/3」，俗称 2/3 平滑）。
 * 输入中为 null 的位置不参与递推、输出也为 null，但前值保留——
 * 日线序列里出现空洞时（不该有，但坏数据会有）不能让整条指标断掉。
 */
export function chineseSma(
  values: ReadonlyArray<number | null>,
  period: number,
  weight = 1,
): Array<number | null> {
  if (period <= 0) throw new Error(`SMA 周期必须为正：${period}`);
  if (weight <= 0 || weight > period) throw new Error(`SMA 权重非法：${weight}/${period}`);

  const out: Array<number | null> = new Array(values.length).fill(null);
  let prev: number | null = null;
  for (let i = 0; i < values.length; i++) {
    const x = values[i];
    if (x === null || x === undefined || !Number.isFinite(x)) continue;
    out[i] = prev === null ? x : (weight * x + (period - weight) * prev) / period;
    prev = out[i] as number;
  }
  return out;
}

/** 后复权收盘序列；与 `screener/structure.ts` 的 `adjustedCloses` 同口径。 */
export function adjustedOhlc(bars: readonly DailyBar[]): {
  highs: number[];
  lows: number[];
  closes: number[];
} {
  return {
    highs: bars.map((bar) => bar.high * bar.adjFactor),
    lows: bars.map((bar) => bar.low * bar.adjFactor),
    closes: bars.map((bar) => bar.close * bar.adjFactor),
  };
}

/** 计算 KDJ；返回与输入等长的序列，不可计算处为 null。 */
export function kdjSeries(bars: readonly DailyBar[], options: KdjOptions = {}): KdjSeries {
  const period = options.period ?? 9;
  const kSmooth = options.kSmooth ?? 3;
  const dSmooth = options.dSmooth ?? 3;
  if (period <= 0) throw new Error(`KDJ 周期必须为正：${period}`);

  const { highs, lows, closes } = adjustedOhlc(bars);
  const rsv: Array<number | null> = new Array(bars.length).fill(null);

  for (let i = period - 1; i < bars.length; i++) {
    let highest = -Infinity;
    let lowest = Infinity;
    for (let j = i - period + 1; j <= i; j++) {
      const high = highs[j] as number;
      const low = lows[j] as number;
      if (high > highest) highest = high;
      if (low < lowest) lowest = low;
    }
    const close = closes[i] as number;
    // 区间为零（连续一字板且完全不动）时 RSV 无定义；取 50 中性值而不是 NaN，
    // 否则后续整条 K/D 会被污染成 NaN。
    rsv[i] = highest === lowest ? 50 : ((close - lowest) / (highest - lowest)) * 100;
  }

  const k = chineseSma(rsv, kSmooth, 1);
  const d = chineseSma(k, dSmooth, 1);
  const j = new Array<number | null>(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const kv = k[i];
    const dv = d[i];
    if (kv === null || dv === null || kv === undefined || dv === undefined) continue;
    j[i] = 3 * kv - 2 * dv;
  }
  return { k, d, j, rsv };
}

export type CrossFlags = {
  /** K 上穿 D（金叉） */
  golden: boolean[];
  /** K 下穿 D（死叉） */
  death: boolean[];
};

/**
 * 金叉/死叉标记，与输入同长度对齐。
 *
 * 判定用「前一根 ≤ / ≥，当根 > / <」而不是「等于」，因为 K 与 D 可能在数值上
 * 长时间相等（一字板时 RSV 恒为 50），用等号会把整段相等误判成连续交叉。
 * 相等段结束后的第一次分离才算一次交叉——这与软件上看到的一根箭头一致。
 */
export function crossFlags(
  k: ReadonlyArray<number | null>,
  d: ReadonlyArray<number | null>,
): CrossFlags {
  const n = Math.min(k.length, d.length);
  const golden: boolean[] = new Array(n).fill(false);
  const death: boolean[] = new Array(n).fill(false);

  for (let i = 1; i < n; i++) {
    const kPrev = k[i - 1];
    const dPrev = d[i - 1];
    const kNow = k[i];
    const dNow = d[i];
    if (
      kPrev === null ||
      kPrev === undefined ||
      dPrev === null ||
      dPrev === undefined ||
      kNow === null ||
      kNow === undefined ||
      dNow === null ||
      dNow === undefined
    ) {
      continue;
    }
    if (kPrev <= dPrev && kNow > dNow) golden[i] = true;
    if (kPrev >= dPrev && kNow < dNow) death[i] = true;
  }
  return { golden, death };
}

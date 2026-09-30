import type { DailyBar, SecurityInput } from "../../src/screener/types.js";

/**
 * 筛选器测试用的日线与标的构造器。
 *
 * 日期用递增整数即可——筛选引擎不解析日期（那是数据层与指标层的事），
 * 这样用例读起来只剩价格本身，不被日期噪音干扰。
 */

let dateCursor = 20250101;

export function resetDates(): void {
  dateCursor = 20250101;
}

export function bar(
  close: number,
  over: Partial<Omit<DailyBar, "date" | "close">> = {},
): DailyBar {
  return {
    date: dateCursor++,
    open: over.open ?? close,
    high: over.high ?? close * 1.01,
    low: over.low ?? close * 0.99,
    close,
    volume: over.volume ?? 10_000,
    amount: over.amount ?? 2e8,
    adjFactor: over.adjFactor ?? 1,
  };
}

/** 由收盘价序列造日线；每根的振幅固定 ±1%。 */
export function bars(closes: number[], over: Partial<DailyBar> = {}): DailyBar[] {
  return closes.map((close) => bar(close, over));
}

/** 线性上涨序列：`start` 起、每根涨 `step`。 */
export function rising(n: number, start = 10, step = 0.05): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step);
}

/** 线性下跌序列。 */
export function falling(n: number, start = 20, step = 0.05): number[] {
  return Array.from({ length: n }, (_, i) => start - i * step);
}

/** 极窄幅来回震荡：带宽很小且净位移接近 0。 */
export function sideways(n: number, base = 10, amplitude = 0.05): number[] {
  return Array.from({ length: n }, (_, i) => base + amplitude * Math.sin(i / 3));
}

/**
 * 一只默认"处处通过"的标的：300 根稳步上涨（10 → 约 25）。
 * 各档下限都能满足（严格档要求 250 根，最大市值 50 亿）。
 */
export function goodSecurity(over: Partial<SecurityInput> = {}): SecurityInput {
  return {
    code: "600519",
    name: "测试股",
    board: "main",
    isLive: true,
    floatMarketCap: 40e8,
    bars: bars(rising(300)),
    ...over,
  };
}

/** 改写最后一根日 K，用于制造"只在最后一天出问题"的场景（不改动原对象）。 */
export function withLastBar(security: SecurityInput, patch: Partial<DailyBar>): SecurityInput {
  const copy = security.bars.map((b) => ({ ...b }));
  Object.assign(copy[copy.length - 1] as DailyBar, patch);
  return { ...security, bars: copy };
}

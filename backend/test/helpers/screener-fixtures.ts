import type { DailyBar, SecurityInput } from "../../src/screener/types.js";

/**
 * 筛选器测试用的日线与标的构造器。
 *
 * 日期是**真实的交易日**（跳过周末），而不是递增整数：筛选引擎自己不解析日期，
 * 但接口层会把库内最新交易日渲染成 `YYYY-MM-DD` 返回给界面——
 * 用假日期会让那一层测不出来（例如把 2025-03-00 当成合法日期）。
 */

let cursor = new Date(Date.UTC(2024, 0, 1));

export function resetDates(): void {
  cursor = new Date(Date.UTC(2024, 0, 1));
}

/** 下一个交易日（跳过周六周日）。 */
function nextTradingDate(): number {
  do {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  } while (cursor.getUTCDay() === 0 || cursor.getUTCDay() === 6);
  return (
    cursor.getUTCFullYear() * 10000 + (cursor.getUTCMonth() + 1) * 100 + cursor.getUTCDate()
  );
}

export function bar(
  close: number,
  over: Partial<Omit<DailyBar, "date" | "close">> = {},
): DailyBar {
  return {
    date: nextTradingDate(),
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
 * 一只默认"处处通过"的标的：300 根稳步上涨（10 → 约 25），**末根放量突破前高**。
 *
 * 末根那一跳是必要的：接上信号层之后，"只是站上 MA100"已经不算买点，
 * 而单调上涨的走势既没有均线穿越、也没有显著高低点，会因为**没有信号**而被筛掉。
 * 这一跳让它命中 S13（阻力突破），从而是一只真正会被筛出来的标的。
 * 幅度取 +3%：既足以越过前 60 根的最高价，又不至于触发涨停判定，
 * 且止损空间（约 3.5%）在三档上限（10%/8%/5%）之内。
 *
 * 需要"没有信号"的用例请显式构造走势，不要依赖这个夹具。
 */
export function goodSecurity(over: Partial<SecurityInput> = {}): SecurityInput {
  const closes = rising(300);
  // 末三根先挖一个小坑，再放量突破：这样它同时给出
  // S1（MA20 上穿，档 4）与 S13（阻力突破，档 5），最强档为 4。
  // 只给 S13 的话，标准档（排除最弱档）会把这个夹具整个挡掉——
  // 夹具必须带一个"本档愿意做"的信号，否则测的就不是引擎而是参数表。
  const n = closes.length;
  closes[n - 3] = (closes[n - 4] as number) * 0.985;
  closes[n - 2] = (closes[n - 4] as number) * 0.975;
  // 末根既要上穿 MA20（S1，档 4），也要越过坑前的高点（S13，档 5）
  closes[n - 1] = (closes[n - 4] as number) * 1.04;
  return {
    code: "600519",
    name: "测试股",
    board: "main",
    isLive: true,
    floatMarketCap: 40e8,
    tradedOnLatestDay: true,
    bars: bars(closes),
    ...over,
  };
}

/** 改写最后一根日 K，用于制造"只在最后一天出问题"的场景（不改动原对象）。 */
export function withLastBar(security: SecurityInput, patch: Partial<DailyBar>): SecurityInput {
  const copy = security.bars.map((b) => ({ ...b }));
  Object.assign(copy[copy.length - 1] as DailyBar, patch);
  return { ...security, bars: copy };
}

import type { DailyBar } from "../../src/screener/types.js";

/** 生成连续交易日（跳过周六周日；不按真实节假日，测试不需要）。 */
export function tradingDates(count: number, start = 20210104): number[] {
  const dates: number[] = [];
  let year = Math.floor(start / 10000);
  let month = Math.floor((start % 10000) / 100);
  let day = start % 100;
  const date = new Date(Date.UTC(year, month - 1, day));
  while (dates.length < count) {
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) {
      const key =
        date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate();
      dates.push(key);
    }
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return dates;
}

export function bar(date: number, close: number, overrides: Partial<DailyBar> = {}): DailyBar {
  return {
    date,
    open: close,
    high: close * 1.01,
    low: close * 0.99,
    close,
    volume: 100_000,
    amount: close * 100_000,
    adjFactor: 1,
    ...overrides,
  };
}

/**
 * 由收盘价序列构造日线：开盘 = 前收盘（首根 = 收盘），保证价格连续，
 * 这样 KDJ 只由收盘序列的形状决定，测试里好推理。
 */
export function barsFromCloses(closes: readonly number[], start = 20210104): DailyBar[] {
  const dates = tradingDates(closes.length, start);
  return closes.map((close, i) => {
    const prev = i === 0 ? close : (closes[i - 1] as number);
    const open = prev;
    return bar(dates[i] as number, close, {
      open,
      high: Math.max(open, close) * 1.005,
      low: Math.min(open, close) * 0.995,
      amount: close * 1_000_000,
    });
  });
}

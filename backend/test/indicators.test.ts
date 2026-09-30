import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { InsufficientDataError, MIN_SAMPLES, computeIndicators, isoWeekKey, resampleWeekly } from "../src/indicators.js";
import { normalizeKline } from "../src/eastmoney.js";
import { normalizeTencentKline } from "../src/tencent.js";
import type { Kline } from "../src/domain.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const eastmoney: Kline[] = normalizeKline(
  JSON.parse(readFileSync(join(fixtures, "kline-600519.raw.json"), "utf8")),
);
const tencent: Kline[] = normalizeTencentKline(
  JSON.parse(readFileSync(join(fixtures, "kline-600519.tencent.json"), "utf8")),
);

/** 独立实现：简单移动平均（用于验证库输出，而非照抄）。 */
function manualSma(closes: number[], period: number): number {
  const window = closes.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

/** 独立实现：区间涨跌幅（%）。 */
function manualReturn(closes: number[], n: number): number {
  const now = closes[closes.length - 1]!;
  const then = closes[closes.length - 1 - n]!;
  return ((now - then) / then) * 100;
}

/** 独立实现：年化波动率（%）。 */
function manualVolatility(closes: number[], n: number): number {
  const w = closes.slice(-(n + 1));
  const rets: number[] = [];
  for (let i = 1; i < w.length; i++) rets.push(Math.log(w[i]! / w[i - 1]!));
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(variance) * Math.sqrt(252) * 100;
}

describe("computeIndicators 与独立手算一致", () => {
  const closes = eastmoney.map((k) => k.close);
  const ind = computeIndicators(eastmoney);

  it("SMA50 / SMA200 等于独立计算的简单移动平均", () => {
    expect(ind.sma50).toBeCloseTo(manualSma(closes, 50), 1);
    expect(ind.sma200).toBeCloseTo(manualSma(closes, 200), 1);
  });

  it("价格相对均线偏离等于独立计算", () => {
    const latest = closes[closes.length - 1]!;
    expect(ind.priceVsSma50).toBeCloseTo(
      ((latest - manualSma(closes, 50)) / manualSma(closes, 50)) * 100,
      1,
    );
  });

  it("区间涨跌幅等于独立计算", () => {
    expect(ind.return20d).toBeCloseTo(manualReturn(closes, 20), 1);
    expect(ind.return60d).toBeCloseTo(manualReturn(closes, 60), 1);
  });

  it("年化波动率等于独立计算", () => {
    expect(ind.volatility20d).toBeCloseTo(manualVolatility(closes, 20), 1);
  });

  it("区间最高/最低与位置取自样本", () => {
    const highs = eastmoney.map((k) => k.high);
    const lows = eastmoney.map((k) => k.low);
    expect(ind.periodHigh).toBeCloseTo(Math.max(...highs), 2);
    expect(ind.periodLow).toBeCloseTo(Math.min(...lows), 2);
    expect(ind.positionInRange).toBeGreaterThanOrEqual(0);
    expect(ind.positionInRange).toBeLessThanOrEqual(100);
  });
});

describe("computeIndicators 的边界与契约", () => {
  it("RSI 恒落在 0–100（库异常时被裁剪）", () => {
    const ind = computeIndicators(eastmoney);
    expect(ind.rsi14).toBeGreaterThanOrEqual(0);
    expect(ind.rsi14).toBeLessThanOrEqual(100);
  });

  it("样本不足 200 根时 SMA200 为 null，其余指标照常计算", () => {
    const ind = computeIndicators(tencent); // 60 根
    expect(ind.sampleSize).toBe(60);
    expect(ind.sma200).toBeNull();
    expect(ind.priceVsSma200).toBeNull();
    expect(ind.sma50).not.toBeNull();
    expect(ind.rsi14).not.toBeNull();
  });

  it("样本少于 MIN_SAMPLES 时抛 InsufficientDataError（abstain 契约的来源）", () => {
    const few = eastmoney.slice(-(MIN_SAMPLES - 1));
    expect(() => computeIndicators(few)).toThrow(InsufficientDataError);
    expect(() => computeIndicators([])).toThrow(InsufficientDataError);
  });

  it("恰好 MIN_SAMPLES 根可用（边界包含）", () => {
    const exact = eastmoney.slice(-MIN_SAMPLES);
    const ind = computeIndicators(exact);
    expect(ind.sampleSize).toBe(MIN_SAMPLES);
    // 60 根可支撑：SMA50(50 点)、MACD(35 点)、RSI(15 点)、20 日指标(21 点)
    expect(ind.sma50).not.toBeNull();
    expect(ind.macd.dif).not.toBeNull();
    expect(ind.rsi14).not.toBeNull();
    expect(ind.return20d).not.toBeNull();
    expect(ind.volatility20d).not.toBeNull();
    // 60 日涨跌幅需要 61 个点，故为 null；SMA200 需 200 点，同样为 null
    expect(ind.return60d).toBeNull();
    expect(ind.sma200).toBeNull();
  });

  it("样本区间日期与输入首尾一致（便于点时间对齐）", () => {
    const ind = computeIndicators(eastmoney);
    expect(ind.fromDate).toBe(eastmoney[0]!.date);
    expect(ind.toDate).toBe(eastmoney[eastmoney.length - 1]!.date);
  });

  it("MACD 与 ATR 为具体数值（回归保护，防库升级静默改变算法）", () => {
    const ind = computeIndicators(eastmoney);
    expect(ind.macd.dif).toBeCloseTo(-9.98, 1);
    expect(ind.macd.dea).toBeCloseTo(-4.78, 1);
    expect(ind.macd.hist).toBeCloseTo(-5.19, 1);
    expect(ind.atr14).toBeCloseTo(20.05, 1);
    expect(ind.atrPercent).toBeCloseTo(1.6, 1);
  });

  it("两源在同一尾段窗口上 SMA50 一致（交叉验证适配器与指标层）", () => {
    const a = computeIndicators(eastmoney);
    const b = computeIndicators(tencent);
    expect(a.sma50).toBeCloseTo(b.sma50!, 1);
    expect(a.return20d).toBeCloseTo(b.return20d!, 1);
  });
});

/** 造一根日 K，只填断言需要的字段。 */
function k(date: string, open: number, high: number, low: number, close: number, volume: number): Kline {
  return {
    date,
    open,
    high,
    low,
    close,
    volume,
    amount: null,
    amplitude: null,
    changePercent: null,
    changeAmount: null,
    turnoverRate: null,
  };
}

describe("均线阶梯（书的判据）", () => {
  const closes = eastmoney.map((x) => x.close);
  const ind = computeIndicators(eastmoney);

  it("MA5/10/20/60/100/120/144 都等于独立手算的简单移动平均", () => {
    for (const period of [5, 10, 20, 60, 100, 120, 144] as const) {
      const key = `ma${period}` as const;
      expect(ind.ma[key], `ma${period}`).toBeCloseTo(manualSma(closes, period), 1);
    }
  });

  it("收盘价相对 MA100 的偏离与独立计算一致（书的核心判据「收盘价 > MA100」）", () => {
    const latest = closes[closes.length - 1]!;
    const ma100 = manualSma(closes, 100);
    expect(ind.priceVsMa100).toBeCloseTo(((latest - ma100) / ma100) * 100, 1);
    expect(ind.ma.ma100).toBeCloseTo(ma100, 1);
  });

  it("样本不足的那条均线单独为 null，不影响其余字段", () => {
    const short = computeIndicators(tencent); // 60 根
    expect(short.ma.ma5).not.toBeNull();
    expect(short.ma.ma60).not.toBeNull();
    expect(short.ma.ma100).toBeNull();
    expect(short.ma.ma120).toBeNull();
    expect(short.ma.ma144).toBeNull();
    expect(short.priceVsMa100).toBeNull();
    // 其余指标照常
    expect(short.sma50).not.toBeNull();
    expect(short.rsi14).not.toBeNull();
  });
});

describe("isoWeekKey", () => {
  it("同一 ISO 周内的交易日共用一个键（周一为周首）", () => {
    // 2026-09-28 是周一，故 09-28 至 10-04（含周日）同属一周
    const week = isoWeekKey("2026-09-28");
    for (const day of ["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-04"]) {
      expect(isoWeekKey(day), day).toBe(week);
    }
    expect(isoWeekKey("2026-10-05")).not.toBe(week); // 下一个周一进入新的一周
  });

  it("跨年时按 ISO 周规则归属到正确的那一年", () => {
    // 2025-12-29（周一）至 2026-01-04 属 2026 年第 1 周
    expect(isoWeekKey("2025-12-29")).toBe("2026-W01");
    expect(isoWeekKey("2026-01-02")).toBe("2026-W01");
    expect(isoWeekKey("2026-01-05")).toBe("2026-W02");
  });

  it("格式固定为 YYYY-Www", () => {
    expect(isoWeekKey("2026-09-30")).toMatch(/^\d{4}-W\d{2}$/);
  });
});

describe("resampleWeekly", () => {
  const daily = [
    k("2026-09-28", 10, 13, 9, 12, 100),
    k("2026-09-29", 12, 15, 11, 14, 200),
    k("2026-09-30", 14, 16, 8, 9, 300),
    k("2026-10-05", 20, 22, 19, 21, 400),
    k("2026-10-06", 21, 25, 20, 24, 500),
  ];

  it("按 ISO 周聚合：开=首日开、收=末日收、高/低取极值、量为求和", () => {
    const weeks = resampleWeekly(daily);
    expect(weeks).toHaveLength(2);
    expect(weeks[0]).toEqual({
      week: "2026-W40",
      open: 10,
      high: 16,
      low: 8,
      close: 9,
      volume: 600,
    });
    expect(weeks[1]).toMatchObject({ week: "2026-W41", open: 20, high: 25, low: 19, close: 24, volume: 900 });
  });

  it("当前尚未走完的一周也会出现（否则周线会滞后一周）", () => {
    // 最后一根落在 2026-10-06，其所在周显然还没走完
    expect(resampleWeekly(daily).at(-1)?.week).toBe("2026-W41");
  });

  it("空输入返回空数组", () => {
    expect(resampleWeekly([])).toEqual([]);
  });

  it("周线 MA20 需要 20 周：60 根日线约 12 周，故为 null；250 根足够", () => {
    const short = computeIndicators(tencent); // 60 根日线
    expect(short.weeklyMa20).toBeNull();
    expect(short.weeklySampleSize).toBeLessThan(20);

    const long = computeIndicators(eastmoney); // 250 根日线
    expect(long.weeklySampleSize).toBeGreaterThanOrEqual(20);
    expect(long.weeklyMa20).not.toBeNull();
  });

  it("周线 MA20 等于对重采样周收盘序列手算的 20 周均线", () => {
    const weeklyCloses = resampleWeekly(eastmoney).map((w) => w.close);
    expect(computeIndicators(eastmoney).weeklyMa20).toBeCloseTo(manualSma(weeklyCloses, 20), 1);
  });
});

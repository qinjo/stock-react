import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  consistencyToMaxConfidence,
  deriveValuation,
  tallySignals,
} from "../src/derived.js";
import { normalizeQuote, normalizeKline } from "../src/eastmoney.js";
import { computeIndicators } from "../src/indicators.js";
import type { Quote } from "../src/domain.js";
import type { Indicators } from "../src/indicators.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const quote: Quote = normalizeQuote(load("quote-600519.raw.json"));
const indicators: Indicators = computeIndicators(normalizeKline(load("kline-600519.raw.json")));

describe("deriveValuation（用 PE/PB 反推基本面量）", () => {
  const v = deriveValuation(quote);

  it("隐含 ROE = PB / PE，与真实 ROE 同量级（茅台约 35%）", () => {
    // fixture: PB=6.25, PE=17.65 → 35.41%
    expect(v.impliedRoe).toBeCloseTo(35.41, 1);
  });

  it("隐含 EPS = 价 / PE（元）", () => {
    // 1257.12 / 17.65 = 71.23
    expect(v.impliedEps).toBeCloseTo(71.23, 1);
  });

  it("隐含每股净资产 = 价 / PB（元）", () => {
    // 1257.12 / 6.25 = 201.14
    expect(v.impliedBvps).toBeCloseTo(201.14, 1);
  });

  it("隐含净利润与净资产由市值推导（量级为百亿/千亿）", () => {
    expect(v.impliedNetProfit).toBeGreaterThan(5e10); // 数百亿
    expect(v.impliedNetProfit).toBeLessThan(2e11);
    expect(v.impliedEquity).toBeGreaterThan(2e11); // 数千亿
    expect(v.impliedEquity).toBeLessThan(4e11);
  });

  it("PE/PB 缺失或非正（亏损股）时返回 null，不编造数字", () => {
    const loss: Quote = { ...quote, pe: -12.5, pb: null };
    const r = deriveValuation(loss);
    expect(r.impliedRoe).toBeNull();
    expect(r.impliedEps).toBeNull();
    expect(r.impliedBvps).toBeNull();
    expect(r.impliedNetProfit).toBeNull();
    expect(r.impliedEquity).toBeNull();
  });

  it("PE 为 0 时不做除零", () => {
    expect(deriveValuation({ ...quote, pe: 0 }).impliedEps).toBeNull();
  });
});

describe("tallySignals（指标一致性 → 置信度上限）", () => {
  it("统计多空项数与一致性比例", () => {
    const t = tallySignals(indicators, quote);
    expect(t.total).toBeGreaterThanOrEqual(10);
    expect(t.bullish + t.bearish + t.neutral).toBe(t.total);
    expect(t.consistency).toBeGreaterThanOrEqual(0.5);
    expect(t.consistency).toBeLessThanOrEqual(1);
  });

  it("每项都带可核查的明细（模型能看到判断依据）", () => {
    const t = tallySignals(indicators, quote);
    for (const item of t.items) {
      expect(item.name).toBeTruthy();
      expect(item.detail).toBeTruthy();
      expect(["bullish", "bearish", "neutral"]).toContain(item.direction);
    }
  });

  it("全面多头时一致性高、上限高", () => {
    const bullInd: Indicators = {
      ...indicators,
      sma50: 100,
      sma200: 90,
      macd: { dif: 5, dea: 3, hist: 2 },
      rsi14: 62,
      return20d: 8,
      return60d: 12,
      positionInRange: 80,
      volatility20d: 20,
    };
    const t = tallySignals(bullInd, { ...quote, price: 120, pb: 3 });
    expect(t.bullish).toBeGreaterThan(t.bearish);
    expect(t.consistency).toBeGreaterThan(0.8);
    expect(t.maxConfidence).toBeGreaterThanOrEqual(80);
  });

  it("多空接近均势时一致性低、置信度上限被压低（治「永远 60-70 分」）", () => {
    // 逐项：短期在均线上(多) / 长期在均线下(空) / 均线空排(空) /
    // MACD 空头(空×2) / RSI 30 偏空(空) / 20日涨(多) / 60日跌(空) /
    // 区间中上(多) / 动能加速(多) → 约 4:5，属真分歧
    const mixed: Indicators = {
      ...indicators,
      sma50: 1300,
      sma200: 1400,
      macd: { dif: -5, dea: -2, hist: -3 },
      rsi14: 30,
      return20d: 5,
      return60d: -3,
      positionInRange: 60,
      volatility20d: 20,
    };
    const t = tallySignals(mixed, { ...quote, price: 1350, pb: 3 });
    expect(t.bullish).toBeGreaterThan(0);
    expect(t.bearish).toBeGreaterThan(0);
    expect(t.consistency).toBeLessThanOrEqual(0.65);
    expect(t.maxConfidence).toBeLessThanOrEqual(65);
  });

  it("指标缺失的项不进入统计（不把 null 当空头）", () => {
    const sparse: Indicators = {
      ...indicators,
      sma50: null,
      sma200: null,
      macd: { dif: null, dea: null, hist: null },
      rsi14: null,
      return20d: null,
      return60d: null,
      positionInRange: null,
      volatility20d: null,
    };
    const t = tallySignals(sparse, { ...quote, pe: null, pb: null });
    expect(t.total).toBeLessThan(tallySignals(indicators, quote).total);
    expect(t.bullish + t.bearish + t.neutral).toBe(t.total);
  });
});

describe("consistencyToMaxConfidence 映射", () => {
  it("按分档给出上限，且单调不减", () => {
    expect(consistencyToMaxConfidence(1.0)).toBe(90);
    expect(consistencyToMaxConfidence(0.9)).toBe(90);
    expect(consistencyToMaxConfidence(0.8)).toBe(80);
    expect(consistencyToMaxConfidence(0.65)).toBe(65);
    expect(consistencyToMaxConfidence(0.5)).toBe(50);
    expect(consistencyToMaxConfidence(0.3)).toBe(45);
  });

  it("完全分歧（0.5）不给高分", () => {
    expect(consistencyToMaxConfidence(0.5)).toBeLessThanOrEqual(50);
  });
});

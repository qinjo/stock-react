import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { RULES, buildContext } from "../src/screener/rules.js";
import type { ScreenerCriteria, Strictness } from "../src/screener/types.js";
import { goodSecurity, withLastBar } from "./helpers/screener-fixtures.js";

/**
 * 阈值边界测试：钉住每条规则的**比较方向与开闭性**。
 *
 * 参数表写"流通市值区间 20.00亿–150.00亿"、"成交额下限"、"带宽上限"，
 * 但"含不含等号"是文字说不清、代码一改就静默变的东西。
 * 这一组用例把每个边界两侧各测一次——阈值本身改了应当让测试失败，
 * 而不是让筛选结果悄悄变宽或变窄。
 *
 * 直接调规则本身（不走整条链路）：穿过整条引擎去测一个算术边界，
 * 会因为夹具的其它门槛而看不出到底是谁挡的。
 */

const CRITERIA: Record<Strictness, ScreenerCriteria> = {
  loose: { ...DEFAULT_CRITERIA, strictness: "loose" },
  standard: { ...DEFAULT_CRITERIA, strictness: "standard" },
  strict: { ...DEFAULT_CRITERIA, strictness: "strict" },
};

function rule(id: string) {
  const found = RULES.find((r) => r.id === id);
  expect(found, `未找到规则 ${id}`).toBeDefined();
  return found as (typeof RULES)[number];
}

function outcomeOf(
  id: string,
  security: Parameters<typeof buildContext>[0],
  strictness: Strictness = "standard",
) {
  return rule(id).evaluate(buildContext(security, paramsFor(strictness), CRITERIA[strictness]));
}

describe("H-bars 日 K 根数下限：≥ 为界（含等号）", () => {
  const withBars = (n: number) => {
    const base = goodSecurity();
    const bars = base.bars.slice(-n);
    return { ...base, bars };
  };

  it("恰好 150 根通过（标准档下限就是 150）", () => {
    expect(paramsFor("standard").minListedBars).toBe(150);
    expect(outcomeOf("H-bars", withBars(150)).ok).toBe(true);
  });

  it("149 根被拦下", () => {
    const outcome = outcomeOf("H-bars", withBars(149));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("149 根 < 150");
  });

  it("严格档下限 250：249 拦下、250 通过", () => {
    expect(paramsFor("strict").minListedBars).toBe(250);
    expect(outcomeOf("H-bars", withBars(249), "strict").ok).toBe(false);
    expect(outcomeOf("H-bars", withBars(250), "strict").ok).toBe(true);
  });
});

describe("U-marketCap 流通市值区间：两端都含等号", () => {
  const withCap = (cap: number | null) => goodSecurity({ floatMarketCap: cap });

  it("标准档 20 亿–150 亿：下沿、上沿都通过（上限 2026-09-30 由 80 亿放宽，见 #29）", () => {
    expect(paramsFor("standard").floatMarketCapMin).toBe(20e8);
    expect(paramsFor("standard").floatMarketCapMax).toBe(150e8);
    expect(outcomeOf("U-marketCap", withCap(20e8)).ok).toBe(true);
    expect(outcomeOf("U-marketCap", withCap(150e8)).ok).toBe(true);
  });

  it("越界一侧各测一次", () => {
    expect(outcomeOf("U-marketCap", withCap(20e8 - 1)).ok).toBe(false);
    expect(outcomeOf("U-marketCap", withCap(150e8 + 1)).ok).toBe(false);
  });

  it("宽松与标准现在同在上限 150 亿，严格仍收在 50 亿", () => {
    // 注意：放宽后宽松与标准在该项上相同——三档差异由其它参数维持。
    // 100 亿这只：宽松/标准放行、严格拦下
    expect(paramsFor("loose").floatMarketCapMax).toBe(150e8);
    expect(paramsFor("standard").floatMarketCapMax).toBe(150e8);
    expect(paramsFor("strict").floatMarketCapMax).toBe(50e8);
    expect(outcomeOf("U-marketCap", withCap(100e8), "loose").ok).toBe(true);
    expect(outcomeOf("U-marketCap", withCap(100e8), "standard").ok).toBe(true);
    expect(outcomeOf("U-marketCap", withCap(100e8), "strict").ok).toBe(false);
  });

  it("市值缺失时标为未判定（而不是当作不合格）", () => {
    const outcome = outcomeOf("U-marketCap", withCap(null));
    expect(outcome.unknown).toBe(true);
    expect(outcome.detail).toContain("未生效");
  });
});

describe("U-turnover 成交额下限：≥ 为界（含等号）", () => {
  const withAmount = (amount: number) =>
    withLastBar(goodSecurity(), { amount } as never);

  it("标准档恰好 5000 万通过、差一元被拦下", () => {
    expect(paramsFor("standard").minTurnoverAmount).toBe(5_000e4);
    expect(outcomeOf("U-turnover", withAmount(5_000e4)).ok).toBe(true);
    expect(outcomeOf("U-turnover", withAmount(5_000e4 - 1)).ok).toBe(false);
  });

  it("三档下限依次抬高（3000 万 / 5000 万 / 1 亿）", () => {
    // 6000 万：宽松与标准放行、严格拦下
    expect(outcomeOf("U-turnover", withAmount(6_000e4), "loose").ok).toBe(true);
    expect(outcomeOf("U-turnover", withAmount(6_000e4), "standard").ok).toBe(true);
    expect(outcomeOf("U-turnover", withAmount(6_000e4), "strict").ok).toBe(false);
  });
});

describe("所有带数值阈值的规则都在边界两侧有断言", () => {
  it("参数表里每个数值参数的取值为三档之一，且严格档最紧", () => {
    const loose = paramsFor("loose");
    const standard = paramsFor("standard");
    const strict = paramsFor("strict");

    // 方向性：严格档必须更严（下限更高、上限更低、窗口更短）
    expect(strict.minListedBars).toBeGreaterThanOrEqual(standard.minListedBars);
    expect(strict.minTurnoverAmount).toBeGreaterThan(standard.minTurnoverAmount);
    expect(strict.floatMarketCapMax).toBeLessThanOrEqual(standard.floatMarketCapMax);
    expect(strict.rangeWidthMax).toBeLessThanOrEqual(standard.rangeWidthMax);
    expect(strict.ma100CrossMax).toBeLessThanOrEqual(standard.ma100CrossMax);
    expect(strict.stopSpaceMax).toBeLessThan(standard.stopSpaceMax);

    // 宽松档必须更松
    expect(loose.minTurnoverAmount).toBeLessThan(standard.minTurnoverAmount);
    expect(loose.stopSpaceMax).toBeGreaterThan(standard.stopSpaceMax);
    // 市值上限：**放宽后宽松与标准相同**（2026-09-30 用户拍板，#29）。
    // 这条如实反映"该项不再是三档差异的落点"，而不是把断言改松了事——
    // 三档的差异仍由成交额、上市根数、允许档位等参数维持。
    expect(loose.floatMarketCapMax).toBe(standard.floatMarketCapMax);
    expect(standard.floatMarketCapMax).toBeGreaterThan(strict.floatMarketCapMax);

    // 单值项在三档间不应漂移（它们不是三档差异的落点）
    expect(loose.swingWindow).toBe(strict.swingWindow);
    expect(loose.trendlineLookback).toBe(strict.trendlineLookback);
    expect(loose.rangeWindow).toBe(strict.rangeWindow);
    expect(loose.gapInvalidDays).toBe(strict.gapInvalidDays);
    expect(loose.pullbackWindow).toBe(strict.pullbackWindow);
  });
});

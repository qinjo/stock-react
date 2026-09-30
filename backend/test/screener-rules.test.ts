import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { RULES, buildContext, evaluateRules } from "../src/screener/rules.js";
import type { ScreenerCriteria, SecurityInput } from "../src/screener/types.js";
import { bars, goodSecurity, rising, withLastBar } from "./helpers/screener-fixtures.js";

/**
 * 逐条规则的正反例。
 *
 * 刻意**不走** `screenUniverse` 来测单条规则：规则按层短路，一旦前面的规则先淘汰，
 * 后面的规则就永远跑不到，用它测单条规则会得到"因为别的原因失败"的假绿灯。
 * 这里直接对规则求值，每条规则都有独立的通过 / 淘汰两面。
 */

const rule = (id: string) => {
  const found = RULES.find((r) => r.id === id);
  if (!found) throw new Error(`没有这条规则：${id}`);
  return found;
};

function run(id: string, security: SecurityInput, criteria: ScreenerCriteria = DEFAULT_CRITERIA) {
  return rule(id).evaluate(buildContext(security, paramsFor(criteria.strictness), criteria));
}

describe("硬性排除层", () => {
  it("E-live：数据截止日早于最新交易日即淘汰", () => {
    expect(run("E-live", goodSecurity()).ok).toBe(true);
    const dead = run("E-live", goodSecurity({ isLive: false }));
    expect(dead.ok).toBe(false);
    expect(dead.detail).toContain("已不在交易");
  });

  it("E-st：ST / *ST / 退市整理都被剔除", () => {
    expect(run("E-st", goodSecurity({ name: "贵州茅台" })).ok).toBe(true);
    for (const name of ["ST舍得", "*ST海航", "海航退"]) {
      const outcome = run("E-st", goodSecurity({ name }));
      expect(outcome.ok, name).toBe(false);
    }
  });

  it("E-st：名称为空时不淘汰，但显式标为未判定（沉默通过会让筛选器悄悄失效）", () => {
    const outcome = run("E-st", goodSecurity({ name: null }));
    expect(outcome.ok).toBe(true);
    expect(outcome.unknown).toBe(true);
  });

  it("E-suspended：最新交易日无成交量即淘汰", () => {
    expect(run("E-suspended", goodSecurity()).ok).toBe(true);
    expect(run("E-suspended", withLastBar(goodSecurity(), { volume: 0 })).ok).toBe(false);
  });

  it("E-suspended-today：最后一根不在全市场最新交易日即淘汰", () => {
    expect(run("E-suspended-today", goodSecurity()).ok).toBe(true);

    // 增量会把当天 bar 补进全市场，但停牌股补不上——只看"最后一根有没有成交量"拦不住它
    const stale = goodSecurity({ tradedOnLatestDay: false });
    const outcome = run("E-suspended-today", stale);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("最新交易日无日线");
  });

  it("E-oneword：一字板买不到，淘汰", () => {
    expect(run("E-oneword", goodSecurity()).ok).toBe(true);
    const oneWord = withLastBar(goodSecurity(), { high: 20, low: 20 });
    const outcome = run("E-oneword", oneWord);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("买不到");
  });

  it("E-board：北交所默认排除，开关打开后放行", () => {
    expect(run("E-board", goodSecurity({ board: "bj" })).ok).toBe(false);
    expect(
      run("E-board", goodSecurity({ board: "bj" }), { ...DEFAULT_CRITERIA, includeBeijing: true }).ok,
    ).toBe(true);
  });
});

describe("数据充分性与不追高", () => {
  it("H-bars：根数按严格度取档（严格档要 250 根）", () => {
    const short = goodSecurity({ bars: bars(rising(200)) });
    expect(run("H-bars", short).ok).toBe(true); // 标准档 150
    expect(run("H-bars", short, { ...DEFAULT_CRITERIA, strictness: "strict" }).ok).toBe(false);
    expect(run("H-bars", goodSecurity({ bars: bars(rising(149)) })).ok).toBe(false);
  });

  it("H-noChaseLimitUp：收盘已到涨停价即淘汰（书 X9：禁止打板）", () => {
    const atLimit = goodSecurity({ bars: bars([10, 11]) }); // 10 × 1.1 = 11
    const outcome = run("H-noChaseLimitUp", atLimit);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("涨停价");

    expect(run("H-noChaseLimitUp", goodSecurity({ bars: bars([10, 10.5]) })).ok).toBe(true);
    expect(run("H-noChaseLimitUp", goodSecurity({ bars: bars([10]) })).ok).toBe(true);
    expect(run("H-noChaseLimitUp", goodSecurity({ bars: bars([10]) })).unknown).toBe(true);
  });

  it("H-noLimitUpYesterday：涨停后第 2–3 日淘汰（书 X8）", () => {
    // 倒数第三根（距今 2 个交易日）涨停：10 → 11
    const twoDaysAgo = goodSecurity({ bars: bars([10, 11, 11.5, 12]) });
    const outcome = run("H-noLimitUpYesterday", twoDaysAgo);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("追高");

    // 距今 3 个交易日涨停：10 → 11（倒数第四根）
    expect(run("H-noLimitUpYesterday", goodSecurity({ bars: bars([10, 11, 11.5, 12, 12.5]) })).ok).toBe(false);
    // 没有涨停则放行
    expect(run("H-noLimitUpYesterday", goodSecurity({ bars: bars([10, 10.2, 10.4, 10.6]) })).ok).toBe(true);
  });
});

describe("基础池", () => {
  it("U-ma100：后复权收盘必须站上 MA100（书 L597 的核心条件）", () => {
    const below = run("U-ma100", goodSecurity({ bars: bars(Array.from({ length: 300 }, (_, i) => 30 - i * 0.05)) }));
    expect(below.ok).toBe(false);
    expect(below.detail).toContain("MA100");

    const above = run("U-ma100", goodSecurity());
    expect(above.ok).toBe(true);
    expect(above.detail).toContain("偏离");
  });

  it("U-ma100：均线在除权处不断裂（在 factor 缩放后的序列上比较）", () => {
    // 除权让不复权价直接"跳水"，后复权序列则保持连续
    const before = bars(rising(200, 10, 0.05));
    const after = bars(rising(100, 10, 0.05), { adjFactor: 2 }); // 因子在除权后翻倍
    const withDividend = goodSecurity({ bars: [...before, ...after] });
    expect(run("U-ma100", withDividend).ok).toBe(true);
  });

  it("U-marketCap：超出区间淘汰，缺数据时未判定且不淘汰", () => {
    expect(run("U-marketCap", goodSecurity({ floatMarketCap: 40e8 })).ok).toBe(true);
    expect(run("U-marketCap", goodSecurity({ floatMarketCap: 100e8 })).ok).toBe(false);
    expect(run("U-marketCap", goodSecurity({ floatMarketCap: 10e8 })).ok).toBe(false);

    const missing = run("U-marketCap", goodSecurity({ floatMarketCap: null }));
    expect(missing.ok).toBe(true);
    expect(missing.unknown).toBe(true);
    expect(missing.detail).toContain("未生效");
  });

  it("U-turnover：成交额低于本档下限即淘汰", () => {
    expect(run("U-turnover", goodSecurity()).ok).toBe(true);
    expect(run("U-turnover", withLastBar(goodSecurity(), { amount: 1000 })).ok).toBe(false);
  });

  it("X-ma100Whipsaw：反复穿梭 MA100 的震荡被剔除（书 L663）", () => {
    const choppy = goodSecurity({
      bars: bars(Array.from({ length: 300 }, (_, i) => (i % 2 === 0 ? 10.5 : 9.5))),
    });
    const outcome = run("X-ma100Whipsaw", choppy);
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("震荡");

    expect(run("X-ma100Whipsaw", goodSecurity()).ok).toBe(true);
  });

  it("U-aboveTrendline：收盘跌破下降趋势线即淘汰（书 L585）", () => {
    const zigzag = bars(Array.from({ length: 80 }, (_, i) => 20 - i * 0.05 + 0.25 * Math.sin(i / 2)));
    const outcome = run("U-aboveTrendline", goodSecurity({ bars: zigzag }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("下降趋势线");

    expect(run("U-aboveTrendline", goodSecurity()).ok).toBe(true);
  });

  it("U-notRange：窄幅来回震荡淘汰，但稳步上涨不算震荡", () => {
    const box = bars(Array.from({ length: 80 }, (_, i) => 10 + 0.05 * Math.sin(i / 3)));
    const outcome = run("U-notRange", goodSecurity({ bars: box }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toContain("震荡");

    // 同样是窄区间，但在推进 —— 这是最初实现会误杀的情形
    const trending = run("U-notRange", goodSecurity());
    expect(trending.ok).toBe(true);
    expect(trending.detail).toContain("回调");
  });

  it("U-notRange：突破区间上沿放行", () => {
    const breakout = goodSecurity({
      bars: bars([...Array.from({ length: 79 }, (_, i) => 10 + 0.05 * Math.sin(i / 3)), 12]),
    });
    const outcome = run("U-notRange", breakout);
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("突破");
  });
});

describe("evaluateRules 的分层短路", () => {
  it("按 排除层 → 硬门槛 → 基础池 的顺序判定，首个不通过即淘汰", () => {
    const result = evaluateRules(
      buildContext(goodSecurity({ name: "ST测试" }), paramsFor("standard"), DEFAULT_CRITERIA),
    );
    expect(result.passed).toBe(false);
    expect(result.rejectedBy?.id).toBe("E-st");
    expect(result.rejectedBy?.stage).toBe("exclusions");
    // 淘汰后不再继续评估后面的规则
    expect(result.hits.map((h) => h.id)).not.toContain("U-ma100");
  });

  it("全通过时保留每一条命中记录，供候选明细展示", () => {
    const result = evaluateRules(buildContext(goodSecurity(), paramsFor("standard"), DEFAULT_CRITERIA));
    expect(result.passed).toBe(true);
    expect(result.rejectedBy).toBeNull();
    expect(result.hits.length).toBe(RULES.length);
    expect(result.hits.every((h) => h.outcome.ok)).toBe(true);
    // 每条规则都带来源，界面才能区分"书挑的"与"我们加的"
    expect(result.hits.every((h) => h.source === "book" || h.source === "inferred" || h.source === "offbook")).toBe(true);
    expect(result.hits.find((h) => h.id === "U-ma100")?.bookRef).toBe("L597");
  });
});

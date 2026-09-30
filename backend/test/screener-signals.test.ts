import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { buildContext } from "../src/screener/rules.js";
import { detectBullishDivergence, evaluateTrendSignals, priorHigh, type TrendSignals } from "../src/screener/signals.js";
import type { DailyBar, SecurityInput } from "../src/screener/types.js";
import { rankShortlist, toScreenResponse } from "../src/screener/response.js";
import { bars, goodSecurity } from "./helpers/screener-fixtures.js";

/**
 * 信号层：基础池回答"能不能买"，这里回答"现在是不是买点"。
 *
 * 每个信号都有正反两面；S5 的复合条件用**注入 DIF** 的方式精确测——
 * 硬凑一条能产生真实 MACD 背离的走势既脆弱又说不清测的是哪一条判据。
 */

const STANDARD = paramsFor("standard");

function contextOf(security: SecurityInput, strictness: "loose" | "standard" | "strict" = "standard") {
  return buildContext(security, paramsFor(strictness), DEFAULT_CRITERIA);
}

function signalsOf(security: SecurityInput): TrendSignals {
  return evaluateTrendSignals(contextOf(security));
}

/** 线性走势段（含终点）。 */
const seg = (n: number, from: number, to: number): number[] =>
  Array.from({ length: n }, (_, i) => from + (to - from) * ((i + 1) / n));

describe("S1 / S2 均线突破入场", () => {
  it("S1：最后一根上穿 MA20 时命中", () => {
    // 60 根横在 10，10 根回落到 9.0，最后一根 9.9 回到 MA20 上方
    const closes = [...Array.from({ length: 60 }, () => 10), ...seg(10, 10, 9), 9.9];
    const result = signalsOf(goodSecurity({ bars: bars(closes) }));
    expect(result.signals.signals.map((s) => s.id)).toContain("S1");
  });

  it("S1：全程在 MA20 上方时不命中（没有穿越就没有入场信号）", () => {
    const closes = seg(80, 10, 20);
    const result = signalsOf(goodSecurity({ bars: bars(closes) }));
    expect(result.signals.signals.map((s) => s.id)).not.toContain("S1");
  });

  it("S2：上穿 MA60 时命中，且档序在 S1 之前", () => {
    const closes = [...Array.from({ length: 120 }, () => 10), ...seg(60, 10, 9), 9.55];
    const result = signalsOf(goodSecurity({ bars: bars(closes) }));
    const ids = result.signals.signals.map((s) => s.id);
    expect(ids).toContain("S2");
    // 大参数入场（MA60/MA100）比 MA20 上穿更可靠
    expect(result.signals.signals[0]?.id).toBe("S2");
  });
});

describe("S3 低位 123 突破高点 2", () => {
  it("突破高点 2 时命中，并给出三个结构位", () => {
    const closes = [...seg(15, 12, 8), ...seg(10, 8, 12), ...seg(8, 12, 9.5), ...seg(10, 9.5, 13)];
    const result = signalsOf(goodSecurity({ bars: bars(closes) }));
    const hit = result.signals.signals.find((s) => s.id === "S3");
    expect(hit).toBeDefined();
    expect(hit!.detail).toContain("低点1");
    expect(hit!.detail).toContain("高点2");
    expect(hit!.bookRef).toBe("L681");
  });

  it("结构成立但未突破高点 2 时不命中", () => {
    const closes = [...seg(15, 12, 8), ...seg(10, 8, 12), ...seg(12, 12, 9.5), ...seg(6, 9.5, 10.5)];
    const result = signalsOf(goodSecurity({ bars: bars(closes) }));
    expect(result.signals.signals.map((s) => s.id)).not.toContain("S3");
  });
});

describe("S5 底背离双突破", () => {
  /**
   * 两个依次降低的显著低点 + 两个依次降低的显著高点，最后强势突破。
   * 总长 81 根：两个高点（第 22 与第 45 根）必须都落在趋势线回溯窗口（60 根）之内，
   * 否则 `fallingTrendlineAt` 会因为取不到两个高点而返回 null，双突破就永远不成立。
   */
  const shape = [
    ...seg(15, 20, 16),
    ...seg(8, 16, 18.5), // 高点 A（第 22 根）≈ 18.59
    ...seg(15, 18.5, 15), // 低点 1（第 37 根）= 15
    ...seg(8, 15, 16.5), // 高点 B（第 45 根）≈ 16.58（低于 A → 构成下降趋势线）
    ...seg(15, 16.5, 14), // 低点 2（第 60 根）= 14（低于低点 1）
    ...seg(20, 14, 19.5), // 强势突破
  ];

  /** 在两个显著低点处注入指定的 DIF：用来精确控制"有没有背离"。 */
  function withDifAtLows(security: SecurityInput, difAtFirstLow: number, difAtSecondLow: number) {
    const ctx = contextOf(security);
    // 低点位置由构造决定：各段长度为 15/8/15/8/15/20，两个低点落在第 37 与第 60 根
    const first = 37;
    const second = 60;
    ctx.dif[first] = difAtFirstLow;
    ctx.dif[second] = difAtSecondLow;
    return ctx;
  }

  it("价格创新低而 DIF 抬高、且同时突破趋势线与水平阻力 → 命中，档序最高", () => {
    const security = goodSecurity({ bars: bars(shape) });
    const ctx = withDifAtLows(security, -1.2, -0.3);
    const result = evaluateTrendSignals(ctx);
    const hit = result.signals.signals.find((s) => s.id === "S5");
    expect(hit).toBeDefined();
    expect(hit!.tier).toBe(1);
    expect(result.signals.bestTier).toBe(1);
  });

  it("DIF 同步创新低时不算背离（只是普通的下跌）", () => {
    const security = goodSecurity({ bars: bars(shape) });
    const ctx = withDifAtLows(security, -1.2, -1.8);
    const result = evaluateTrendSignals(ctx);
    expect(result.signals.signals.map((s) => s.id)).not.toContain("S5");
  });

  it("直接检验背离不变式：价格更低 + DIF 更高", () => {
    const security = goodSecurity({ bars: bars(shape) });
    const ctx = contextOf(security);

    ctx.dif[37] = -1.2;
    ctx.dif[60] = -0.3;
    const divergent = detectBullishDivergence(ctx.adjBars, ctx.dif, 5, 60);
    expect(divergent).not.toBeNull();
    expect(divergent!.recent.price).toBeLessThan(divergent!.previous.price);

    ctx.dif[60] = -2.0;
    expect(detectBullishDivergence(ctx.adjBars, ctx.dif, 5, 60)).toBeNull();
  });
});

describe("S13 阻力突破 / 支撑回踩", () => {
  it("收盘突破前 N 根高点时命中", () => {
    const result = signalsOf(goodSecurity());
    const hit = result.signals.signals.find((s) => s.id === "S13");
    expect(hit).toBeDefined();
    expect(hit!.detail).toContain("突破前");
  });

  it("priorHigh 取的是**不含最后一根**的前区间最高价", () => {
    const series = bars([10, 11, 12, 13]);
    // 前三根的最高 = 12 × 1.01
    expect(priorHigh(series, 60)).toBeCloseTo(12 * 1.01, 6);
  });
});

describe("档序与最强档", () => {
  it("bestTier 取所有命中信号里最小的档号", () => {
    const result = signalsOf(goodSecurity());
    const tiers = result.signals.signals.map((s) => s.tier);
    expect(result.signals.bestTier).toBe(Math.min(...tiers));
  });

  it("无任何信号时 bestTier 为 null（而不是硬给一个档）", () => {
    const result = signalsOf(goodSecurity({ bars: bars(seg(200, 10, 12)) }));
    expect(result.signals.signals).toEqual([]);
    expect(result.signals.bestTier).toBeNull();
  });
});

describe("离场计划", () => {
  it("止损优先级：结构低点 → 均线配对 → 固定比例", () => {
    // 有 123 结构 → 用低点 3
    const withStructure = signalsOf(
      goodSecurity({ bars: bars([...seg(15, 12, 8), ...seg(10, 8, 12), ...seg(8, 12, 9.5), ...seg(10, 9.5, 13)]) }),
    );
    expect(withStructure.exit.stopBasis).toBe("low123");
    expect(withStructure.exit.bookRef).toBe("L689");

    // 无 123 结构但能算出 MA10 → 走均线配对（MA10 天然低于上涨中的收盘价）
    const paired = signalsOf(goodSecurity({ bars: bars(seg(200, 10, 20)) }));
    expect(paired.exit.stopBasis).toBe("ma-pairing");
    expect(paired.exit.stopBasisLabel).toContain("MA20 入场 / MA10 止损");

    // 均线还远算不出来时才落到固定比例（真正的兜底）
    const fallback = signalsOf(goodSecurity({ bars: bars([10, 10.5, 11, 11.5, 12]) }));
    expect(fallback.exit.stopBasis).toBe("fixed-ratio");
    expect(fallback.exit.stopSpace).toBeCloseTo(0.02, 6);
  });

  it("止损位低于入场价，且止损空间与之自洽", () => {
    const result = signalsOf(goodSecurity());
    const { entry, stop, stopSpace } = result.exit;
    expect(stop).toBeLessThan(entry);
    expect(stopSpace).toBeCloseTo((entry - stop) / entry, 6);
    expect(stopSpace).toBeGreaterThan(0);
  });

  it("含失效条件与分批止盈规则，且不出现目标价", () => {
    const result = signalsOf(goodSecurity());
    expect(result.exit.invalidation.length).toBeGreaterThan(0);
    expect(result.exit.scaleOut).toContain("分批");
    expect(JSON.stringify(result)).not.toContain("目标价");
  });

  it("止损位用真实成交价口径（除权后仍能对上盘口）", () => {
    // 因子 2 表示后复权价是不复权价的两倍：结构位必须除回去，否则止损位会离谱地高
    const closes = [...seg(15, 12, 8), ...seg(10, 8, 12), ...seg(8, 12, 9.5), ...seg(10, 9.5, 13)];
    const adjusted = bars(closes, { adjFactor: 2 });
    const result = signalsOf(goodSecurity({ bars: adjusted }));
    // 入场价取的是不复权收盘（13 附近），止损不应被放大成 2 倍
    expect(result.exit.entry).toBeLessThan(20);
    expect(result.exit.stop).toBeLessThan(result.exit.entry);
  });
});

describe("参考压力位", () => {
  it("前高与区间上沿重合时不重复列出", () => {
    // 两者都取"近 60 根的最高"，在多数走势里本就是同一个价位
    const result = signalsOf(goodSecurity());
    const prices = result.resistance.map((r) => r.price);
    for (let i = 1; i < prices.length; i++) {
      expect(Math.abs((prices[i] as number) - (prices[i - 1] as number))).toBeGreaterThan(
        (prices[i] as number) * 0.005,
      );
    }
  });

  it("给出前高与区间上沿，并明确是「可能受阻」而非涨幅预测", () => {
    const result = signalsOf(goodSecurity());
    expect(result.resistance.length).toBeGreaterThan(0);
    for (const item of result.resistance) {
      expect(item.detail).toContain("可能受阻");
      expect(item.detail).toContain("不是涨幅预测");
      expect(item.price).toBeGreaterThan(0);
    }
  });
});

describe("排序：档序优先，档内按止损空间", () => {
  it("低档位的候选排在前面，同档内止损空间小的在前", () => {
    const strong = signalsOf(
      goodSecurity({ bars: bars([...seg(15, 12, 8), ...seg(10, 8, 12), ...seg(8, 12, 9.5), ...seg(10, 9.5, 13)]) }),
    );
    const weak = signalsOf(goodSecurity({ bars: bars(seg(200, 10, 20)) }));

    const response = toScreenResponse(
      {
        criteria: DEFAULT_CRITERIA,
        funnel: { universe: 2, afterExclusions: 2, afterHardFilters: 2, shortlisted: 2, signalEligible: 2 },
        shortlisted: [
          { code: "weak", passed: true, rejectedBy: null, hits: [], unknownRules: [], metrics: {} as never, signals: weak.signals, exit: weak.exit, resistance: [] },
          { code: "strong", passed: true, rejectedBy: null, hits: [], unknownRules: [], metrics: {} as never, signals: strong.signals, exit: strong.exit, resistance: [] },
        ],
        inactiveRules: [],
        marketGate: null,
        suppressed: false,
      },
      { dataDateKey: 20260930, refreshedAt: new Date("2026-09-30T04:00:00Z"), params: {
        mode: "trend", strictness: "standard", boards: ["main"], ignoreMarketGate: false, refresh: false,
      }, limit: 10 },
    );

    expect(response.candidates.map((c) => c.code)).toEqual(["strong", "weak"]);
    // 有信号的排前面；无信号的（bestTier 为 null）垫底，而不是被当成 0 排到最前
    expect(response.candidates[0]?.signalTier).toBe(2);
    expect(response.candidates[1]?.signalTier).toBeNull();
  });

  it("rankShortlist 在档序相同时按止损空间升序", () => {
    const base = signalsOf(goodSecurity());
    const wide = { ...base, exit: { ...base.exit, stopSpace: 0.08 } };
    const narrow = { ...base, exit: { ...base.exit, stopSpace: 0.01 } };
    const verdict = (code: string, exit: typeof base.exit) => ({
      code,
      passed: true as const,
      rejectedBy: null,
      hits: [],
      unknownRules: [],
      metrics: {} as never,
      signals: base.signals,
      exit,
      resistance: [],
    });
    const ranked = rankShortlist([verdict("wide", wide.exit), verdict("narrow", narrow.exit)]);
    expect(ranked.map((v) => v.code)).toEqual(["narrow", "wide"]);
  });
});

describe("参数一致性", () => {
  it("三档的止损空间上限递增放宽（严格档最紧）", () => {
    expect(paramsFor("strict").stopSpaceMax).toBeLessThan(paramsFor("standard").stopSpaceMax);
    expect(paramsFor("standard").stopSpaceMax).toBeLessThan(paramsFor("loose").stopSpaceMax);
    expect(STANDARD.stopSpaceMax).toBeCloseTo(0.08, 6);
  });
});

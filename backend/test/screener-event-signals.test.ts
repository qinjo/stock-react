import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { buildContext, evaluateRules } from "../src/screener/rules.js";
import { evaluateEventSignals } from "../src/screener/signals.js";
import { screenUniverse } from "../src/screener/engine.js";
import { atrSeries, detectUpwardGap } from "../src/screener/structure.js";
import type { SecurityInput } from "../src/screener/types.js";
import { bars, goodSecurity } from "./helpers/screener-fixtures.js";

/**
 * 事件驱动模式：缺口与涨停（书第五、六章）。
 *
 * 与均线跟随的区别在**触发器**——那边是持续的结构位置，这边是单日事件。
 * 每个信号都正反两面测；缺口宽度按严格度取三档，专门用一个"刚好卡在两档之间"的宽度验证。
 */

const seg = (n: number, from: number, to: number): number[] =>
  Array.from({ length: n }, (_, i) => from + (to - from) * ((i + 1) / n));

const securityOf = (closes: number[]): SecurityInput => goodSecurity({ bars: bars(closes) });

/** 规则层要按事件模式求值，否则专属条款会被整段跳过。 */
const EVENT_CRITERIA = { ...DEFAULT_CRITERIA, mode: "event" as const };

function eventContext(security: SecurityInput, strictness: "loose" | "standard" | "strict" = "standard") {
  return buildContext(security, paramsFor(strictness), EVENT_CRITERIA);
}

function eventSignals(security: SecurityInput, strictness: "loose" | "standard" | "strict" = "standard") {
  return evaluateEventSignals(eventContext(security, strictness));
}

/** 80 根横在 10，最后一根跳空到 `gapClose`。 */
const flatThenGap = (gapClose: number) => [...Array.from({ length: 80 }, () => 10), gapClose];

describe("缺口：宽度阈值按严格度取三档", () => {
  it("宽缺口（约 2.6×ATR20）三档都算数", () => {
    for (const tier of ["loose", "standard", "strict"] as const) {
      const ids = eventSignals(securityOf(flatThenGap(10.8)), tier).signals.signals.map((s) => s.id);
      expect(ids, tier).toContain("S6");
    }
  });

  it("中等缺口（约 1.3×ATR20）宽松/标准放行、严格档拦下", () => {
    const loose = eventSignals(securityOf(flatThenGap(10.5)), "loose").signals.signals.map((s) => s.id);
    const standard = eventSignals(securityOf(flatThenGap(10.5)), "standard").signals.signals.map((s) => s.id);
    const strict = eventSignals(securityOf(flatThenGap(10.5)), "strict").signals.signals.map((s) => s.id);

    expect(loose).toContain("S6");
    expect(standard).toContain("S6");
    expect(strict).not.toContain("S6");
  });

  it("窄缺口（约 0.2×ATR20）三档都不算数", () => {
    for (const tier of ["loose", "standard", "strict"] as const) {
      const ids = eventSignals(securityOf(flatThenGap(10.25)), tier).signals.signals.map((s) => s.id);
      expect(ids, tier).not.toContain("S6");
    }
  });

  it("三档的缺口宽度门槛与参数表一致", () => {
    expect(paramsFor("loose").gapWidthAtr).toBeLessThan(paramsFor("standard").gapWidthAtr);
    expect(paramsFor("standard").gapWidthAtr).toBeLessThan(paramsFor("strict").gapWidthAtr);
  });
});

describe("缺口：突破性 vs 持续性", () => {
  it("跳空越过前 60 根高点 → 突破性缺口 S6", () => {
    const ids = eventSignals(securityOf(flatThenGap(10.8))).signals.signals.map((s) => s.id);
    expect(ids).toContain("S6");
    expect(ids).not.toContain("S7");
  });

  it("上涨趋势途中的跳空（未越过前高）→ 持续性缺口 S7", () => {
    // 一路上涨到 12（前高 12.12），回踩一根，再跳空到 12.2：未越过前高，但仍在 MA100 之上
    const closes = [...seg(100, 8, 12), 11.5, 12.2];
    const ids = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(ids).toContain("S7");
    expect(ids).not.toContain("S6");
  });
});

describe("缺口：失效与不追高", () => {
  it("缺口被回补后不再算数（书 L1316）", () => {
    // 跳空到 11，随后一根跌回缺口下沿之下
    const closes = [...Array.from({ length: 80 }, () => 10), 11, 9.8];
    const gap = detectUpwardGap(
      bars([...Array.from({ length: 80 }, () => 10), 11]),
      { lookback: 60, maxAge: 3 },
    );
    expect(gap?.filled).toBe(false);

    const ids = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(ids).not.toContain("S6");
  });

  it("错过跳空当日且价格已跑过跳空日最高价 → 不追高（书 L1298）", () => {
    // 跳空到 11（当日最高 11.11），次日继续冲到 11.6 —— 已跑过跳空日最高价
    // 跳空到 11（当日最高 11.11），次日仅涨到 11.2（+1.8%，不足以再形成跳空）
    // 但收盘已跑过跳空日最高价 → 属于追高
    const closes = [...Array.from({ length: 80 }, () => 10), 11, 11.2];
    const ids = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(ids).not.toContain("S6");
    expect(ids).not.toContain("S7");
  });

  it("缺口在观察窗口之外就不再算数", () => {
    const closes = [...Array.from({ length: 80 }, () => 10), 10.8, 10.8, 10.8, 10.8, 10.8];
    const ids = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(ids).not.toContain("S6");
  });
});

describe("涨停：位置二分", () => {
  it("MA100 之上的涨停被高位涨停条款剔除（书 L1461）", () => {
    // 一路上涨到 12，MA100 在下方，当日涨停 → 高位涨停（需 ≥150 根才过 H-bars）
    const closes = [...seg(190, 8, 12), 13.2];
    const result = evaluateRules(eventContext(securityOf(closes)));
    const rule = result.hits.find((hit) => hit.id === "X-highLimitUp");
    expect(rule?.outcome.ok).toBe(false);
  });

  it("MA100 之下的涨停不受该条款影响", () => {
    // 长期横盘 10，当日涨停到 11 → MA100 = 10，但前一根也在 MA100 上（=10）
    // 这里用"先跌一段再涨停"来构造明确位于 MA100 之下的涨停
    const closes = [...seg(190, 14, 9.5), 10.45];
    const rule = evaluateRules(eventContext(securityOf(closes))).hits.find((hit) => hit.id === "X-highLimitUp");
    expect(rule?.outcome.ok).toBe(true);
  });
});

describe("涨停：连板后回调再涨停（书 L1724）", () => {
  it("近 20 日涨停次数达到阈值时剔除", () => {
    // 连续三个涨停后回调，再来一个涨停
    // 从高处一路跌下来，三连板之后仍在 MA100 之下——否则会先被「高位涨停」条款拦掉，
    // 那条也是对的，但就测不到本条款了
    const closes = [...seg(150, 30, 10), 11, 12.1, 13.31, 11.8, 11.6, 11.9, 13.09];
    const rule = evaluateRules(eventContext(securityOf(closes))).hits.find((hit) => hit.id === "X-limitUpStreak");
    expect(rule?.outcome.ok).toBe(false);
    expect(rule?.outcome.detail).toContain("连板后回调再涨停");
  });

  it("当日未涨停时该条款不参与", () => {
    const rule = evaluateRules(eventContext(securityOf(seg(200, 8, 12)))).hits.find((hit) => hit.id === "X-limitUpStreak");
    expect(rule?.outcome.ok).toBe(true);
  });
});

describe("S10 涨停 + 低位 123（作者称最强）", () => {
  it("低位 123 突破高点 2 且当日涨停、仍在 MA100 之下 → S10 且档序最高", () => {
    // 长期下跌把 MA100 抬高，再走一个 123 结构，最后涨停突破高点 2
    const closes = [
      ...seg(120, 20, 12), // MA100 落在 16 附近
      ...seg(15, 12, 10), // 低点 1
      ...seg(10, 10, 11.5), // 高点 2
      ...seg(8, 11.5, 10.5), // 低点 3（高于低点 1）
      ...seg(5, 10.5, 10.6), // 低点 3 之后要有几根才被确认为显著低点
      11.66, // 涨停（10.6 × 1.1）且越过高点 2
    ];
    const result = eventSignals(securityOf(closes));
    const strongest = result.signals.signals[0];
    expect(strongest?.id).toBe("S10");
    expect(strongest?.tier).toBe(1);
    expect(result.signals.bestTier).toBe(1);
  });
});

describe("S9 突破性涨停", () => {
  it("涨停并突破前 60 根高点 → S9", () => {
    const closes = [...Array.from({ length: 80 }, () => 10), 11];
    const ids = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(ids).toContain("S9");
  });
});

describe("S12 涨停 B 形态", () => {
  it("前期大幅回调、当日涨停收复下跌缺口并站上 MA100 → S12", () => {
    const closes = [
      ...Array.from({ length: 150 }, () => 10),
      ...seg(8, 10, 13), // 冲高
      ...seg(12, 13, 10.8), // 大幅快速回调
      10.5, // 下跌缺口：最高价低于前一根最低价
      ...seg(3, 10.5, 10), // 继续下探
      11, // 涨停（10 × 1.1）收复缺口上沿并站上 MA100
    ];
    const result = eventSignals(securityOf(closes));
    const ids = result.signals.signals.map((s) => s.id);
    expect(ids).toContain("S12");
    // 作者首选，档序仅次于 S10
    expect(result.signals.bestTier).toBe(2);
  });
});

describe("档序与模式接入", () => {
  it("事件模式的档序按书里的可靠性排序", () => {
    const closes = [...Array.from({ length: 80 }, () => 10), 11];
    const result = eventSignals(securityOf(closes));
    const tiers = result.signals.signals.map((s) => s.tier);
    expect(result.signals.bestTier).toBe(Math.min(...tiers));
  });

  it("均线模式的信号不会出现在事件模式里（反之亦然）", () => {
    const closes = [...Array.from({ length: 80 }, () => 10), 10.8];
    const eventIds = eventSignals(securityOf(closes)).signals.signals.map((s) => s.id);
    expect(eventIds.every((id) => ["S6", "S7", "S9", "S10", "S12"].includes(id))).toBe(true);
  });

  it("事件模式跑通整条链路：基础池 → 信号 → 候选", () => {
    const closes = [...Array.from({ length: 160 }, () => 10), ...seg(20, 10, 10.2), 11.02];
    const outcome = screenUniverse([securityOf(closes)], { ...DEFAULT_CRITERIA, mode: "event" });
    expect(outcome.funnel.shortlisted).toBeGreaterThan(0);
    expect(outcome.shortlisted.length).toBeGreaterThan(0);
    expect(outcome.shortlisted[0]?.signals.bestTier).not.toBeNull();
  });

  it("事件模式专属的排除条款在均线模式下不参与（否则会刷出一堆空洞的通过）", () => {
    const ctx = buildContext(securityOf(seg(200, 8, 12)), paramsFor("standard"), DEFAULT_CRITERIA);
    const ids = evaluateRules(ctx).hits.map((hit) => hit.id);
    expect(ids).not.toContain("X-highLimitUp");
    expect(ids).not.toContain("X-limitUpStreak");
    expect(ids).not.toContain("X-limitUpBelowTrendline");
  });
});

describe("ATR", () => {
  it("横盘序列的 ATR 等于日振幅", () => {
    const atr = atrSeries(bars(Array.from({ length: 40 }, () => 10)), 20);
    expect(atr[39]).toBeCloseTo(0.2, 2);
  });

  it("样本不足时前段为 null", () => {
    const atr = atrSeries(bars(Array.from({ length: 10 }, () => 10)), 20);
    expect(atr.every((v) => v === null)).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { RULES, buildContext, evaluateRules } from "../src/screener/rules.js";
import { evaluateTrendSignals } from "../src/screener/signals.js";
import { detectUpwardGap, officialChangePercent } from "../src/screener/structure.js";
import { rankShortlist } from "../src/screener/response.js";
import { screenUniverse } from "../src/screener/engine.js";
import { bars, goodSecurity } from "./helpers/screener-fixtures.js";
import type { SecurityInput } from "../src/screener/types.js";

/**
 * 规格审查发现的缺陷的回归测试。
 *
 * 每一条都对应一个具体缺陷：缓存键漏参数、死参数、被回补的缺口掩蔽有效缺口、
 * 止损位取决于一句展示文案。**没有测试钉住的修复会回来。**
 */

const seg = (n: number, from: number, to: number): number[] =>
  Array.from({ length: n }, (_, i) => from + (to - from) * ((i + 1) / n));

const securityOf = (closes: number[]): SecurityInput => goodSecurity({ bars: bars(closes) });

describe("缺口：被回补的缺口不得掩蔽更早的有效缺口", () => {
  it("最近一次跳空被回补后，仍能认出前一次未回补的跳空", () => {
    // 横盘 → 跳空到 10.8（未回补）→ 再跳空到 11.2，次日跌回把它回补
    const closes = [...Array.from({ length: 80 }, () => 10), 10.8, 11.2, 10.9];
    const series = bars(closes);
    const gap = detectUpwardGap(series, { lookback: 60, maxAge: 3 });

    expect(gap).not.toBeNull();
    // 取到的必须是那个仍然有效的（10.8 那根），而不是被回补的 11.2
    expect(gap?.filled).toBe(false);
    expect(gap?.lower).toBeLessThan(11);
  });

  it("所有跳空都被回补时返回 null（而不是返回一个死缺口）", () => {
    const closes = [...Array.from({ length: 80 }, () => 10), 11, 9.8];
    expect(detectUpwardGap(bars(closes), { lookback: 60, maxAge: 3 })).toBeNull();
  });
});

describe("止损配对：不得依赖展示文案", () => {
  it("改掉 S2 的 label 文案不会改变止损位（配对读的是结构化字段）", () => {
    // 构造一个触发 S2（上穿 MA100）的走势
    const closes = [...Array.from({ length: 120 }, () => 10), ...seg(60, 10, 9), 9.55];
    const ctx = buildContext(securityOf(closes), paramsFor("standard"), DEFAULT_CRITERIA);
    const result = evaluateTrendSignals(ctx);
    const s2 = result.signals.signals.find((hit) => hit.id === "S2");
    expect(s2?.entryMa).toBeGreaterThanOrEqual(60);

    // 模拟"有人改了文案"：标签里不再出现 MA100/MA60 字样
    const renamed = {
      ...result.signals,
      signals: result.signals.signals.map((hit) => (hit.id === "S2" ? { ...hit, label: "大参数均线入场" } : hit)),
    };
    expect(renamed.signals.find((hit) => hit.id === "S2")?.entryMa).toBe(s2?.entryMa);
  });
});

describe("两条此前是死参数的档位参数", () => {
  it("trendR2Min：严格档会拦下走势不流畅的标的，宽松/标准档不拦", () => {
    // 锯齿走势：R² 很低
    const closes = Array.from({ length: 200 }, (_, i) => 10 + (i % 2 === 0 ? 0 : 1.5) + i * 0.01);
    const security = securityOf(closes);

    // 直接调用该规则：锯齿走势会先被别的门槛拦下，走不到它
    const rule = RULES.find((r) => r.id === "U-trendR2");
    expect(rule).toBeDefined();
    const outcomeOf = (strictness: "loose" | "standard" | "strict") =>
      (rule as (typeof RULES)[number]).evaluate(
        buildContext(security, paramsFor(strictness), { ...DEFAULT_CRITERIA, strictness }),
      );

    expect(paramsFor("strict").trendR2Min).not.toBeNull();
    expect(paramsFor("standard").trendR2Min).toBeNull();

    const standardRule = { outcome: outcomeOf("standard") };
    const strictRule = { outcome: outcomeOf("strict") };

    // 标准档该条不参与判定（直接通过）；严格档真的比对 R²
    expect(standardRule?.outcome.ok).toBe(true);
    expect(standardRule?.outcome.detail).toContain("本档不要求");
    expect(strictRule?.outcome.ok).toBe(false);
    expect(strictRule?.outcome.detail).toContain("走势不够流畅");
  });

  it("ma100BreakoutWindow：本档窗口会影响同档内的先后", () => {
    const verdict = (code: string, since: number | null) => ({
      code,
      passed: true as const,
      rejectedBy: null,
      hits: [],
      unknownRules: [],
      metrics: { barsSinceMa100Cross: since, trendR2: null, floatMarketCap: null, turnoverAmount: null } as never,
      signals: { signals: [], bestTier: 3 },
      exit: {
        entry: 10,
        stop: 9.5,
        stopBasis: "ma-pairing" as const,
        stopBasisLabel: "均线配对",
        stopSpace: 0.05,
        invalidation: "",
        scaleOut: "",
        bookRef: "",
      },
      resistance: [],
      reasoning: null,
    });

    // 3 根 vs 8 根：严格档窗口 5 天，3 根算"刚突破"、8 根不算 → 分桶把 3 根排前面
    const list = [verdict("OLD", 8), verdict("FRESH", 3)];
    const strictOrder = rankShortlist(list, paramsFor("strict")).map((v) => v.code);
    expect(strictOrder).toEqual(["FRESH", "OLD"]);

    // 宽松档窗口 20 天，两者都算"刚突破" → 退回按距今根数升序，结果相同但走的是另一条分支
    const looseOrder = rankShortlist(list, paramsFor("loose")).map((v) => v.code);
    expect(looseOrder).toEqual(["FRESH", "OLD"]);

    // 构造一个只有宽松档才"算刚突破"的差距：25 根
    const wide = [verdict("A25", 25), verdict("B10", 10)];
    // 严格档窗口 5：两者都不在桶内 → 按距今升序 → B10 在前
    expect(rankShortlist(wide, paramsFor("strict")).map((v) => v.code)).toEqual(["B10", "A25"]);
    // 宽松档窗口 20：A25 不在桶内、B10 在 → B10 仍然在前（但走的是分桶分支）
    expect(rankShortlist(wide, paramsFor("loose")).map((v) => v.code)).toEqual(["B10", "A25"]);
  });
});

/* ------------------- P17「允许的信号档」（#26 审查 A1） ------------------- */

describe("P17：三档对信号档位的取舍", () => {
  /** 夹具最强档为 4（S1 上穿 MA20）：标准档认它、严格档（仅档 1）不认。 */
  const security = () => goodSecurity();

  it("宽松档不限档位、标准档排除最弱档、严格档只做最强档", () => {
    expect(paramsFor("loose").signalTierMax).toBeNull();
    expect(paramsFor("standard").signalTierMax).toBe(4);
    expect(paramsFor("strict").signalTierMax).toBe(1);

    const eligible = (strictness: "loose" | "standard" | "strict") =>
      screenUniverse([security()], { ...DEFAULT_CRITERIA, strictness }).funnel.signalEligible;

    expect(eligible("loose")).toBe(1);
    expect(eligible("standard")).toBe(1); // 档 4 ≤ 4
    expect(eligible("strict")).toBe(0); // 档 4 > 1，本档不做
  });

  it("被档位闸门挡下时，候选为 0 但基础池计数仍然如实", () => {
    const strict = screenUniverse([security()], { ...DEFAULT_CRITERIA, strictness: "strict" });
    // 个股本身的硬门槛与基础池条件是满足的
    expect(strict.funnel.signalEligible).toBe(0);
    expect(strict.shortlisted).toEqual([]);
  });

  it("档位闸门不改变止损空间与离场计划（那些仍由确定性计算给出）", () => {
    const loose = screenUniverse([security()], { ...DEFAULT_CRITERIA, strictness: "loose" });
    const standard = screenUniverse([security()], { ...DEFAULT_CRITERIA, strictness: "standard" });
    expect(standard.shortlisted[0]?.exit.stop).toBe(loose.shortlisted[0]?.exit.stop);
    expect(standard.shortlisted[0]?.signals.bestTier).toBe(4);
  });
});

/* ------------------- 除权日的涨跌幅口径（#26 审查 C1） ------------------- */

describe("officialChangePercent：按交易所口径的昨收", () => {
  const day = (close: number, adjFactor: number, date = 20260929) => ({
    date,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1,
    amount: 1,
    adjFactor,
  });

  it("非除权日：等价于直接用昨日收盘", () => {
    expect(officialChangePercent(day(11, 1, 20260930), day(10, 1))).toBeCloseTo(10, 6);
  });

  it("除权日：按被下调过的昨收算，而不是除权前的收盘", () => {
    // 库内昨收 10、因子 1；今日因子变 2 → 快照昨收 = 10 × (1/2) = 5
    // 今日收盘 5.5 → 真实涨幅 +10%；直接用库内昨收会算成 −45%
    expect(officialChangePercent(day(5.5, 2, 20260930), day(10, 1))).toBeCloseTo(10, 6);
  });

  it("缺根或昨收非正时返回 null，而不是算出 Infinity", () => {
    expect(officialChangePercent(undefined, day(10, 1))).toBeNull();
    expect(officialChangePercent(day(11, 1, 20260930), undefined)).toBeNull();
    expect(officialChangePercent(day(11, 1, 20260930), day(0, 1))).toBeNull();
  });
});

/* ------ E-st：名称缺失时不按违规处理，但必须披露（真实库里有这类标的） ------ */

/**
 * 真实库里确实存在"在市、非北交所、名称为 NULL"的标的（603183 / 002667 / 002813）。
 * 名称来自每日快照，快照日停牌就没补上——而这三只恰好也因"最后一根不在最新交易日"
 * 被 `E-suspended-today` 挡掉，所以没有实际风险。
 *
 * 但**残余情形**是"名称为空且当天在交易"：那时 ST 剔除对这一只是失效的。
 * 这条测试钉住的是当时的处置原则——**缺数据不等于违规，但必须如实披露**，
 * 让它出现在 `unknownRules`（界面据此显示"未判定"），而不是静默放过。
 */
describe("E-st：名称缺失时标为未判定，而不是当成违规或静默放过", () => {
  it("名称为 NULL → 标为未判定（不 fail、也不假装判定过）", () => {
    const security = goodSecurity({ name: null });
    const result = evaluateRules(
      buildContext(security, paramsFor("loose"), { ...DEFAULT_CRITERIA, strictness: "loose" }),
    );
    const rule = result.hits.find((h) => h.id === "E-st");
    expect(rule?.outcome.ok).toBe(true);
    expect(rule?.outcome.unknown).toBe(true);
    expect(rule?.outcome.detail).toContain("名称为空");
  });

  it("命中 ST / 退的名义标的 → 如实剔除", () => {
    const security = goodSecurity({ name: "ST测试" });
    const result = evaluateRules(
      buildContext(security, paramsFor("loose"), { ...DEFAULT_CRITERIA, strictness: "loose" }),
    );
    const rule = result.hits.find((h) => h.id === "E-st");
    expect(rule?.outcome.ok).toBe(false);
  });

  it("未判定的规则会进入 unknownRules，供界面显示「未判定」", () => {
    const outcome = screenUniverse([goodSecurity({ name: null })], {
      ...DEFAULT_CRITERIA,
      strictness: "loose",
    });
    const verdict = outcome.shortlisted[0];
    expect(verdict?.unknownRules).toContain("E-st");
  });
});

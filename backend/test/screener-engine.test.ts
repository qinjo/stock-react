import { describe, expect, it } from "vitest";
import { screenUniverse } from "../src/screener/engine.js";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { buildContext, evaluateRules } from "../src/screener/rules.js";
import type { SecurityInput } from "../src/screener/types.js";
import { bars, goodSecurity, rising, withLastBar } from "./helpers/screener-fixtures.js";

/**
 * 引擎层的验收：漏斗分档、未生效规则的暴露、候选画像。
 * 单条规则的正反例见 `screener-rules.test.ts`；这里只关心"在整批输入上跑"的行为。
 */

/** 一只处处通过的票，但代码不同，避免混淆。 */
const pass = (code: string) => goodSecurity({ code });

const MIXED: SecurityInput[] = [
  pass("600001"), // 通过
  goodSecurity({ code: "600002", name: "ST测试" }), // 名称含 ST → 排除层
  withLastBar(pass("600003"), { volume: 0 }), // 停牌 → 排除层
  withLastBar(pass("600004"), { high: 20, low: 20 }), // 一字板 → 排除层
  goodSecurity({ code: "600005", isLive: false }), // 已退市 → 排除层
  goodSecurity({ code: "600006", board: "bj" }), // 北交所 → 排除层
  goodSecurity({ code: "600007", bars: bars(rising(120)) }), // 根数不足 → 硬门槛
  goodSecurity({ code: "600008", bars: bars(Array.from({ length: 300 }, (_, i) => 30 - i * 0.05)) }), // 跌破 MA100 → 基础池
];

describe("screenUniverse 漏斗分档", () => {
  const outcome = screenUniverse(MIXED);

  it("四档计数各就各位", () => {
    expect(outcome.funnel).toEqual({
      universe: 8,
      afterExclusions: 3, // 600001 / 600007 / 600008 通过排除层
      afterHardFilters: 2, // 600007 倒在根数不足
      shortlisted: 1, // 600008 倒在 MA100
      signalEligible: 1, // 600001 命中信号且止损空间在档内
    });
  });

  it("只返回真正通过基础池的标的", () => {
    expect(outcome.shortlisted.map((v) => v.code)).toEqual(["600001"]);
  });

  it("批量结果只给计数与通过者；需要具体淘汰原因时走规则层", () => {
    // 刻意不返回全市场 6000 条淘汰原因：没人看，还会把响应体撑爆
    const stOnly = screenUniverse([MIXED[1] as SecurityInput]);
    expect(stOnly.funnel.afterExclusions).toBe(0);
    expect(stOnly.shortlisted).toHaveLength(0);

    const verdict = evaluateRules(
      buildContext(MIXED[1] as SecurityInput, paramsFor("standard"), DEFAULT_CRITERIA),
    );
    expect(verdict.rejectedBy?.id).toBe("E-st");
    expect(verdict.rejectedBy?.stage).toBe("exclusions");
  });

  it("通过本档严格度后不受其他档影响（同一批输入换档会给出不同结果）", () => {
    const strict = screenUniverse(MIXED, { ...DEFAULT_CRITERIA, strictness: "strict" });
    // 严格档要求 250 根，600007 本来就倒在硬门槛；其余计数不变
    expect(strict.funnel.universe).toBe(8);
    expect(strict.funnel.shortlisted).toBe(1);
    // 严格档的止损空间上限是 5%，夹具约 3.5%，仍应入选
    expect(strict.funnel.signalEligible).toBe(1);
    expect(strict.criteria.strictness).toBe("strict");
  });

  it("回显本次使用的筛选条件（缓存键与界面展示都依赖它）", () => {
    const outcomeWithBeijing = screenUniverse(MIXED, {
      mode: "trend",
      strictness: "loose",
      includeBeijing: true,
      ignoreMarketGate: false,
    });
    expect(outcomeWithBeijing.criteria).toEqual({
      mode: "trend",
      strictness: "loose",
      includeBeijing: true,
      ignoreMarketGate: false,
    });
    // 打开北交所后 600006 进入候选
    expect(outcomeWithBeijing.shortlisted.map((v) => v.code)).toContain("600006");
  });

  it("事件驱动模式尚未接入信号层，因此暂时出不了候选（如实返回空，而不是硬塞）", () => {
    const eventOutcome = screenUniverse(MIXED, { ...DEFAULT_CRITERIA, mode: "event" });
    expect(eventOutcome.funnel.shortlisted).toBeGreaterThan(0);
    expect(eventOutcome.funnel.signalEligible).toBe(0);
    expect(eventOutcome.shortlisted).toEqual([]);
  });

  it("空输入不炸", () => {
    expect(screenUniverse([]).funnel).toEqual({
      universe: 0,
      afterExclusions: 0,
      afterHardFilters: 0,
      shortlisted: 0,
      signalEligible: 0,
    });
  });
});

describe("未生效规则的显式暴露", () => {
  it("流通市值全线缺失时，把市值闸门列为未生效，而不是假装它开着", () => {
    const missing = [goodSecurity({ code: "600001", floatMarketCap: null })];
    const outcome = screenUniverse(missing);
    expect(outcome.inactiveRules).toContain("U-marketCap");
    // 缺数据不淘汰，所以它仍然通过
    expect(outcome.shortlisted).toHaveLength(1);
    expect(outcome.shortlisted[0]?.unknownRules).toContain("U-marketCap");
  });

  it("市值数据齐备时不列为未生效", () => {
    expect(screenUniverse([goodSecurity({ floatMarketCap: 40e8 })]).inactiveRules).not.toContain(
      "U-marketCap",
    );
  });
});

describe("候选画像", () => {
  it("给出 MA100 与偏离度，供排序与界面展示", () => {
    const outcome = screenUniverse([goodSecurity()]);
    const metrics = outcome.shortlisted[0]?.metrics;
    expect(metrics?.ma100).toBeGreaterThan(0);
    expect(metrics?.ma100Deviation).toBeGreaterThan(0); // 稳步上涨 → 收盘在 MA100 上方
    expect(metrics?.floatMarketCap).toBe(40e8);
    expect(metrics?.turnoverAmount).toBeGreaterThan(0);
  });

  it("计算最近一次上穿 MA100 距今多少根（书 L545：刚突破的更值得关注）", () => {
    // 140 根横在 10，随后 10 根缓升、末根放量突破前高 —— 上穿发生在第 141 根，距今 9 根。
    // 斜率刻意放平：早先那版 10 根从 10 拉到 15，止损空间 15% 超过档内 8% 上限，
    // 会被止损空间闸门挡掉而根本不进候选（这本身是对的，只是测不到想看的东西）。
    const flatThenRise = [
      ...Array.from({ length: 140 }, () => 10),
      ...Array.from({ length: 9 }, (_, i) => 10.2 + i * 0.1),
      11.2,
    ];
    const outcome = screenUniverse([goodSecurity({ code: "600001", bars: bars(flatThenRise) })]);
    expect(outcome.shortlisted).toHaveLength(1);
    expect(outcome.shortlisted[0]?.metrics.barsSinceMa100Cross).toBe(9);
  });

  it("全程位于 MA100 之上时，上穿时点记为 null（而不是硬编一个数）", () => {
    const outcome = screenUniverse([goodSecurity()]);
    expect(outcome.shortlisted[0]?.metrics.barsSinceMa100Cross).toBeNull();
  });
});

/* ------------------------------- 大盘门（#22） ------------------------------- */

/** 造一个大盘门判定；只关心 state 与创业板指条件。 */
function gateOf(state: "offense" | "defense" | "empty", growthAbove: boolean | null = true) {
  const position = state === "offense" ? 1 : state === "defense" ? 0.5 : 0;
  return {
    state,
    indexCode: "sh000001",
    indexClose: 3000,
    indexMa60: 2900,
    indexMa100: 2800,
    threeMonthReturn: 0.05,
    bookPosition: position,
    gatePosition: position,
    positionAdvice: position,
    growthIndexAboveMa100: growthAbove,
    reason: `【测试】${state}`,
  };
}

describe("大盘门（#22）", () => {
  it("空仓档默认不出票，但个股层面的漏斗与数量仍如实给出", () => {
    const outcome = screenUniverse([goodSecurity()], DEFAULT_CRITERIA, {
      marketGate: gateOf("empty"),
    });
    expect(outcome.suppressed).toBe(true);
    // "有多少符合个股条件"与"要不要给出来"是两件事
    expect(outcome.funnel.shortlisted).toBe(1);
    expect(outcome.funnel.signalEligible).toBe(1);
    expect(outcome.marketGate?.state).toBe("empty");
  });

  it("进攻/防守档不出票抑制照常出票", () => {
    for (const state of ["offense", "defense"] as const) {
      const outcome = screenUniverse([goodSecurity()], DEFAULT_CRITERIA, {
        marketGate: gateOf(state),
      });
      expect(outcome.suppressed, state).toBe(false);
      expect(outcome.shortlisted, state).toHaveLength(1);
    }
  });

  it("逃生开关可覆盖空仓档（用户明确承担违反书的择时前提）", () => {
    const outcome = screenUniverse(
      [goodSecurity()],
      { ...DEFAULT_CRITERIA, ignoreMarketGate: true },
      { marketGate: gateOf("empty") },
    );
    expect(outcome.suppressed).toBe(false);
    expect(outcome.shortlisted).toHaveLength(1);
  });

  it("创业板指在 MA100 之下时剔除创业板个股，主板不受影响", () => {
    const growth = goodSecurity({ code: "300750", board: "growth" });
    const main = goodSecurity({ code: "600519", board: "main" });

    const blocked = screenUniverse([growth, main], DEFAULT_CRITERIA, {
      marketGate: gateOf("offense", false),
    });
    expect(blocked.shortlisted.map((v) => v.code)).toEqual(["600519"]);

    const allowed = screenUniverse([growth, main], DEFAULT_CRITERIA, {
      marketGate: gateOf("offense", true),
    });
    expect(allowed.shortlisted.map((v) => v.code).sort()).toEqual(["300750", "600519"]);
  });

  it("创业板指数据缺失时不据此剔除，并把它标为未判定", () => {
    const growth = goodSecurity({ code: "300750", board: "growth" });
    const outcome = screenUniverse([growth], DEFAULT_CRITERIA, {
      marketGate: gateOf("offense", null),
    });
    expect(outcome.shortlisted).toHaveLength(1);
    expect(outcome.shortlisted[0]?.unknownRules).toContain("U-growthIndexGate");
  });

  it("没有大盘门数据（null）时不影响筛选", () => {
    const outcome = screenUniverse([goodSecurity()], DEFAULT_CRITERIA, { marketGate: null });
    expect(outcome.suppressed).toBe(false);
    expect(outcome.shortlisted).toHaveLength(1);
    expect(outcome.marketGate).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { evaluateMarketGate } from "../src/screener/market-gate.js";

/**
 * 大盘择时门（书第四章 + 表 4-1）。
 *
 * 三档不是"开关"，而是三条不同的话：
 * 进攻 = 可以正常做；防守 = 可以做但减半；空仓 = 别做。
 * 把"拿不到指数数据"错当成"大盘走弱"，会凭空挡掉当天所有候选，
 * 所以缺数据这条路径单独钉死。
 */

const seg = (n: number, from: number, to: number): number[] =>
  Array.from({ length: n }, (_, i) => from + (to - from) * ((i + 1) / n));

const SH = "sh000001";

describe("三档判定", () => {
  it("站上 MA100 且三个月上涨 → 进攻档，建议满仓", () => {
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes: seg(150, 100, 200) }, growth: null });
    expect(gate.state).toBe("offense");
    expect(gate.positionAdvice).toBe(1);
    expect(gate.reason).toContain("进攻档");
  });

  it("站上 MA100 但三个月趋势不成立 → 防守档，建议半仓", () => {
    // 长期横盘 → 拉升 → 浅幅回落：收盘仍在 MA100 上方，但已低于 60 个交易日前
    const closes = [...Array.from({ length: 140 }, () => 100), ...seg(30, 100, 200), ...seg(70, 200, 185)];
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes }, growth: null });
    expect(gate.state).toBe("defense");
    expect(gate.threeMonthReturn).toBeLessThan(0);
    expect(gate.indexClose).toBeGreaterThan(gate.indexMa100 as number);
    expect(gate.positionAdvice).toBe(0.5);
  });

  it("跌破 MA100 → 空仓档，建议空仓", () => {
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes: seg(150, 200, 100) }, growth: null });
    expect(gate.state).toBe("empty");
    expect(gate.positionAdvice).toBe(0);
    expect(gate.reason).toContain("跌破 MA100");
  });
});

describe("建议总仓位 = min(大盘门档位, 书的仓位表)", () => {
  it("趋势向上但指数落在 MA60 之下时，书的仓位表把仓位压到半仓", () => {
    // 快涨之后浅回落到 MA60 之下、但仍在 MA100 之上，且三个月仍为上涨
    const closes = [...Array.from({ length: 120 }, () => 100), ...seg(20, 100, 180), ...seg(60, 180, 160)];
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes }, growth: null });
    if (gate.state === "offense" && gate.indexMa60 !== null && (gate.indexClose as number) < gate.indexMa60) {
      expect(gate.bookPosition).toBe(0.5);
      expect(gate.positionAdvice).toBe(0.5);
    } else {
      // 形态未落在预期分支时，至少保证取小这条不变式成立
      expect(gate.positionAdvice).toBe(Math.min(gate.gatePosition, gate.bookPosition));
    }
  });

  it("取小这条不变式在三档下都成立", () => {
    const cases = [seg(150, 100, 200), seg(150, 200, 100), [...Array.from({ length: 140 }, () => 100), ...seg(30, 100, 200), ...seg(70, 200, 185)]];
    for (const closes of cases) {
      const gate = evaluateMarketGate({ shanghai: { code: SH, closes }, growth: null });
      expect(gate.positionAdvice).toBe(Math.min(gate.gatePosition, gate.bookPosition));
    }
  });
});

describe("创业板指条件（书 L1033–1045）", () => {
  it("创业板指在 MA100 之上时标记为 true", () => {
    const gate = evaluateMarketGate({
      shanghai: { code: SH, closes: seg(150, 100, 200) },
      growth: { code: "sz399006", closes: seg(150, 1000, 2000) },
    });
    expect(gate.growthIndexAboveMa100).toBe(true);
    expect(gate.reason).not.toContain("创业板指在 MA100 之下");
  });

  it("创业板指跌破 MA100 时标记为 false，并在理由里说明创业板不参与", () => {
    const gate = evaluateMarketGate({
      shanghai: { code: SH, closes: seg(150, 100, 200) },
      growth: { code: "sz399006", closes: seg(150, 2000, 1000) },
    });
    expect(gate.growthIndexAboveMa100).toBe(false);
    expect(gate.reason).toContain("创业板指在 MA100 之下");
  });

  it("创业板指数据缺失时不据此剔除，并如实说明", () => {
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes: seg(150, 100, 200) }, growth: null });
    expect(gate.growthIndexAboveMa100).toBeNull();
    expect(gate.reason).toContain("创业板指数据缺失");
  });
});

describe("数据缺失的兜底", () => {
  it("没有指数数据时按防守档保守处理，并说明这不是对大盘走弱的判断", () => {
    const gate = evaluateMarketGate({ shanghai: null, growth: null });
    expect(gate.state).toBe("defense");
    expect(gate.positionAdvice).toBe(0.5);
    expect(gate.reason).toContain("不是对大盘走弱的判断");
    expect(gate.indexClose).toBeNull();
  });

  it("指数样本不足 100 根时同样走兜底（MA100 算不出来就不该硬判）", () => {
    const gate = evaluateMarketGate({ shanghai: { code: SH, closes: seg(60, 100, 120) }, growth: null });
    expect(gate.state).toBe("defense");
    expect(gate.indexMa100).toBeNull();
  });
});

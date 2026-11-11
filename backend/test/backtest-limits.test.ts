import { describe, expect, it } from "vitest";
import {
  detectLimits,
  hasLimitUpInWindow,
  limitPrice,
  roundToCent,
} from "../src/backtest/limits.js";
import { bar, barsFromCloses } from "./helpers/backtest-fixtures.js";
import { isStName, limitRatiosFor } from "../src/backtest/limits.js";

function pair(close: number, open: number, prev = 10): ReturnType<typeof bar>[] {
  return [
    bar(20210104, prev, { open: prev }),
    bar(20210105, close, { open, high: Math.max(open, close), low: Math.min(open, close) }),
  ];
}

describe("涨停价/跌停价（交易所：前收盘 × (1±比例)，四舍五入到分）", () => {
  it("roundToCent 处理浮点尾差", () => {
    expect(roundToCent(3.03 * 1.1)).toBe(3.33);
    expect(roundToCent(2.45 * 1.1)).toBe(2.7);
    expect(roundToCent(10 * 0.9)).toBe(9);
  });

  it("各幅度按比例算出精确价格", () => {
    expect(limitPrice(10, 0.1, "up")).toBe(11);
    expect(limitPrice(10, 0.2, "up")).toBe(12);
    expect(limitPrice(10, 0.3, "up")).toBe(13);
    expect(limitPrice(2, 0.05, "up")).toBe(2.1);
    expect(limitPrice(10, 0.1, "down")).toBe(9);
  });
});

describe("detectLimits：幅度由板块与当前名称决定", () => {
  it("主板 10%：收盘封板", () => {
    const flags = detectLimits(pair(11, 10.5), { ratios: limitRatiosFor("main", false) });
    expect(flags.upClose[1]).toBe(true);
    expect(flags.upRatio[1]).toBe(0.1);
    expect(flags.upOpen[1]).toBe(false);
  });

  it("主板 ST 5%：按名称判定后使用 5% 口径", () => {
    const flags = detectLimits(pair(2.1, 2.05, 2), { ratios: limitRatiosFor("main", isStName("ST某某")) });
    expect(flags.upClose[1]).toBe(true);
    expect(flags.upRatio[1]).toBe(0.05);
  });

  it("创业板 20% / 北交所 30%", () => {
    expect(detectLimits(pair(12, 11, 10), { ratios: limitRatiosFor("growth", false) }).upRatio[1]).toBe(0.2);
    expect(detectLimits(pair(13, 12, 10), { ratios: limitRatiosFor("bj", false) }).upRatio[1]).toBe(0.3);
  });

  it("普通股 +5% 不是涨停（不臆测 ST 的 5% 板）", () => {
    const flags = detectLimits(pair(10.5, 10.2), { ratios: limitRatiosFor("main", false) });
    expect(flags.upClose[1]).toBe(false);
    expect(flags.upRatio[1]).toBeNull();
  });

  it("板块未知时默认不含 5% 候选，避免假阳性", () => {
    expect(detectLimits(pair(10.5, 10.2)).upClose[1]).toBe(false);
    expect(detectLimits(pair(11, 10.5)).upRatio[1]).toBe(0.1);
  });

  it("开盘即涨停（一字板）标记为不可买入", () => {
    const flags = detectLimits(pair(11, 11), { ratios: [0.1] });
    expect(flags.upOpen[1]).toBe(true);
  });

  it("开盘 10% 但收盘没封住 → 不算涨停收盘，但仍是不可买入的开盘涨停", () => {
    const flags = detectLimits(pair(10.5, 11), { ratios: [0.1] });
    expect(flags.upOpen[1]).toBe(true);
    expect(flags.upClose[1]).toBe(false);
    expect(flags.upRatio[1]).toBeNull();
  });

  it("跌停：收盘封板与开盘即跌停", () => {
    const closed = detectLimits(pair(9, 9.5), { ratios: [0.1] });
    expect(closed.downClose[1]).toBe(true);
    const open = detectLimits(pair(9, 9), { ratios: [0.1] });
    expect(open.downOpen[1]).toBe(true);
  });

  it("四舍五入后的涨停价能被识别（3.03 → 3.33）", () => {
    const flags = detectLimits(pair(3.33, 3.2, 3.03), { ratios: [0.1] });
    expect(flags.upClose[1]).toBe(true);
    expect(flags.upRatio[1]).toBe(0.1);
  });

  it("普通涨幅不是涨停（+4%）", () => {
    const flags = detectLimits(pair(10.4, 10.2), { ratios: [0.1] });
    expect(flags.upClose[1]).toBe(false);
    expect(flags.upRatio[1]).toBeNull();
  });

  it("首根 K 线没有前收盘，一律 false", () => {
    const flags = detectLimits(barsFromCloses([11]));
    expect(flags.upClose[0]).toBe(false);
    expect(flags.downClose[0]).toBe(false);
  });
});

describe("hasLimitUpInWindow", () => {
  it("按窗口判定是否出现过涨停，窗口滑过即失效", () => {
    const flags = [false, true, false, false, false, false];
    expect(hasLimitUpInWindow(flags, 1, 3)).toBe(true);
    expect(hasLimitUpInWindow(flags, 3, 3)).toBe(true);
    expect(hasLimitUpInWindow(flags, 4, 3)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  adjustedOhlc,
  chineseSma,
  crossFlags,
  kdjSeries,
} from "../src/backtest/kdj.js";
import { bar, barsFromCloses, tradingDates } from "./helpers/backtest-fixtures.js";

describe("chineseSma（通达信 SMA(X,N,M)）", () => {
  it("首个有效值直接取 X，之后按 M/N 权重递推", () => {
    const out = chineseSma([10, 20, 30], 3, 1);
    expect(out[0]).toBeCloseTo(10, 10);
    expect(out[1]).toBeCloseTo((20 + 2 * 10) / 3, 10);
    expect(out[2]).toBeCloseTo((30 + 2 * ((20 + 2 * 10) / 3)) / 3, 10);
  });

  it("默认权重为 1（即 2/3 旧值平滑），而不是 EMA 的 2/(N+1)", () => {
    const out = chineseSma([100, 0, 0, 0], 3);
    // EMA(3) 会在第二根衰减到 50；通达信 SMA 衰减到 66.67
    expect(out[1]).toBeCloseTo(200 / 3, 10);
    expect(out[2]).toBeCloseTo(400 / 9, 10);
  });

  it("空洞不破坏递推：null 处输出 null，但保留前值继续算", () => {
    const out = chineseSma([10, null, 30], 3, 1);
    expect(out[0]).toBe(10);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo((30 + 2 * 10) / 3, 10);
  });

  it("非法参数抛错", () => {
    expect(() => chineseSma([1], 0, 1)).toThrow();
    expect(() => chineseSma([1], 3, 4)).toThrow();
  });
});

describe("kdjSeries", () => {
  it("RSV 前 period−1 根不可计算，输出 null", () => {
    const series = kdjSeries(barsFromCloses([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]));
    for (let i = 0; i < 8; i++) {
      expect(series.rsv[i]).toBeNull();
      expect(series.k[i]).toBeNull();
    }
    expect(series.rsv[8]).not.toBeNull();
  });

  it("区间为零时 RSV 取 50 中性值（一字板不会产生 NaN）", () => {
    const flat = tradingDates(12).map((date) => bar(date, 10, { open: 10, high: 10, low: 10 }));
    const series = kdjSeries(flat);
    expect(series.rsv[11]).toBe(50);
    expect(series.k[11]).toBeCloseTo(50, 10);
    expect(series.d[11]).toBeCloseTo(50, 10);
    expect(series.j[11]).toBeCloseTo(50, 10);
    expect(Number.isNaN(series.k[11] as number)).toBe(false);
  });

  it("J = 3K − 2D", () => {
    const series = kdjSeries(barsFromCloses([10, 9, 11, 12, 10, 13, 14, 9, 15, 16, 17, 18]));
    const index = 11;
    expect(series.j[index]).toBeCloseTo(
      3 * (series.k[index] as number) - 2 * (series.d[index] as number),
      10,
    );
  });

  it("指标算在后复权价上：整体因子不影响 RSV，除权日的因子跳变被抹平", () => {
    const closes = [10, 10.5, 11, 10.8, 11.2, 11.5, 11.1, 11.8, 12, 12.2, 12.5];
    const left = barsFromCloses(closes);
    const right = barsFromCloses(closes).map((item) => ({
      ...item,
      high: item.high * 2,
      low: item.low * 2,
      close: item.close * 2,
      adjFactor: 0.5,
      open: item.open * 2,
    }));
    const a = kdjSeries(left);
    const b = kdjSeries(right);
    for (let i = 0; i < closes.length; i++) {
      expect(b.k[i]).toBeCloseTo(a.k[i] as number, 8);
      expect(b.d[i]).toBeCloseTo(a.d[i] as number, 8);
    }
  });

  it("adjustedOhlc 把三个价格都乘上因子", () => {
    const [item] = [bar(20210104, 10, { high: 11, low: 9, adjFactor: 1.5 })];
    const { highs, lows, closes } = adjustedOhlc([item]);
    expect(closes[0]).toBeCloseTo(15);
    expect(highs[0]).toBeCloseTo(16.5);
    expect(lows[0]).toBeCloseTo(13.5);
  });
});

describe("crossFlags", () => {
  it("上穿记为金叉、下穿记为死叉", () => {
    const k = [1, 2, 3, 2, 1, 2, 3];
    const d = [2, 2, 2, 2, 2, 2, 2];
    const flags = crossFlags(k, d);
    expect(flags.golden[2]).toBe(true);
    expect(flags.death[4]).toBe(true);
    expect(flags.golden[5]).toBe(false);
  });

  it("K 与 D 长期相等（一字板）不被误判为连续交叉", () => {
    const k = [50, 50, 50, 50, 51];
    const d = [50, 50, 50, 50, 50];
    const flags = crossFlags(k, d);
    expect(flags.golden.filter(Boolean)).toHaveLength(1);
    expect(flags.golden[4]).toBe(true);
  });

  it("null 区间不产生信号", () => {
    const flags = crossFlags([null, null, 1], [null, null, 2]);
    expect(flags.golden.some(Boolean)).toBe(false);
    expect(flags.death.some(Boolean)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  adjustedCloses,
  adjustedPrice,
  countCrossings,
  fallingTrendlineAt,
  findSwingHighs,
  findSwingLows,
  isOneWordBoard,
  limitUpFlags,
  limitUpPrice,
  limitUpRatio,
  rangeBounds,
  smaSeries,
  trendR2,
} from "../src/screener/structure.js";
import { bar, bars } from "./helpers/screener-fixtures.js";

describe("复权换算", () => {
  it("后复权价 = 不复权价 × 因子", () => {
    expect(adjustedPrice(10, 3)).toBeCloseTo(30, 10);
    expect(adjustedCloses(bars([10, 20], { adjFactor: 2 }))).toEqual([20, 40]);
  });
});

describe("smaSeries", () => {
  it("与输入同长度对齐，前 period-1 位为 null", () => {
    const out = smaSeries([1, 2, 3, 4, 5], 3);
    expect(out).toHaveLength(5);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).toBeCloseTo(2, 10); // (1+2+3)/3
    expect(out[3]).toBeCloseTo(3, 10);
    expect(out[4]).toBeCloseTo(4, 10);
  });

  it("样本不足时全部为 null（而不是返回短数组导致下标错位）", () => {
    expect(smaSeries([1, 2], 5)).toEqual([null, null]);
  });
});

describe("显著高低点", () => {
  // 三角形序列：在 index 10 处形成最高点，在 index 5 处形成最低点
  const closes = [...Array.from({ length: 11 }, (_, i) => i), ...Array.from({ length: 10 }, (_, i) => 10 - i - 1)];
  const series = bars(closes);

  it("识别出中间的最高点，并排除末尾来不及确认的几根", () => {
    const highs = findSwingHighs(series, 3);
    expect(highs.map((p) => p.index)).toContain(10);
    expect(highs.every((p) => p.index <= series.length - 4)).toBe(true);
  });

  it("识别出 V 形底部的局部最低点", () => {
    const vShape = [
      ...Array.from({ length: 15 }, (_, i) => 20 - i),
      ...Array.from({ length: 15 }, (_, i) => 7 + i),
    ];
    const lows = findSwingLows(bars(vShape), 3);
    expect(lows.map((p) => p.index)).toContain(14);
    expect(lows.find((p) => p.index === 14)?.price).toBeCloseTo(6 * 0.99, 2);
  });

  it("单调上涨序列没有显著高点（右侧总有更高的）", () => {
    const rising = bars(Array.from({ length: 30 }, (_, i) => 10 + i));
    expect(findSwingHighs(rising, 3)).toEqual([]);
  });

  it("单调下跌序列没有显著高点（左侧总有更高的）——这正是不能对跌势硬凑趋势线的原因", () => {
    const falling = bars(Array.from({ length: 30 }, (_, i) => 20 - i * 0.1));
    expect(findSwingHighs(falling, 3)).toEqual([]);
  });
});

describe("下降趋势线", () => {
  /** 下跌中带反弹的锯齿：只有这种形状才会产生"依次降低的显著高点" */
  const zigzag = (n: number) =>
    bars(Array.from({ length: n }, (_, i) => 20 - i * 0.05 + 0.25 * Math.sin(i / 2)));

  it("依次降低的显著高点连成下降线，且延长到当前时高于收盘", () => {
    const series = zigzag(80);
    const line = fallingTrendlineAt(series, 3, 60);
    const last = series[series.length - 1]!.close;
    expect(line).not.toBeNull();
    expect(line as number).toBeGreaterThan(last);
  });

  it("上涨序列不构成下降趋势线（返回 null，而不是硬凑一条压力线）", () => {
    const series = bars(Array.from({ length: 80 }, (_, i) => 10 + i * 0.05));
    expect(fallingTrendlineAt(series, 3, 60)).toBeNull();
  });

  it("显著高点不足两个时返回 null", () => {
    expect(fallingTrendlineAt(bars([10, 10.1, 10.2]), 3, 60)).toBeNull();
  });
});

describe("震荡区间", () => {
  it("给出上下沿、带宽与净位移", () => {
    const series = bars([10, 10.5, 11, 10.5, 10.2]);
    const r = rangeBounds(series, 4);
    expect(r).not.toBeNull();
    expect(r!.low).toBeLessThan(r!.high);
    expect(r!.width).toBeGreaterThan(0);
    expect(r!.progress).toBeGreaterThanOrEqual(0);
  });

  it("区间不含最后一根，否则「突破上沿」永远不成立", () => {
    // 前 5 根横在 10 附近，最后一根跳到 12
    const series = bars([10, 10.05, 9.95, 10.02, 9.98, 12]);
    const r = rangeBounds(series, 5);
    expect(r!.high).toBeLessThan(12);
    expect(series[series.length - 1]!.close).toBeGreaterThan(r!.high);
  });

  it("样本不足返回 null", () => {
    expect(rangeBounds(bars([10, 11]), 60)).toBeNull();
  });
});

describe("穿越计数", () => {
  it("稳定位于参考线之上时不产生穿越", () => {
    const values = [10, 11, 12, 13, 14];
    const ref = [9, 9, 9, 9, 9];
    expect(countCrossings(values, ref, 5)).toBe(0);
  });

  it("反复上下穿越时计数增加", () => {
    const values = [11, 9, 11, 9, 11, 9, 11];
    const ref = [10, 10, 10, 10, 10, 10, 10];
    expect(countCrossings(values, ref, 7)).toBe(6);
  });

  it("参考线为 null 的区间被跳过而不是当成 0", () => {
    const values = [11, 12, 13];
    const ref = [null, null, 10];
    expect(countCrossings(values, ref, 3)).toBe(0);
  });
});

describe("涨停判定", () => {
  it("幅度按板块：主板 10%、创业板 / 科创板 20%、北交所 30%", () => {
    expect(limitUpRatio("main")).toBeCloseTo(0.1, 10);
    expect(limitUpRatio("growth")).toBeCloseTo(0.2, 10);
    expect(limitUpRatio("star")).toBeCloseTo(0.2, 10);
    expect(limitUpRatio("bj")).toBeCloseTo(0.3, 10);
  });

  it("涨停价四舍五入到分", () => {
    expect(limitUpPrice(10, "main")).toBeCloseTo(11, 10);
    expect(limitUpPrice(11.35, "main")).toBeCloseTo(12.49, 10); // 12.485 → 12.49
    expect(limitUpPrice(10, "growth")).toBeCloseTo(12, 10);
    expect(limitUpPrice(10, "bj")).toBeCloseTo(13, 10);
  });

  it("标记收盘达涨停的交易日，首根不判定", () => {
    const series = [
      bar(10, { high: 10.1, low: 9.9 }),
      bar(11, { high: 11, low: 10.5 }), // 10 × 1.1 = 11 → 涨停
      bar(11.2, { high: 11.3, low: 11 }),
    ];
    expect(limitUpFlags(series, "main")).toEqual([false, true, false]);
  });

  it("一字板识别", () => {
    expect(isOneWordBoard(bar(10, { high: 10, low: 10 }))).toBe(true);
    expect(isOneWordBoard(bar(10, { high: 10.1, low: 9.9 }))).toBe(false);
  });
});

describe("走势流畅度 R²", () => {
  it("平滑指数走势的 R² 很高", () => {
    const smooth = bars(Array.from({ length: 30 }, (_, i) => 10 * 1.01 ** i));
    expect(trendR2(smooth, 20) as number).toBeGreaterThan(0.99);
  });

  it("来回震荡的 R² 明显更低", () => {
    const noisy = bars(Array.from({ length: 30 }, (_, i) => 10 + 0.5 * Math.sin(i)));
    expect(trendR2(noisy, 20) as number).toBeLessThan(0.5);
  });

  it("样本不足返回 null", () => {
    expect(trendR2(bars([10, 11]), 20)).toBeNull();
  });
});

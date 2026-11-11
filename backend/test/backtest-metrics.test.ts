import { describe, expect, it } from "vitest";
import {
  bucketByBoard,
  bucketByYear,
  bucketTrades,
  quantile,
  returnHistogram,
  summarize,
} from "../src/backtest/metrics.js";
import type { StockResult, Trade } from "../src/backtest/types.js";

function trade(overrides: Partial<Trade>): Trade {
  return {
    code: "600000",
    signalDate: 20210104,
    entryDate: 20210105,
    entryPrice: 10,
    exitDate: 20210120,
    exitPrice: 11,
    shares: 1000,
    entryDelay: 0,
    holdingDays: 10,
    cost: 10_000,
    proceeds: 11_000,
    fees: 0,
    grossReturn: 0.1,
    netReturn: 0.1,
    openAtEnd: false,
    ...overrides,
  };
}

function result(overrides: Partial<StockResult> = {}): StockResult {
  return {
    code: "600000",
    name: "测试",
    board: "main",
    startDate: 20210104,
    endDate: 20211231,
    initialEquity: 100_000,
    finalEquity: 110_000,
    totalReturn: 0.1,
    maxDrawdown: 0.05,
    buyHoldReturn: 0.08,
    trades: [],
    eligibleSignals: 1,
    unfilledSignals: 0,
    equityCurve: [],
    ...overrides,
  };
}

describe("quantile", () => {
  it("线性插值，边界取端点", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5);
    expect(quantile([1, 2, 3, 4], 0)).toBe(1);
    expect(quantile([1, 2, 3, 4], 1)).toBe(4);
    expect(quantile([], 0.5)).toBeNull();
  });
});

describe("summarize", () => {
  it("胜率、盈亏比、最差单笔、买卖持有对照都按传入集合统计", () => {
    const withTrades = result({
      code: "600001",
      totalReturn: 0.1,
      buyHoldReturn: 0.08,
      trades: [
        trade({ netReturn: 0.1, holdingDays: 10 }),
        trade({ netReturn: -0.05, holdingDays: 4, openAtEnd: false }),
        trade({ netReturn: 0.02, holdingDays: 6, openAtEnd: true }),
      ],
    });
    const noTrades = result({ code: "600002", totalReturn: -0.02, buyHoldReturn: 0.03, trades: [] });
    const summary = summarize([withTrades, noTrades]);

    expect(summary.stocks).toBe(2);
    expect(summary.tradedStocks).toBe(1);
    expect(summary.trades).toBe(3);
    expect(summary.openTrades).toBe(1);
    expect(summary.wins).toBe(2);
    expect(summary.winRate).toBeCloseTo(2 / 3);
    expect(summary.profitFactor).toBeCloseTo((0.1 + 0.02) / 0.05);
    expect(summary.maxLoss).toBeCloseTo(-0.05);
    expect(summary.avgHoldingDays).toBeCloseTo(20 / 3);
    expect(summary.avgTotalReturn).toBeCloseTo(0.04);
    expect(summary.avgBuyHold).toBeCloseTo(0.055);
    expect(summary.beatBuyHoldStocks).toBe(1);
    expect(summary.stocksWithBuyHold).toBe(2);
    expect(summary.avgMaxDrawdown).toBeCloseTo(0.05);
  });

  it("无交易时比率类指标为 null，而不是 NaN 或 0", () => {
    const summary = summarize([result({ trades: [] })]);
    expect(summary.winRate).toBeNull();
    expect(summary.avgNetReturn).toBeNull();
    expect(summary.profitFactor).toBeNull();
    expect(summary.maxLoss).toBeNull();
    expect(summary.avgHoldingDays).toBeNull();
  });
});

describe("bucketTrades / bucketByYear / bucketByBoard", () => {
  it("按买入年份分桶：同一只票跨年的交易落进不同桶", () => {
    const r = result({
      trades: [
        trade({ entryDate: 20210105, netReturn: 0.1 }),
        trade({ entryDate: 20210601, netReturn: -0.08 }),
        trade({ entryDate: 20220301, netReturn: 0.2 }),
      ],
    });
    const buckets = bucketByYear([r]);
    expect(buckets.map((bucket) => bucket.key)).toEqual(["2021", "2022"]);
    expect(buckets[0]?.trades).toBe(2);
    expect(buckets[0]?.winRate).toBeCloseTo(0.5);
    expect(buckets[1]?.avgNetReturn).toBeCloseTo(0.2);
  });

  it("按板块分桶并使用中文标签", () => {
    const results = [
      result({ board: "main", trades: [trade({})] }),
      result({ board: "growth", trades: [trade({}), trade({ netReturn: -0.1 })] }),
    ];
    const buckets = bucketByBoard(results);
    expect(buckets.map((bucket) => bucket.key)).toEqual(["主板", "创业板"]);
    expect(buckets.find((bucket) => bucket.key === "创业板")?.trades).toBe(2);
  });

  it("自定义键函数", () => {
    const buckets = bucketTrades([result({ trades: [trade({ holdingDays: 3 }), trade({ holdingDays: 30 })] })], (t) => (t.holdingDays > 10 ? "长" : "短"));
    expect(buckets.map((bucket) => bucket.key)).toEqual(["短", "长"]);
  });
});

describe("returnHistogram", () => {
  it("桶计数总和等于交易数，边界覆盖极值", () => {
    const r = result({
      trades: [
        trade({ netReturn: -0.12 }),
        trade({ netReturn: -0.01 }),
        trade({ netReturn: 0.03 }),
        trade({ netReturn: 0.21 }),
      ],
    });
    const buckets = returnHistogram([r], 0.05);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(4);
    expect(buckets[0]?.from).toBeLessThanOrEqual(-0.12);
    expect((buckets[buckets.length - 1] as { to: number }).to).toBeGreaterThanOrEqual(0.21);
  });

  it("无交易时返回空数组", () => {
    expect(returnHistogram([result()])).toEqual([]);
  });
});

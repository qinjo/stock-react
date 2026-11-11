import { describe, expect, it } from "vitest";
import {
  backtestStock,
  buyFees,
  maxBuyableShares,
  sellFees,
} from "../src/backtest/engine.js";
import { crossFlags, kdjSeries } from "../src/backtest/kdj.js";
import { limitPrice } from "../src/backtest/limits.js";
import { DEFAULT_BACKTEST_PARAMS } from "../src/backtest/params.js";
import type { BacktestParams, StockResult } from "../src/backtest/types.js";
import { barsFromCloses } from "./helpers/backtest-fixtures.js";
import type { DailyBar } from "../src/screener/types.js";

/**
 * 一段能自然产生「金叉 → 上涨 → 死叉」的收盘序列：
 * 先阴跌 12 根，再上涨 12 根，再下跌 10 根。
 */
function scenarioCloses(): number[] {
  const closes: number[] = [];
  for (let i = 0; i < 12; i++) closes.push(12 - i * 0.3);
  for (let i = 0; i < 12; i++) closes.push((8.7 - 11 * 0.3) + 0.55 * (i + 1));
  for (let i = 0; i < 10; i++) closes.push(15.2 - 0.55 * (i + 1));
  return closes;
}

function params(overrides: Partial<BacktestParams> = {}): BacktestParams {
  return { ...DEFAULT_BACKTEST_PARAMS, minBars: 20, capital: 100_000, ...overrides };
}

function run(bars: DailyBar[], p = params(), eligibleAll = true): StockResult {
  const eligible = new Array(bars.length).fill(eligibleAll);
  const result = backtestStock(
    { code: "600000", name: "测试", board: "main", bars, eligible },
    { params: p, fromDate: (bars[0] as DailyBar).date, toDate: (bars[bars.length - 1] as DailyBar).date, keepEquityCurve: true },
  );
  if (result === null) throw new Error("回测结果为空");
  return result;
}

function firstCrosses(bars: DailyBar[]): { golden: number; death: number } {
  const kdj = kdjSeries(bars, {
    period: DEFAULT_BACKTEST_PARAMS.kdjPeriod,
    kSmooth: DEFAULT_BACKTEST_PARAMS.kdjKSmooth,
    dSmooth: DEFAULT_BACKTEST_PARAMS.kdjDSmooth,
  });
  const flags = crossFlags(kdj.k, kdj.d);
  const golden = flags.golden.findIndex(Boolean);
  const death = flags.death.findIndex((value, index) => value && index > golden);
  if (golden < 0 || death < 0) throw new Error("测试序列没有产生金叉/死叉");
  return { golden, death };
}

describe("费用与整手", () => {
  it("买入费用 = 佣金（最低 5 元）+ 过户费", () => {
    const p = params();
    // 10 万元 × 万 2.5 = 25 元 > 5 元最低值
    expect(buyFees(100_000, p)).toBeCloseTo(25 + 1, 6);
    // 小额按最低 5 元收
    expect(buyFees(10_000, p)).toBeCloseTo(5 + 0.1, 6);
  });

  it("卖出费用额外加印花税", () => {
    const p = params();
    expect(sellFees(100_000, p)).toBeCloseTo(buyFees(100_000, p) + 50, 6);
  });

  it("整手取整，且把费用算进预算", () => {
    const p = params();
    // 10 元股价、10 万现金：不止能买 10000 股（要留费用）
    const shares = maxBuyableShares(100_000, 10, p);
    expect(shares % p.lotSize).toBe(0);
    expect(shares).toBeLessThanOrEqual(9_900);
    expect(shares * 10 + buyFees(shares * 10, p)).toBeLessThanOrEqual(100_000 + 1e-9);
    expect(maxBuyableShares(50, 10, p)).toBe(0);
  });
});

describe("backtestStock：成交时点与费用", () => {
  it("金叉次日开盘买入、死叉次日开盘卖出，费用按口径扣除", () => {
    const bars = barsFromCloses(scenarioCloses());
    const { golden, death } = firstCrosses(bars);
    const p = params();
    const result = run(bars, p);
    const trade = result.trades[0];
    if (!trade) throw new Error("没有产生交易");

    const entryBar = bars[golden + 1] as DailyBar;
    const exitBar = bars[death + 1] as DailyBar;
    expect(trade.signalDate).toBe((bars[golden] as DailyBar).date);
    expect(trade.entryDate).toBe(entryBar.date);
    expect(trade.entryPrice).toBeCloseTo(entryBar.open, 10);
    expect(trade.exitDate).toBe(exitBar.date);
    expect(trade.exitPrice).toBeCloseTo(exitBar.open, 10);
    expect(trade.entryDelay).toBe(0);
    expect(trade.holdingDays).toBe(death + 1 - (golden + 1));

    const shares = maxBuyableShares(p.capital, entryBar.open, p);
    expect(trade.shares).toBe(shares);
    expect(trade.cost).toBeCloseTo(shares * entryBar.open + buyFees(shares * entryBar.open, p), 6);
    const proceeds = shares * exitBar.open - sellFees(shares * exitBar.open, p);
    expect(trade.proceeds).toBeCloseTo(proceeds, 6);
    expect(trade.netReturn).toBeCloseTo((proceeds - trade.cost) / trade.cost, 10);
  });

  it("买入当日不可能卖出（T+1 由「信号在收盘、成交在次日开盘」保证）", () => {
    const bars = barsFromCloses(scenarioCloses());
    const result = run(bars);
    for (const trade of result.trades) {
      expect(trade.holdingDays).toBeGreaterThanOrEqual(1);
      expect(trade.exitDate).toBeGreaterThan(trade.entryDate);
    }
  });

  it("权益曲线逐日盯市，最大回撤不超过 100%", () => {
    const result = run(barsFromCloses(scenarioCloses()));
    expect(result.equityCurve.length).toBeGreaterThan(0);
    expect(result.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(result.maxDrawdown).toBeLessThan(1);
    expect(result.finalEquity).toBeCloseTo(
      (result.equityCurve[result.equityCurve.length - 1] as { equity: number }).equity,
      6,
    );
  });

  it("买入持有基准按后复权价计算", () => {
    const bars = barsFromCloses(scenarioCloses()).map((item, i) => ({
      ...item,
      adjFactor: 1 + i * 0.01,
    }));
    const result = run(bars);
    const first = bars[0] as DailyBar;
    const last = bars[bars.length - 1] as DailyBar;
    expect(result.buyHoldReturn).toBeCloseTo(
      (last.close * last.adjFactor) / (first.open * first.adjFactor) - 1,
      10,
    );
  });
});

describe("backtestStock：涨跌停不可成交", () => {
  it("金叉次日开盘涨停 → 顺延到下一个能成交的开盘", () => {
    const base = barsFromCloses(scenarioCloses());
    const { golden } = firstCrosses(base);
    const bars = base.map((item) => ({ ...item }));
    // 把金叉次日的开盘价改成涨停价（只改 open，不动高/低/收，KDJ 不受影响）
    const prevClose = (bars[golden] as DailyBar).close;
    (bars[golden + 1] as DailyBar).open = limitPrice(prevClose, 0.1, "up");

    const result = run(bars);
    const trade = result.trades[0];
    if (!trade) throw new Error("没有产生交易");
    expect(trade.entryDate).toBe((bars[golden + 2] as DailyBar).date);
    expect(trade.entryDelay).toBe(1);
    expect(trade.entryPrice).toBeCloseTo((bars[golden + 2] as DailyBar).open, 10);
  });

  it("死叉次日开盘跌停 → 顺延卖出", () => {
    const base = barsFromCloses(scenarioCloses());
    const { death } = firstCrosses(base);
    const bars = base.map((item) => ({ ...item }));
    const prevClose = (bars[death] as DailyBar).close;
    (bars[death + 1] as DailyBar).open = limitPrice(prevClose, 0.1, "down");

    const result = run(bars);
    const trade = result.trades[0];
    if (!trade) throw new Error("没有产生交易");
    expect(trade.exitDate).toBe((bars[death + 2] as DailyBar).date);
    expect(trade.exitPrice).toBeCloseTo((bars[death + 2] as DailyBar).open, 10);
  });

  it("一直涨停到期末 → 信号始终未能成交，如实计数", () => {
    const base = barsFromCloses(scenarioCloses());
    const { golden } = firstCrosses(base);
    const bars = base.map((item) => ({ ...item }));
    for (let i = golden + 1; i < bars.length; i++) {
      const prevClose = (bars[i - 1] as DailyBar).close;
      (bars[i] as DailyBar).open = limitPrice(prevClose, 0.1, "up");
    }
    const result = run(bars);
    expect(result.trades).toHaveLength(0);
    expect(result.eligibleSignals).toBeGreaterThanOrEqual(1);
    expect(result.unfilledSignals).toBeGreaterThanOrEqual(1);
  });

  it("宇宙不满足时的金叉不产生买入", () => {
    const bars = barsFromCloses(scenarioCloses());
    const result = run(bars, params(), false);
    expect(result.trades).toHaveLength(0);
    expect(result.eligibleSignals).toBe(0);
  });
});

describe("backtestStock：复权口径（持有期内送转/拆股）", () => {
  it("1:2 拆股不会把收益记成暴跌：卖出侧按复权因子比例换算", () => {
    const base = barsFromCloses(scenarioCloses());
    const { golden } = firstCrosses(base);
    const baseline = run(base);

    // 在金叉之后的持有期内插入拆股：真实价腰斩、因子翻倍，后复权价不变（KDJ 因此不变）
    const splitIndex = golden + 3;
    const bars = base.map((item, index) =>
      index < splitIndex
        ? item
        : {
            ...item,
            open: item.open / 2,
            high: item.high / 2,
            low: item.low / 2,
            close: item.close / 2,
            adjFactor: 2,
          },
    );
    const adjusted = run(bars);

    const before = baseline.trades[0];
    const after = adjusted.trades[0];
    if (!before || !after) throw new Error("没有产生交易");
    expect(after.entryDate).toBe(before.entryDate);
    expect(after.exitDate).toBe(before.exitDate);
    // 若不做复权换算，这里会接近 −50%
    expect(after.grossReturn).toBeCloseTo(before.grossReturn, 4);
    expect(after.netReturn).toBeCloseTo(before.netReturn, 4);
  });
});

describe("backtestStock：未来函数防线", () => {
  it("截断序列上的已完成交易与全量序列完全一致（指标只看过去）", () => {
    const bars = barsFromCloses(scenarioCloses());
    const full = run(bars);
    const cut = Math.floor(bars.length * 0.85); // 取一段中期数据，让前几笔交易已经平仓
    const partial = run(bars.slice(0, cut));

    const fullClosed = full.trades.filter((trade) => !trade.openAtEnd && trade.exitDate <= (bars[cut - 1] as DailyBar).date);
    const partialClosed = partial.trades.filter((trade) => !trade.openAtEnd);
    expect(partialClosed.length).toBeGreaterThan(0);
    for (let i = 0; i < partialClosed.length; i++) {
      expect(partialClosed[i]).toEqual(fullClosed[i]);
    }
  });

  it("区间内 K 线不足时返回 null（不参与统计）", () => {
    const bars = barsFromCloses(scenarioCloses()).slice(0, 10);
    const result = backtestStock(
      { code: "600000", name: null, board: "main", bars, eligible: new Array(bars.length).fill(true) },
      { params: params({ minBars: 30 }), fromDate: (bars[0] as DailyBar).date, toDate: (bars[9] as DailyBar).date },
    );
    expect(result).toBeNull();
  });

  it("eligible 长度与日线不一致时返回 null（契约检查）", () => {
    const bars = barsFromCloses(scenarioCloses());
    const result = backtestStock(
      { code: "600000", name: null, board: "main", bars, eligible: [] },
      { params: params(), fromDate: (bars[0] as DailyBar).date, toDate: (bars[bars.length - 1] as DailyBar).date },
    );
    expect(result).toBeNull();
  });
});

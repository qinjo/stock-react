import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MarketStore } from "../src/market/store.js";
import {
  buildAmountRankIndex,
  eligibilityFlags,
  eligibilityForBars,
} from "../src/backtest/universe.js";
import { bar, barsFromCloses } from "./helpers/backtest-fixtures.js";

function tempStore(): MarketStore {
  const dir = mkdtempSync(join(tmpdir(), "backtest-universe-"));
  const store = new MarketStore(join(dir, "kline.sqlite"));
  store.migrate();
  return store;
}

describe("buildAmountRankIndex（成交额排名的热门代理）", () => {
  it("每日取成交额前 N，且只包含当天有成交的标的", () => {
    const store = tempStore();
    try {
      store.upsertInstruments([
        { code: "600000", market: "sh", board: "main", name: "甲", listedStart: 20210104, listedEnd: 20210105, isLive: true },
        { code: "600001", market: "sh", board: "main", name: "乙", listedStart: 20210104, listedEnd: 20210105, isLive: true },
        { code: "600002", market: "sh", board: "main", name: "丙", listedStart: 20210104, listedEnd: 20210104, isLive: false },
      ]);
      store.insertBars("600000", [bar(20210104, 10, { amount: 1_000 }), bar(20210105, 10, { amount: 5_000 })]);
      store.insertBars("600001", [bar(20210104, 10, { amount: 9_000 }), bar(20210105, 10, { amount: 1_000 })]);
      // 丙只在第一天有成交
      store.insertBars("600002", [bar(20210104, 10, { amount: 500 })]);

      const index = buildAmountRankIndex(store, [20210104, 20210105], 2);
      expect([...(index.get(20210104) ?? [])].sort()).toEqual(["600000", "600001"]);
      expect([...(index.get(20210105) ?? [])].sort()).toEqual(["600000", "600001"]);
      expect([...(index.get(20210105) ?? [])]).not.toContain("600002");

      // 换成 Top-1：5 号只剩成交额更大的 600000
      const top1 = buildAmountRankIndex(store, [20210105], 1);
      expect([...(top1.get(20210105) ?? [])]).toEqual(["600000"]);
    } finally {
      store.close();
    }
  });

  it("topN 大于当日标的数时取全部", () => {
    const store = tempStore();
    try {
      store.insertBars("600000", [bar(20210104, 10, { amount: 1 })]);
      const index = buildAmountRankIndex(store, [20210104], 100);
      expect([...(index.get(20210104) ?? [])]).toEqual(["600000"]);
    } finally {
      store.close();
    }
  });
});

describe("eligibilityFlags（近 W 日热门 + 涨停）", () => {
  const dates = [20210104, 20210105, 20210106, 20210107, 20210108, 20210111];
  const bars = barsFromCloses([10, 10.2, 10.1, 10.3, 10.4, 10.5], 20210104);

  it("窗口含当日：热门与涨停都在窗口内才成立", () => {
    const hotIndex = new Map([[dates[0] as number, new Set(["600000"])]]);
    const limitUp = [false, true, false, false, false, false];
    const flags = eligibilityFlags(bars, "600000", hotIndex, limitUp, 5);
    // i=4 的窗口 [0..4] 同时含热门(0)与涨停(1) → true
    expect(flags[4]).toBe(true);
    // i=5 的窗口 [1..5] 已经没有热门日 → false
    expect(flags[5]).toBe(false);
    // 窗口不足时不出（i < window-1）
    expect(flags[3]).toBe(false);
  });

  it("只有热门、没有涨停 → 不成立；反之亦然", () => {
    const hotIndex = new Map([[dates[0] as number, new Set(["600000"])]]);
    const noLimitUp = [false, false, false, false, false, false];
    expect(eligibilityFlags(bars, "600000", hotIndex, noLimitUp, 5)[4]).toBe(false);

    const noHot = new Map<number, Set<string>>();
    const limitUp = [false, true, false, false, false, false];
    expect(eligibilityFlags(bars, "600000", noHot, limitUp, 5)[4]).toBe(false);
  });

  it("热门只在别的股票身上 → 不算", () => {
    const hotIndex = new Map([[dates[0] as number, new Set(["600001"])]]);
    const limitUp = [false, true, false, false, false, false];
    expect(eligibilityFlags(bars, "600000", hotIndex, limitUp, 5)[4]).toBe(false);
  });

  it("eligibilityForBars 用真实涨停标记串联（涨停日收盘在涨停价）", () => {
    // 第二根从前收 10 涨到 11 并封住 → 10% 涨停
    const series = barsFromCloses([10, 11, 11.2, 11.4, 11.6, 11.8], 20210104);
    const hotIndex = new Map([[dates[0] as number, new Set(["600000"])]]);
    const flags = eligibilityForBars(series, "600000", hotIndex, 5);
    expect(flags[4]).toBe(true);
    expect(flags[5]).toBe(false);
  });

  it("窗口非法时抛错", () => {
    expect(() => eligibilityFlags(bars, "600000", new Map(), [], 0)).toThrow();
    expect(() => eligibilityFlags(bars, "600000", new Map(), [false], 5)).toThrow();
  });
});

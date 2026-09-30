import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import IndicatorPanel from "./IndicatorPanel";
import type { Indicators } from "../types";

const indicators: Indicators = {
  sampleSize: 250,
  fromDate: "2025-09-10",
  toDate: "2026-09-21",
  sma50: 1300.97,
  sma200: 1335.94,
  priceVsSma50: -3.8,
  priceVsSma200: -6.32,
  ma: {
    ma5: 1268.4,
    ma10: 1275.2,
    ma20: 1282.61,
    ma60: 1310.5,
    ma100: 1327.42,
    ma120: 1330.1,
    ma144: 1333.2,
  },
  priceVsMa100: -5.21,
  weeklyMa20: 1298.76,
  weeklySampleSize: 52,
  rsi14: 37.02,
  macd: { dif: -11.45, dea: -6.12, hist: -5.33 },
  atr14: 19.27,
  atrPercent: 1.54,
  return20d: -4.07,
  return60d: 4.74,
  volatility20d: 12.98,
  periodHigh: 1539.98,
  periodLow: 1151.01,
  positionInRange: 25.9,
};

describe("IndicatorPanel", () => {
  it("展示关键指标数值（此前页面上完全看不到）", () => {
    render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText("1300.97")).toBeInTheDocument(); // SMA50
    expect(screen.getByText("1335.94")).toBeInTheDocument(); // SMA200
    expect(screen.getByText("19.27")).toBeInTheDocument(); // ATR
    expect(screen.getByText("12.98%")).toBeInTheDocument(); // 年化波动率
  });

  it("标注样本区间，便于与行情日期对齐", () => {
    render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText(/250 根日K/)).toBeInTheDocument();
    expect(screen.getByText(/2025-09-10 → 2026-09-21/)).toBeInTheDocument();
  });

  it("RSI 附带分区提示，避免把极端区误读为反转信号", () => {
    const { unmount } = render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText(/中性区/)).toBeInTheDocument();
    unmount();

    render(<IndicatorPanel indicators={{ ...indicators, rsi14: 82 }} />);
    expect(screen.getByText(/超买区/)).toBeInTheDocument();
  });

  it("MACD 柱状图标明多空动能", () => {
    const { unmount } = render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText(/空头动能/)).toBeInTheDocument();
    unmount();

    render(
      <IndicatorPanel indicators={{ ...indicators, macd: { dif: 5, dea: 3, hist: 2 } }} />,
    );
    expect(screen.getByText(/多头动能/)).toBeInTheDocument();
  });

  it("涨跌幅按 A 股习惯配色（正红负绿）", () => {
    render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText("-4.07%")).toHaveClass("text-emerald-600"); // 近20日跌
    expect(screen.getByText("4.74%")).toHaveClass("text-red-600"); // 近60日涨
  });

  it("缺失指标显示占位符而非 NaN/null", () => {
    render(
      <IndicatorPanel
        indicators={{
          ...indicators,
          sma50: null,
          sma200: null,
          rsi14: null,
          macd: { dif: null, dea: null, hist: null },
          atr14: null,
        }}
      />,
    );
    expect(screen.queryByText(/NaN|null|undefined/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(3);
  });

  it("展示区间高低与当前位置", () => {
    render(<IndicatorPanel indicators={indicators} />);
    expect(screen.getByText(/25.9%/)).toBeInTheDocument();
    expect(screen.getByText(/1151.01–1539.98/)).toBeInTheDocument();
  });

  it("展示书的均线阶梯 MA5–MA144，以及 MA100 偏离与周线 MA20", () => {
    render(<IndicatorPanel indicators={indicators} />);
    for (const label of ["MA5", "MA10", "MA20", "MA60", "MA100", "MA120", "MA144"]) {
      expect(screen.getByText(label), label).toBeInTheDocument();
    }
    expect(screen.getByText("1327.42")).toBeInTheDocument(); // MA100
    expect(screen.getByText("-5.21%")).toBeInTheDocument(); // 偏离 MA100
    expect(screen.getByText("1298.76")).toBeInTheDocument(); // 周线 MA20
    expect(screen.getByText(/52 周/)).toBeInTheDocument();
  });

  it("均线缺失时逐条显示占位符，不出现 NaN", () => {
    const empty = { ma5: null, ma10: null, ma20: null, ma60: null, ma100: null, ma120: null, ma144: null };
    render(
      <IndicatorPanel
        indicators={{ ...indicators, ma: empty, priceVsMa100: null, weeklyMa20: null, weeklySampleSize: 3 }}
      />,
    );
    expect(screen.queryByText(/NaN|null|undefined/)).not.toBeInTheDocument();
  });
});

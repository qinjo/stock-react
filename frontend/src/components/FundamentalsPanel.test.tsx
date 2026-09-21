import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import FundamentalsPanel from "./FundamentalsPanel";
import type { Fundamentals } from "../types";

const fundamentals: Fundamentals = {
  periods: [
    {
      reportDate: "2026-06-30",
      reportName: "2026中报",
      revenue: 92278072083.21,
      revenueYoy: 1.3,
      netProfit: 44516880421.86,
      netProfitYoy: -1.95,
      deductedNetProfit: 4.4e10,
      deductedNetProfitYoy: -2.1,
      roe: 16.75,
      grossMargin: 89.56,
      netMargin: 50.75,
      debtRatio: 15.19,
      bps: 200.99,
      eps: 35.57,
      ocfPerShare: 56.55,
    },
    {
      reportDate: "2025-12-31",
      reportName: "2025年报",
      revenue: 172054000000,
      revenueYoy: -1.2,
      netProfit: 82320000000,
      netProfitYoy: -4.53,
      deductedNetProfit: 8.1e10,
      deductedNetProfitYoy: -5,
      roe: 32.53,
      grossMargin: 91.18,
      netMargin: 50.52,
      debtRatio: 16.41,
      bps: 195.36,
      eps: 65.66,
      ocfPerShare: 56.55,
    },
  ],
  valuation: {
    asOf: "2026-09-18",
    pe: {
      current: 17.6,
      y3: { percentile: 0, min: 17.66, median: 22.03, max: 33.71, samples: 730 },
      y5: { percentile: 0, min: 17.66, median: 24.1, max: 45.6, samples: 1215 },
    },
    pb: {
      current: 6.24,
      y3: { percentile: 6.3, min: 5.8, median: 9.1, max: 14.2, samples: 730 },
      y5: { percentile: 3.8, min: 5.5, median: 10.4, max: 18.9, samples: 1215 },
    },
  },
  industry: "白酒Ⅱ",
  peers: {
    industry: "白酒Ⅱ",
    boardCode: "016165",
    tradeDate: "2026-09-18",
    peerCount: 19,
    pe: { median: 25.69, p25: 14.98, p75: 32.48, min: 11.2, max: 45.6, count: 14 },
    pb: { median: 2.29, p25: 1.8, p75: 4.1, min: 1.2, max: 6.8, count: 19 },
    pePremium: -31.5,
    pbPremium: 172.5,
    peRank: 5,
    cheaperPeers: 4,
  },
};

describe("FundamentalsPanel 估值分位", () => {
  it("展示 PE/PB 当前值与近 3 年、近 5 年分位", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    const block = screen.getByTestId("valuation-percentiles");
    expect(block).toHaveTextContent("17.60");
    expect(block).toHaveTextContent("6.24");
    expect(block).toHaveTextContent("近3年");
    expect(block).toHaveTextContent("近5年");
    // PE 处于 0% 分位（历史最低附近）
    expect(block).toHaveTextContent(/（17\.66–33\.71）/);
  });

  it("分位样本不足时显示「样本不足」而非报错", () => {
    render(
      <FundamentalsPanel
        fundamentals={{
          ...fundamentals,
          valuation: {
            asOf: "2026-09-18",
            pe: { current: 17.6, y3: null, y5: null },
            pb: { current: null, y3: null, y5: null },
          },
        }}
      />,
    );
    expect(screen.getAllByText("样本不足").length).toBeGreaterThan(0);
    expect(screen.queryByText(/NaN|undefined/)).not.toBeInTheDocument();
  });
});

describe("FundamentalsPanel 同业对比", () => {
  it("展示行业中位与个股相对溢价/折价", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    const block = screen.getByTestId("peer-comparison");
    expect(block).toHaveTextContent("白酒Ⅱ");
    expect(block).toHaveTextContent("25.69"); // 行业 PE 中位
    expect(block).toHaveTextContent(/本股折价 31\.5%/);
    expect(block).toHaveTextContent(/本股溢价 172\.5%/); // PB 反向
  });

  it("展示行业排名与更便宜的只数", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    const block = screen.getByTestId("peer-comparison");
    expect(block).toHaveTextContent("排第");
    expect(block).toHaveTextContent("5");
    expect(block).toHaveTextContent(/4 只更便宜/);
  });

  it("无同业数据时整块不渲染", () => {
    render(<FundamentalsPanel fundamentals={{ ...fundamentals, peers: null }} />);
    expect(screen.queryByTestId("peer-comparison")).not.toBeInTheDocument();
  });
});

describe("FundamentalsPanel 财务趋势", () => {
  it("以表格展示报告期与关键指标（亿元换算）", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    const block = screen.getByTestId("financial-trend");
    expect(block).toHaveTextContent("2026中报");
    expect(block).toHaveTextContent("922.78"); // 营收亿元
    expect(block).toHaveTextContent("445.17"); // 净利亿元
    expect(block).toHaveTextContent("16.8%"); // ROE（1 位小数）
    expect(block).toHaveTextContent("年内累计");
  });

  it("同比按 A 股习惯配色（正红负绿）", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    const block = screen.getByTestId("financial-trend");
    expect(within(block).getByText("1.3%")).toHaveClass("text-red-600"); // 营收正增长
    expect(within(block).getByText("-1.9%")).toHaveClass("text-emerald-600"); // 净利负增长（-1.95 经 toFixed(1) 得 -1.9）
  });

  it("无财报数据时不渲染表格", () => {
    render(<FundamentalsPanel fundamentals={{ ...fundamentals, periods: [] }} />);
    expect(screen.queryByTestId("financial-trend")).not.toBeInTheDocument();
  });

  it("展示行业与估值截至日（数据时效）", () => {
    render(<FundamentalsPanel fundamentals={fundamentals} />);
    // 行业名在头部与同业块各出现一次
    expect(screen.getAllByText(/白酒Ⅱ/).length).toBeGreaterThan(0);
    expect(screen.getByText(/估值截至 2026-09-18/)).toBeInTheDocument();
  });
});

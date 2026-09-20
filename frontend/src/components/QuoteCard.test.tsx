import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import QuoteCard from "./QuoteCard";
import type { Quote } from "../types";

const quote: Quote = {
  code: "600519",
  name: "贵州茅台",
  price: 1257.12,
  open: 1262.99,
  high: 1265.88,
  low: 1256.1,
  prevClose: 1266.98,
  changePercent: -0.78,
  limitUp: 1393.68,
  limitDown: 1140.28,
  volume: 24891,
  amount: 3135849108,
  marketCap: 1571502582249.12,
  floatMarketCap: 1200000000000,
  pe: 17.65,
  pb: 6.25,
  turnoverRate: 0.2,
};

describe("QuoteCard", () => {
  it("展示身份、价格与涨跌幅", () => {
    render(<QuoteCard quote={quote} />);
    expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    expect(screen.getByText("600519")).toBeInTheDocument();
    expect(screen.getByText("1,257.12")).toBeInTheDocument();
    expect(screen.getByText("-0.78%")).toBeInTheDocument();
  });

  it("大额字段转亿/万可读单位", () => {
    render(<QuoteCard quote={quote} />);
    // 1571502582249.12 / 1e8 = 15,715.03 亿；1200000000000 / 1e8 = 12,000.00 亿；3135849108 / 1e8 = 31.36 亿
    expect(screen.getByText("15,715.03 亿")).toBeInTheDocument();
    expect(screen.getByText("12,000.00 亿")).toBeInTheDocument();
    expect(screen.getByText("31.36 亿")).toBeInTheDocument();
  });

  it("成交量与换手率带单位", () => {
    render(<QuoteCard quote={quote} />);
    expect(screen.getByText("24,891 手")).toBeInTheDocument();
    expect(screen.getByText("0.20%")).toBeInTheDocument();
  });

  it("缺失值显示占位符而非 NaN/undefined", () => {
    const sparse: Quote = {
      ...quote,
      price: null,
      pe: null,
      pb: null,
      turnoverRate: null,
      amount: null,
      marketCap: null,
      volume: null,
      changePercent: null,
    };
    render(<QuoteCard quote={sparse} />);
    expect(screen.queryByText(/NaN|undefined/)).not.toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(3);
  });

  it("展示数据截至日期", () => {
    render(<QuoteCard quote={quote} dataDate="2026-09-18" />);
    expect(screen.getByText(/数据截至：2026-09-18/)).toBeInTheDocument();
  });
});

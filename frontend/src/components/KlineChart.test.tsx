import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { init } from "klinecharts";
import KlineChart, { toKLineData } from "./KlineChart";
import type { Kline } from "../types";

const klines: Kline[] = [
  {
    date: "2026-09-17",
    open: 1257.98,
    close: 1266.98,
    high: 1267.6,
    low: 1254,
    volume: 17554,
    amount: null,
    amplitude: null,
    changePercent: null,
    changeAmount: null,
    turnoverRate: null,
  },
  {
    date: "2026-09-18",
    open: 1262.99,
    close: 1257.12,
    high: 1265.88,
    low: 1256.1,
    volume: 24891,
    amount: null,
    amplitude: null,
    changePercent: null,
    changeAmount: null,
    turnoverRate: null,
  },
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("toKLineData", () => {
  it("把领域 K 线转成 klinecharts 需要的形状（timestamp 为毫秒）", () => {
    const data = toKLineData(klines);
    expect(data).toHaveLength(2);
    expect(data[0]).toMatchObject({ open: 1257.98, close: 1266.98, high: 1267.6, low: 1254, volume: 17554 });
    expect(data[0]!.timestamp).toBe(Date.parse("2026-09-17T00:00:00+08:00"));
    expect(Number.isFinite(data[0]!.timestamp)).toBe(true);
  });
});

describe("KlineChart", () => {
  it("渲染图表容器", () => {
    render(<KlineChart klines={klines} symbol="600519" />);
    expect(screen.getByTestId("kline-container")).toBeInTheDocument();
    expect(screen.getByText("MA50 / MA200")).toBeInTheDocument();
  });

  it("在主图（candle_pane）叠加 SMA50/SMA200", () => {
    render(<KlineChart klines={klines} symbol="600519" />);
    const chart = vi.mocked(init).mock.results.at(-1)!.value as {
      createIndicator: ReturnType<typeof vi.fn>;
    };
    expect(chart.createIndicator).toHaveBeenCalledWith(
      { name: "MA", calcParams: [50, 200], paneId: "candle_pane" },
      false,
    );
  });

  it("设置标的与周期触发按需取数", () => {
    render(<KlineChart klines={klines} symbol="600519" />);
    const chart = vi.mocked(init).mock.results.at(-1)!.value as {
      setSymbol: ReturnType<typeof vi.fn>;
      setPeriod: ReturnType<typeof vi.fn>;
      setDataLoader: ReturnType<typeof vi.fn>;
    };
    expect(chart.setSymbol).toHaveBeenCalledWith(
      expect.objectContaining({ ticker: "600519" }),
    );
    expect(chart.setPeriod).toHaveBeenCalledWith({ type: "day", span: 1 });
    expect(chart.setDataLoader).toHaveBeenCalled();
  });

  it("无数据时给出提示而非空白", () => {
    render(<KlineChart klines={[]} symbol="600519" />);
    expect(screen.getByText("暂无 K 线数据")).toBeInTheDocument();
  });
});

describe("KlineChart 弹性高度（消除左栏内部滚动条）", () => {
  it("fillHeight 模式在宽屏吃掉剩余高度，窄屏仍保留固定高度", () => {
    render(<KlineChart klines={klines} symbol="600519" fillHeight />);
    const container = screen.getByTestId("kline-container");
    expect(container.className).toContain("lg:flex-1");
    expect(container.className).toContain("lg:min-h-[12rem]");
    expect(container.className).toContain("h-[22rem]"); // 窄屏兜底
  });

  it("默认模式仍是固定高度（不依赖父级 flex）", () => {
    render(<KlineChart klines={klines} symbol="600519" />);
    const container = screen.getByTestId("kline-container");
    expect(container.className).not.toContain("lg:flex-1");
    expect(container.className).toContain("h-[22rem]");
  });
});

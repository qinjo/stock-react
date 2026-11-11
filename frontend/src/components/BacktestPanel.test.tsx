import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import BacktestPanel from "./BacktestPanel";
import type { BacktestResponse, BacktestSummary } from "../types";

/**
 * 回测面板的交互与错误分流。
 *
 * 关注三件事：
 * 1. 长任务可见（loading 有秒数）且参数真的进了请求；
 * 2. 结果里的关键口径（胜率、样本、代理宇宙边界）真的渲染出来；
 * 3. `DATA_NOT_READY` 给出"去跑 bootstrap"的可操作提示，而不是笼统的"数据源不可用"。
 */

const summary: BacktestSummary = {
  stocks: 5958,
  tradedStocks: 2027,
  trades: 9439,
  openTrades: 7,
  wins: 2910,
  winRate: 0.3083,
  avgNetReturn: -0.0077,
  medianNetReturn: -0.0282,
  profitFactor: 0.8,
  maxLoss: -0.5127,
  avgHoldingDays: 4.9,
  avgTotalReturn: -0.0125,
  medianTotalReturn: 0,
  p25TotalReturn: 0,
  p75TotalReturn: 0,
  avgBuyHold: 0.962,
  medianBuyHold: 0.0239,
  beatBuyHoldStocks: 2849,
  stocksWithBuyHold: 5958,
  avgMaxDrawdown: 0.0606,
  eligibleSignals: 9445,
  unfilledSignals: 6,
};

const payload: BacktestResponse = {
  status: "ok",
  dataDate: "2026-09-30",
  from: "2021-01-01",
  to: "2026-09-30",
  params: {
    kdjPeriod: 9,
    kdjKSmooth: 3,
    kdjDSmooth: 3,
    hotWindow: 20,
    hotTopN: 100,
    minBars: 60,
    capital: 100000,
    commissionRate: 0.00025,
    commissionMin: 5,
    stampTaxRate: 0.0005,
    transferFeeRate: 0.00001,
  },
  universe: "成交额横截面排名前 100（代理「热门列表」）+ 20 个交易日内至少一次收盘涨停",
  sample: null,
  window: { instruments: 5958, noBarsInRange: 129, shortSample: 66, backtested: 5958 },
  summary,
  tradedSummary: { ...summary, stocks: 2027, avgTotalReturn: -0.0367, beatBuyHoldStocks: 752, stocksWithBuyHold: 2027 },
  buckets: {
    year: [{ key: "2021", trades: 1488, wins: 500, winRate: 0.336, avgNetReturn: -0.0042, medianNetReturn: -0.0295 }],
    board: [{ key: "主板", trades: 8225, wins: 2584, winRate: 0.314, avgNetReturn: -0.0068, medianNetReturn: -0.0271 }],
  },
  histogram: [
    { from: -0.1, to: -0.05, count: 3 },
    { from: 0, to: 0.05, count: 5 },
  ],
  stocks: {
    traded: 2027,
    best: [
      {
        code: "600089",
        name: "特变电工",
        board: "main",
        boardLabel: "主板",
        trades: 9,
        winRate: 0.444,
        totalReturn: 1.1876,
        buyHoldReturn: 1.5247,
        maxDrawdown: 0.1686,
      },
    ],
    worst: [
      {
        code: "600759",
        name: "ST洲际",
        board: "main",
        boardLabel: "主板",
        trades: 3,
        winRate: 0,
        totalReturn: -0.5584,
        buyHoldReturn: 0.2362,
        maxDrawdown: 0.5584,
      },
    ],
  },
  elapsedMs: 41234,
  fromCache: false,
};

function stubFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => Promise.resolve(handler(String(input)))),
  );
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: () => Promise.resolve(body) } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("BacktestPanel", () => {
  it("点开始回测：请求带上参数，结果渲染指标、边界与两端个股", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return ok(payload);
    });
    render(<BacktestPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "开始回测" }));

    expect(await screen.findByText("30.8%")).toBeInTheDocument();
    expect(screen.getByText("特变电工")).toBeInTheDocument();
    expect(screen.getByText("ST洲际")).toBeInTheDocument();
    // 边界必须出现在结果里，而不是只藏在文档里
    expect(screen.getByText(/代理指标/)).toBeInTheDocument();
    expect(screen.getByText(/结论不可外推/)).toBeInTheDocument();

    expect(calls[0]).toContain("/api/backtest?");
    expect(calls[0]).toContain("from=2021-01-01");
    expect(calls[0]).toContain("hotTop=100");
    expect(calls[0]).toContain("window=20");
    expect(calls[0]).not.toContain("sample=");
  });

  it("改参数后先提示旧结果过期，再用新参数重算", async () => {
    const calls: string[] = [];
    stubFetch((url) => {
      calls.push(url);
      return ok(payload);
    });
    render(<BacktestPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "开始回测" }));
    expect(await screen.findByText("30.8%")).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText("热门 Top-N"), "300");
    expect(screen.getByText(/参数已修改/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "开始回测" }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]).toContain("hotTop=300");
  });

  it("库未就绪：给出可操作提示，而不是笼统的失败", async () => {
    stubFetch(
      () =>
        ({
          ok: false,
          status: 503,
          json: () =>
            Promise.resolve({
              status: "error",
              code: "DATA_NOT_READY",
              message: "本地日K库尚未初始化：backend/data/kline.sqlite",
            }),
        }) as Response,
    );
    render(<BacktestPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "开始回测" }));

    expect(await screen.findByText("本地日K库未就绪")).toBeInTheDocument();
    expect(screen.getByText(/bootstrap:kline/)).toBeInTheDocument();
  });

  it("命中缓存时显示缓存标记", async () => {
    stubFetch(() => ok({ ...payload, fromCache: true }));
    render(<BacktestPanel />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "开始回测" }));
    expect(await screen.findByText("缓存命中")).toBeInTheDocument();
  });
});

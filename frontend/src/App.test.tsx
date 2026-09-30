import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";

const health = { status: "ok", service: "stock-backend", time: "2026-08-30T08:00:00.000Z" };
const candidates = [
  { code: "600519", name: "贵州茅台", secid: "1.600519", market: "沪A", pinyin: "GZMT" },
];
const quote = {
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
  floatMarketCap: 1571502582249.12,
  pe: 17.65,
  pb: 6.25,
  turnoverRate: 0.2,
};
const klines = [
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

/** 按 URL 片段分流 stub fetch。 */
function stubRoutes(routes: Array<[string, unknown]>) {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      for (const [fragment, body] of routes) {
        if (url.includes(fragment)) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve(body) } as Response);
        }
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        json: () => Promise.resolve({}),
      } as Response);
    }),
  );
}

const fundamentals = {
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
  ],
  valuation: {
    asOf: "2026-09-18",
    pe: { current: 17.6, y3: { percentile: 0, min: 17.66, median: 22.03, max: 33.71, samples: 730 }, y5: null },
    pb: { current: 6.24, y3: { percentile: 6.3, min: 5.8, median: 9.1, max: 14.2, samples: 730 }, y5: null },
  },
  industry: "白酒Ⅱ",
  peers: null,
};

beforeEach(() => {
  stubRoutes([
    ["/api/health", health],
    ["/api/search", { candidates }],
    ["/api/quote", { quote }],
    ["/api/kline", { klines }],
    ["/api/fundamentals", { fundamentals }],
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("App 入口页", () => {
  it("渲染标题与查询入口", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "A股智能分析" })).toBeInTheDocument();
    expect(screen.getByLabelText("股票代码 / 名称")).toBeInTheDocument();
  });

  it("显示后端连通状态", async () => {
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/stock-backend · ok/)).toBeInTheDocument();
    });
  });
});

describe("App 选股到行情展示的完整路径", () => {
  it("输入名称补全后选中，展示快照卡与 K 线区域", async () => {
    render(<App />);
    const input = screen.getByLabelText("股票代码 / 名称");

    await userEvent.type(input, "茅台");
    const option = await screen.findByRole("option", { name: /贵州茅台/ });
    await userEvent.click(option);

    await waitFor(() => {
      expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    });
    expect(screen.getByText("市盈率(动)")).toBeInTheDocument();
    expect(screen.getByText("17.65")).toBeInTheDocument();
    expect(screen.getByText(/数据截至：2026-09-18/)).toBeInTheDocument();
    expect(screen.getByTestId("kline-container")).toBeInTheDocument();
  });

  it("数据源不可用时展示可辨识的告警态", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/quote")) {
          return Promise.resolve({
            ok: false,
            status: 502,
            json: () =>
              Promise.resolve({
                status: "error",
                code: "SOURCE_UNAVAILABLE",
                message: "行情数据源暂时不可用",
              }),
          } as Response);
        }
        if (url.includes("/api/kline")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ klines }) } as Response);
        }
        if (url.includes("/api/search")) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ candidates }),
          } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(health) } as Response);
      }),
    );

    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent("数据源暂时不可用");
    });
  });
});

describe("App 的 T5 集成：分析入口与合规", () => {
  it("选中股票后出现分析入口，且免责声明常驻", async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "开始 AI 分析" })).toBeInTheDocument();
    });
    expect(screen.getByText(/不构成任何投资建议/)).toBeInTheDocument();
  });

  it("首屏即展示免责声明（无需先查询）", () => {
    render(<App />);
    expect(screen.getByText(/不构成任何投资建议/)).toBeInTheDocument();
  });

  it("后端未配置 API key 时页脚给出提示", async () => {
    stubRoutes([
      ["/api/health", { ...health, analysisReady: false }],
      ["/api/search", { candidates }],
      ["/api/quote", { quote }],
      ["/api/kline", { klines }],
    ]);
    render(<App />);
    await waitFor(() => {
      expect(screen.getByText(/分析未就绪/)).toBeInTheDocument();
    });
  });
});

describe("App 两栏布局与指标面板", () => {
  it("选中股票后展示技术指标面板（此前页面上不可见）", async () => {
    const indicators = {
      sampleSize: 250,
      fromDate: "2025-09-10",
      toDate: "2026-09-18",
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
    stubRoutes([
      ["/api/health", health],
      ["/api/search", { candidates }],
      ["/api/quote", { quote }],
      ["/api/kline", { klines }],
      ["/api/indicators", { indicators }],
    ]);

    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByText("技术指标")).toBeInTheDocument();
    });
    expect(screen.getByText("1300.97")).toBeInTheDocument();
  });

  it("指标接口失败时行情仍可用（降级不拖垮页面）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/indicators")) {
          return Promise.resolve({
            ok: false,
            status: 502,
            json: () =>
              Promise.resolve({ status: "error", code: "SOURCE_UNAVAILABLE", message: "指标不可用" }),
          } as Response);
        }
        if (url.includes("/api/quote")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ quote }) } as Response);
        }
        if (url.includes("/api/kline")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ klines }) } as Response);
        }
        if (url.includes("/api/search")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ candidates }) } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(health) } as Response);
      }),
    );

    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    });
    expect(screen.queryByText("技术指标")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始 AI 分析" })).toBeInTheDocument();
  });
});

describe("App 的基本面展示（不消耗 LLM）", () => {
  it("选中股票后立即展示基本面面板（无需点击分析）", async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByText("基本面与估值")).toBeInTheDocument();
    });
    expect(screen.getByTestId("valuation-percentiles")).toBeInTheDocument();
    expect(screen.getByTestId("financial-trend")).toBeInTheDocument();
  });

  it("基本面接口失败时行情与分析入口仍可用（降级不拖垮页面）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/api/fundamentals")) {
          return Promise.resolve({
            ok: false,
            status: 502,
            json: () => Promise.resolve({ status: "error", code: "SOURCE_UNAVAILABLE", message: "基本面不可用" }),
          } as Response);
        }
        if (url.includes("/api/quote")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ quote }) } as Response);
        }
        if (url.includes("/api/kline")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ klines }) } as Response);
        }
        if (url.includes("/api/search")) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ candidates }) } as Response);
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(health) } as Response);
      }),
    );

    render(<App />);
    await userEvent.type(screen.getByLabelText("股票代码 / 名称"), "茅台");
    await userEvent.click(await screen.findByRole("option", { name: /贵州茅台/ }));

    await waitFor(() => {
      expect(screen.getByText("贵州茅台")).toBeInTheDocument();
    });
    expect(screen.queryByText("基本面与估值")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "开始 AI 分析" })).toBeInTheDocument();
  });
});

/* ------------------- 顶部模式切换与筛选器联通（#16） ------------------- */

const screenIndicators = {
  sampleSize: 250,
  fromDate: "2025-09-10",
  toDate: "2026-09-18",
  sma50: 1300.97,
  sma200: 1335.94,
  priceVsSma50: -3.8,
  priceVsSma200: -6.32,
  ma: { ma5: 1268.4, ma10: 1275.2, ma20: 1282.61, ma60: 1310.5, ma100: 1327.42, ma120: 1330.1, ma144: 1333.2 },
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

const screenBody = {
  status: "ok",
  dataDate: "2026-09-29",
  refreshedAt: "2026-09-30T08:00:00.000Z",
  params: {
    mode: "trend",
    strictness: "standard",
    boards: ["main", "growth", "star"],
    ignoreMarketGate: false,
    refresh: false,
  },
  funnel: { universe: 6030, afterExclusions: 5006, afterHardFilters: 4855, shortlisted: 337, signalEligible: 24 },
  candidateTotal: 1,
  candidates: [
    {
      code: "600519",
      name: "贵州茅台",
      price: 1235.58,
      changePercent: -0.67,
      metrics: {
        lastClose: 1235.58,
        changePercent: -0.67,
        ma100: 1180.2,
        ma100Deviation: 0.0469,
        barsSinceMa100Cross: 0,
        trendR2: 0.93,
        floatMarketCap: null,
        turnoverAmount: 3260000000,
      },
      ruleHits: [],
      deductions: [],
        signals: {
          signals: [
            {
              id: "S3" as const,
              label: "低位 123 突破高点 2",
              tier: 2,
              detail: "低点1 1120.00 → 高点2 1180.00 → 低点3 1140.00，已突破",
              bookRef: "L681",
            },
          ],
          bestTier: 2,
        },
        signalTier: 2,
        exit: {
          entry: 1235.58,
          stop: 1168.2,
          stopBasis: "low123" as const,
          stopBasisLabel: "123 结构低点 3（书 L689）",
          stopSpace: 0.0545,
          invalidation: "跌破低点 3（1168.20）即结构破坏，按书 L707 破 3 减半、破低点 1 清仓",
          scaleOut: "冲高分批卖出；涨停后冲高注意减仓（书 L1998 / L1521）",
          bookRef: "L689",
        },
        resistance: [
          {
            kind: "prior-high" as const,
            price: 1258.0,
            detail: "前 60 根高点 1258.00（可能受阻的位置，不是涨幅预测）",
          },
        ],
    },
  ],
  inactiveRules: [],
  degraded: { llmReview: true, reason: "大模型复核尚未接入，当前结果全部来自确定性规则" },
  fromCache: false,
  increment: {
    ran: false,
    failed: false,
    error: null,
    snapshotDate: null,
    barsWritten: 0,
    barsRefreshed: 0,
    exDividends: 0,
    namesUpdated: 0,
    marketCapsUpdated: 0,
    skippedTotal: 0,
    durationMs: 0,
  },
};

describe("顶部模式切换与筛选器联通（#16）", () => {
  it("切到筛选器后不再显示单票分析的搜索框", async () => {
    stubRoutes([["/api/health", health]]);
    render(<App />);
    const user = userEvent.setup();

    expect(screen.getByRole("combobox")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "短线筛选器" }));
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  });

  it("筛选出候选后点它，切回单票分析并载入该股", async () => {
    stubRoutes([
      ["/api/health", health],
      ["/api/screen", screenBody],
      ["/api/quote", { quote }],
      ["/api/kline", { klines }],
      ["/api/indicators", { indicators: screenIndicators }],
    ]);
    render(<App />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "短线筛选器" }));
    await user.click(screen.getByRole("button", { name: "开始筛选" }));
    await user.click(await screen.findByRole("button", { name: "贵州茅台" }));

    // 已切回单票分析：页签状态与搜索结果一致，且行情面板出现
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "单票分析" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
    expect(screen.getByRole("combobox")).toBeInTheDocument();
    // 该股的行情与图表真的被载入了（沿用既有成功路径的断言口径）
    expect(await screen.findByText("17.65")).toBeInTheDocument();
    expect(screen.getByTestId("kline-container")).toBeInTheDocument();
  });
});

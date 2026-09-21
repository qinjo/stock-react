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

beforeEach(() => {
  stubRoutes([
    ["/api/health", health],
    ["/api/search", { candidates }],
    ["/api/quote", { quote }],
    ["/api/kline", { klines }],
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

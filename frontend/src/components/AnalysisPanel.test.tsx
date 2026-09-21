import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import AnalysisPanel from "./AnalysisPanel";

const okResponse = {
  status: "ok",
  analysis: {
    rating: "hold",
    confidence: 55,
    reasoning: "多空交织",
    priceTarget: null,
    timeHorizon: null,
    sections: {
      snapshot: "快照内容",
      fundamentals: "基本面内容",
      technicals: "技术面内容",
      risks: ["风险甲"],
      conclusion: "结论内容",
    },
  },
  model: "deepseek-chat",
  analyzedAt: "2026-08-30T10:00:00.000Z",
  fromCache: false,
  input: { code: "600519", name: "贵州茅台", dataDate: "2026-09-18" },
};

function stubJson(status: number, body: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(body),
    } as Response),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AnalysisPanel", () => {
  it("初始显示分析按钮，不自动发起请求", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    render(<AnalysisPanel code="600519" name="贵州茅台" />);
    expect(screen.getByRole("button", { name: "开始 AI 分析" })).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("点击后展示加载态，成功后渲染信号卡与五节报告", async () => {
    // 用可控 promise 精确观察加载中间态（mock 立即 resolve 会跳过它）
    let resolveFetch!: (value: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>((resolve) => (resolveFetch = resolve))),
    );

    render(<AnalysisPanel code="600519" name="贵州茅台" />);
    await userEvent.click(screen.getByRole("button", { name: "开始 AI 分析" }));

    expect(screen.getByRole("status")).toHaveTextContent("正在调用模型分析 贵州茅台");
    expect(screen.getByRole("button", { name: "分析中…" })).toBeDisabled();

    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve(okResponse),
    } as Response);

    await waitFor(() => {
      expect(screen.getByTestId("rating-badge")).toHaveTextContent("持有");
    });
    expect(screen.getByText("① 公司与数据快照")).toBeInTheDocument();
    expect(screen.getByText("风险甲")).toBeInTheDocument();
    expect(screen.getByText(/数据截至：2026-09-18/)).toBeInTheDocument();
  });

  it("数据不足时展示 abstain 文案而非中性结论", async () => {
    stubJson(400, {
      status: "error",
      code: "INSUFFICIENT_DATA",
      message: "历史数据不足：仅 10 根",
    });
    render(<AnalysisPanel code="600519" name="贵州茅台" />);

    await userEvent.click(screen.getByRole("button", { name: "开始 AI 分析" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("数据不足，无法分析");
    expect(screen.queryByTestId("rating-badge")).not.toBeInTheDocument();
  });

  it("分析失败时展示可重试文案，并保留按钮", async () => {
    stubJson(502, { status: "error", code: "ANALYSIS_FAILED", message: "分析失败（已尝试 2 次）" });
    render(<AnalysisPanel code="600519" name="贵州茅台" />);

    await userEvent.click(screen.getByRole("button", { name: "开始 AI 分析" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("分析失败");
    expect(screen.getByRole("button", { name: "重新分析" })).toBeEnabled();
  });

  it("数据源不可用与数据不足使用不同的提示语（语义不混淆）", async () => {
    stubJson(502, {
      status: "error",
      code: "SOURCE_UNAVAILABLE",
      message: "行情数据源暂时不可用",
    });
    render(<AnalysisPanel code="600519" name="贵州茅台" />);

    await userEvent.click(screen.getByRole("button", { name: "开始 AI 分析" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("数据源暂时不可用");
  });

  it("网络异常抛非 ApiError 时也进入失败态（不白屏）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Failed to fetch")));
    render(<AnalysisPanel code="600519" name="贵州茅台" />);

    await userEvent.click(screen.getByRole("button", { name: "开始 AI 分析" }));
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });
});

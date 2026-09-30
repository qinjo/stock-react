import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import ScreenerPanel from "./ScreenerPanel";
import type { ScreenResponse } from "../types";

/**
 * 筛选面板的交互与错误分流。
 *
 * 错误分档是这里最重要的行为：`DATA_NOT_READY`（你还没初始化，能自己解决）与
 * `SOURCE_UNAVAILABLE`（外部源挂了，只能等）必须给出不同的文案——
 * 混成一句"数据源不可用"会把用户引去排查一个不存在的问题。
 */

const candidate = {
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
    floatMarketCap: 4000000000,
    turnoverAmount: 3260000000,
  },
  ruleHits: [
    {
      id: "U-ma100",
      label: "站上 MA100（书的核心选股条件）",
      source: "book" as const,
      bookRef: "L597",
      detail: "后复权收盘 1500.00 > MA100 1430.00（偏离 4.9%）",
      unknown: false,
    },
  ],
  deductions: ["流通市值：流通市值未知（待行情快照），闸门 20.00亿–80.00亿 未生效"],
};

const success: ScreenResponse = {
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
  funnel: { universe: 6030, afterExclusions: 5202, afterHardFilters: 5034, shortlisted: 824 },
  candidateTotal: 824,
  candidates: [candidate],
  inactiveRules: ["E-st", "U-marketCap"],
  degraded: { llmReview: true, reason: "大模型复核尚未接入，当前结果全部来自确定性规则" },
};

type Stub =
  | { ok: true; body: unknown }
  | { ok: false; status: number; body: unknown };

function stubFetch(response: Stub) {
  // 显式声明入参：否则 mock.calls 的类型是空元组，断言取不到下标
  const spy = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve({
      ok: response.ok,
      status: response.ok ? 200 : response.status,
      json: () => Promise.resolve(response.body),
    } as Response),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runScreen() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "开始筛选" }));
  return user;
}

describe("ScreenerPanel 控件与请求", () => {
  it("默认按 均线跟随 + 标准 + 主板/创业板/科创板 发起请求", async () => {
    const fetchSpy = stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("/api/screen");
    expect(url).toContain("mode=trend");
    expect(url).toContain("strictness=standard");
    expect(url).toContain(`boards=${encodeURIComponent("main,growth,star")}`);
  });

  it("切换模式、严格度与板块后请求随之变化", async () => {
    const fetchSpy = stubFetch({ ok: true, body: success });
    const user = userEvent.setup();
    render(<ScreenerPanel onPick={() => {}} />);

    await user.click(screen.getByRole("button", { name: "事件驱动" }));
    await user.click(screen.getByRole("button", { name: "严格" }));
    await user.click(screen.getByRole("checkbox", { name: "北交所" }));
    await runScreen();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    const url = String(fetchSpy.mock.calls[0]?.[0]);
    expect(url).toContain("mode=event");
    expect(url).toContain("strictness=strict");
    expect(url).toContain("bj");
  });

  it("一个板块都不选时直接给出提示，不发起请求", async () => {
    const fetchSpy = stubFetch({ ok: true, body: success });
    const user = userEvent.setup();
    render(<ScreenerPanel onPick={() => {}} />);

    for (const label of ["主板", "创业板", "科创板"]) {
      await user.click(screen.getByRole("checkbox", { name: label }));
    }
    await runScreen();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(screen.getByText("至少要选择一个板块")).toBeInTheDocument();
  });
});

describe("ScreenerPanel 结果呈现", () => {
  it("展示候选、漏斗、数据截止日与未生效规则", async () => {
    stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText("贵州茅台")).toBeInTheDocument();
    expect(screen.getByText("600519")).toBeInTheDocument();
    expect(screen.getByText("1235.58")).toBeInTheDocument();
    expect(screen.getByText(/数据截至 2026-09-29/)).toBeInTheDocument();
    expect(screen.getByText(/全市场 6030 → 排除池 5202 → 硬门槛 5034 → 基础池 824/)).toBeInTheDocument();
    expect(screen.getByText(/E-st、U-marketCap/)).toBeInTheDocument();
  });

  it("候选不足时不假装补足：总数与展示数分别如实说明", async () => {
    stubFetch({ ok: true, body: { ...success, candidateTotal: 3, candidates: [candidate] } });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText(/筛出 3 只/)).toBeInTheDocument();
    expect(screen.getByText(/展示前 1 只/)).toBeInTheDocument();
  });

  it("0 只时说明这是正常输出，而不是故障", async () => {
    stubFetch({ ok: true, body: { ...success, candidateTotal: 0, candidates: [] } });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText("今日无符合条件的个股")).toBeInTheDocument();
    expect(screen.getByText(/这不是故障/)).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("披露作者自述胜率与「规则/AI 生成，非投资建议」小标", async () => {
    stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText(/不构成任何投资建议/)).toBeInTheDocument();
    expect(screen.getByText(/牛市 50%、熊市 30%/)).toBeInTheDocument();
    expect(screen.getByText(/规则生成，非投资建议/)).toBeInTheDocument();
  });

  it("未接入大模型复核时显式标注，而不是让界面以为已复核", async () => {
    stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText(/未经大模型复核/)).toBeInTheDocument();
  });

  it("点候选股把代码与名称交给上层（切回单票分析）", async () => {
    stubFetch({ ok: true, body: success });
    const onPick = vi.fn();
    render(<ScreenerPanel onPick={onPick} />);
    const user = await runScreen();

    await user.click(await screen.findByRole("button", { name: "贵州茅台" }));
    expect(onPick).toHaveBeenCalledWith({ code: "600519", name: "贵州茅台" });
  });

  it("名称为空（bootstrap 阶段）时用代码兜底，不显示空白", async () => {
    stubFetch({ ok: true, body: { ...success, candidates: [{ ...candidate, name: null }] } });
    const onPick = vi.fn();
    render(<ScreenerPanel onPick={onPick} />);
    const user = await runScreen();

    await user.click(await screen.findByRole("button", { name: "600519" }));
    expect(onPick).toHaveBeenCalledWith({ code: "600519", name: "600519" });
  });
});

describe("ScreenerPanel 错误分流", () => {
  it("DATA_NOT_READY 给出可操作的初始化指引，且不说成数据源故障", async () => {
    stubFetch({
      ok: false,
      status: 503,
      body: {
        status: "error",
        code: "DATA_NOT_READY",
        message: "本地日K库尚未初始化：/x/kline.sqlite。请先运行 npm run bootstrap:kline",
      },
    });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText("本地日K库尚未初始化")).toBeInTheDocument();
    expect(screen.getByText(/不是数据源故障/)).toBeInTheDocument();
    expect(screen.queryByText("数据源暂时不可用")).not.toBeInTheDocument();
  });

  it("SOURCE_UNAVAILABLE 走另一档文案（只能等待）", async () => {
    stubFetch({
      ok: false,
      status: 502,
      body: { status: "error", code: "SOURCE_UNAVAILABLE", message: "行情数据源暂时不可用" },
    });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText("数据源暂时不可用")).toBeInTheDocument();
    expect(screen.getByText(/限流/)).toBeInTheDocument();
    expect(screen.queryByText("本地日K库尚未初始化")).not.toBeInTheDocument();
  });

  it("其他错误按请求失败展示，并带上后端消息", async () => {
    stubFetch({
      ok: false,
      status: 400,
      body: { status: "error", code: "INVALID_INPUT", message: "strictness 只能是 loose / standard / strict" },
    });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText("筛选请求失败")).toBeInTheDocument();
    expect(screen.getByText(/strictness 只能是/)).toBeInTheDocument();
  });
});

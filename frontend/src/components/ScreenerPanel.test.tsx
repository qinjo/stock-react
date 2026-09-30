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
      id: "H-bars",
      label: "日 K 根数下限",
      source: "book" as const,
      stage: "hardFilters" as const,
      bookRef: "L2386",
      detail: "300 根 ≥ 150",
      unknown: false,
    },
    {
      id: "U-ma100",
      label: "站上 MA100（书的核心选股条件）",
      source: "book" as const,
      stage: "shortlist" as const,
      bookRef: "L597",
      detail: "后复权收盘 1500.00 > MA100 1430.00（偏离 4.9%）",
      unknown: false,
    },
    {
      id: "U-turnover",
      label: "成交额下限（可买性）",
      source: "offbook" as const,
      stage: "shortlist" as const,
      detail: "32.60亿 ≥ 5000万",
      unknown: false,
    },
    {
      id: "U-marketCap",
      label: "流通市值区间",
      source: "inferred" as const,
      stage: "shortlist" as const,
      bookRef: "L1686",
      detail: "流通市值未知（待行情快照），闸门 20.00亿–80.00亿 未生效",
      unknown: true,
    },
  ],
  deductions: ["流通市值：流通市值未知（待行情快照），闸门 20.00亿–80.00亿 未生效"],
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
  funnel: { universe: 6030, afterExclusions: 5006, afterHardFilters: 4855, shortlisted: 337, signalEligible: 24 },
  candidateTotal: 824,
  candidates: [candidate],
  inactiveRules: ["E-st", "U-marketCap"],
  degraded: { llmReview: true, reason: "大模型复核尚未接入，当前结果全部来自确定性规则" },
  marketGate: {
    state: "offense" as const,
    indexCode: "sh000001",
    indexClose: 3840.83,
    indexMa60: 3700.0,
    indexMa100: 3600.0,
    threeMonthReturn: 0.052,
    bookPosition: 1,
    gatePosition: 1,
    positionAdvice: 1,
    growthIndexAboveMa100: true,
    reason: "【进攻档】上证指数 3840.83 站上 MA100 3600.00，三个月上涨 5.2%",
  },
  suppressed: false,
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
    // 现价与离场计划的「入场」是同一个价，会出现两处
    expect(screen.getAllByText("1235.58").length).toBeGreaterThan(0);
    expect(screen.getByText(/数据截至 2026-09-29/)).toBeInTheDocument();
    expect(screen.getByText(/全市场 6030 → 排除池 5006 → 硬门槛 4855 → 基础池 337 → 有信号/)).toBeInTheDocument();
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

  it("命中当日缓存时标注，避免用户以为又算了一遍", async () => {
    stubFetch({ ok: true, body: { ...success, fromCache: true } });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText(/来自当日缓存/)).toBeInTheDocument();
  });

  it("后端自动补齐当日行情后，把补齐结果告诉用户", async () => {
    stubFetch({
      ok: true,
      body: {
        ...success,
        increment: {
          ...success.increment,
          ran: true,
          snapshotDate: 20260930,
          barsWritten: 5556,
          exDividends: 42,
          namesUpdated: 5556,
        },
      },
    });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    const notice = await screen.findByText(/已自动补齐当日行情/);
    expect(notice).toBeInTheDocument();
    expect(notice.textContent).toContain("2026-09-30");
    expect(notice.textContent).toContain("5556");
    expect(notice.textContent).toContain("42 只除权");
  });

  it("补齐失败时如实告警：结果可能不是最新交易日", async () => {
    stubFetch({
      ok: true,
      body: {
        ...success,
        increment: {
          ...success.increment,
          ran: true,
          failed: true,
          error: "腾讯批量快照请求失败：HTTP 502",
        },
      },
    });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    const alert = await screen.findByText(/当日行情补齐失败/);
    expect(alert.textContent).toContain("502");
    // 但候选仍然展示出来（本地数据还在）
    expect(screen.getByText("贵州茅台")).toBeInTheDocument();
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

/* ---------------- 离场条件与参考压力位展示（#18） ---------------- */

describe("离场条件与参考压力位展示（#18）", () => {
  async function renderResult() {
    stubFetch({ ok: true, body: success });
    const view = render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
    await screen.findByText("贵州茅台");
    return view;
  }

  it("标出信号档序与命中的信号（供判断买点强弱）", async () => {
    await renderResult();
    expect(screen.getByText("档2 · 低位 123")).toBeInTheDocument();
    expect(screen.getByText("低位 123 突破高点 2")).toBeInTheDocument();
    expect(screen.getByText(/书 L681/)).toBeInTheDocument();
  });

  it("显示止损位与它的依据（结构低点 / 均线配对 / 固定比例）", async () => {
    await renderResult();
    expect(screen.getByText("1168.20")).toBeInTheDocument(); // 止损位
    expect(screen.getByText(/123 结构低点 3（书 L689）/)).toBeInTheDocument();
    expect(screen.getByText(/空间 5\.5%/)).toBeInTheDocument();
  });

  it("显示信号失效条件与分批止盈规则", async () => {
    await renderResult();
    expect(screen.getByText(/跌破低点 3（1168\.20）即结构破坏/)).toBeInTheDocument();
    expect(screen.getByText(/冲高分批卖出/)).toBeInTheDocument();
  });

  it("显示参考压力位，并明确它是「可能受阻」而非涨幅预测", async () => {
    await renderResult();
    expect(screen.getByText("1258.00")).toBeInTheDocument();
    expect(screen.getByText(/可能受阻的位置，不是涨幅预测/)).toBeInTheDocument();
  });

  it("全站文案不出现「目标价」", async () => {
    const { container } = await renderResult();
    expect(container.textContent ?? "").not.toContain("目标价");
  });

  it("漏斗展示到「有信号」这一档（基础池 337 → 有信号 24）", async () => {
    await renderResult();
    expect(screen.getByText(/基础池 337/)).toBeInTheDocument();
    expect(screen.getByText("24")).toBeInTheDocument();
  });
});

/* ---------------------------- 大盘门（#22） ---------------------------- */

describe("大盘门（#22）", () => {
  async function renderWith(overrides: Partial<ScreenResponse>) {
    stubFetch({ ok: true, body: { ...success, ...overrides } });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
  }

  it("展示大盘门档位与今日建议总仓位", async () => {
    await renderWith({});
    expect(await screen.findByText("大盘门：进攻档")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText(/站上 MA100 3600\.00/)).toBeInTheDocument();
  });

  it("防守档给出半仓建议", async () => {
    await renderWith({
      marketGate: {
        ...success.marketGate!,
        state: "defense",
        gatePosition: 0.5,
        positionAdvice: 0.5,
        reason: "【防守档】上证指数 3840.83 站上 MA100 3600.00，但三个月趋势不成立",
      },
    });
    expect(await screen.findByText("大盘门：防守档")).toBeInTheDocument();
    expect(screen.getByText("50%")).toBeInTheDocument();
    expect(screen.getByText("（半仓）")).toBeInTheDocument();
  });

  it("空仓档默认不出票：给出横幅、说明本来有几只，并提供逃生开关", async () => {
    await renderWith({
      suppressed: true,
      candidates: [],
      candidateTotal: 24,
      marketGate: {
        ...success.marketGate!,
        state: "empty",
        gatePosition: 0,
        bookPosition: 0,
        positionAdvice: 0,
        reason: "【空仓档】上证指数 3400.00 跌破 MA100 3600.00",
      },
    });

    expect(await screen.findByText("空仓信号：今天默认不出票")).toBeInTheDocument();
    expect(screen.getByText(/仍有/)).toBeInTheDocument();
    // 漏斗里的「有信号 24」与横幅里的「仍有 24 只」都会命中
    expect(screen.getAllByText("24").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "仍要查看（忽略大盘门）" })).toBeInTheDocument();
    // 不出票时不渲染候选卡片
    expect(screen.queryByText("贵州茅台")).not.toBeInTheDocument();
  });

  it("点逃生开关后带 ignoreMarketGate 重新请求，并明确提示正在违反书的择时前提", async () => {
    const emptyGate = {
      ...success.marketGate!,
      state: "empty" as const,
      gatePosition: 0,
      bookPosition: 0,
      positionAdvice: 0,
      reason: "【空仓档】上证指数 3400.00 跌破 MA100 3600.00",
    };
    // 按次序返回：第一次是"空仓抑制"，第二次才是"已忽略"
    const bodies = [
      { ...success, suppressed: true, candidates: [], candidateTotal: 24, marketGate: emptyGate },
      {
        ...success,
        suppressed: false,
        marketGate: emptyGate,
        params: { ...success.params, ignoreMarketGate: true },
      },
    ];
    let call = 0;
    const fetchSpy = vi.fn((_input: RequestInfo | URL) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(bodies[Math.min(call++, bodies.length - 1)]),
      } as Response),
    );
    vi.stubGlobal("fetch", fetchSpy);

    render(<ScreenerPanel onPick={() => {}} />);
    const user = await runScreen();

    await user.click(await screen.findByRole("button", { name: "仍要查看（忽略大盘门）" }));

    await waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    expect(String(fetchSpy.mock.calls[1]?.[0])).toContain("ignoreMarketGate=true");
    await waitFor(() => expect(screen.getByText(/你已忽略大盘门/)).toBeInTheDocument());
  });

  it("创业板指跌破 MA100 时在理由里说明创业板不参与", async () => {
    await renderWith({
      marketGate: {
        ...success.marketGate!,
        growthIndexAboveMa100: false,
        reason: "【进攻档】上证指数 3840.83 站上 MA100 3600.00；创业板指在 MA100 之下，创业板个股本轮不参与",
      },
    });
    expect(await screen.findByText(/创业板指在 MA100 之下/)).toBeInTheDocument();
  });
});

/* ---------------------- 候选明细与来源标记（#17） ---------------------- */

describe("候选明细与来源标记（#17）", () => {
  async function expandRules() {
    stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    const user = await runScreen();
    await screen.findByText("贵州茅台");

    const summary = screen.getByText(/规则明细/);
    const details = summary.closest("details");
    expect(details).not.toBeNull();
    return { user, details: details as HTMLDetailsElement, summary };
  }

  it("默认收起，点击后展开（避免十五条判定把卡片撑长）", async () => {
    const { user, details, summary } = await expandRules();
    expect(details.open).toBe(false);
    await user.click(summary);
    expect(details.open).toBe(true);
  });

  it("摘要里说明判定条数与未判定条数", async () => {
    await expandRules();
    expect(screen.getByText(/4 条判定，全部通过/)).toBeInTheDocument();
    expect(screen.getByText(/其中 1 条因缺数据未判定/)).toBeInTheDocument();
  });

  it("逐条给出规则名与「阈值 + 实际值」的对照", async () => {
    await expandRules();
    expect(screen.getByText("站上 MA100（书的核心选股条件）")).toBeInTheDocument();
    expect(screen.getByText(/后复权收盘 1500\.00 > MA100 1430\.00/)).toBeInTheDocument();
    expect(screen.getByText("成交额下限（可买性）")).toBeInTheDocument();
    expect(screen.getByText(/32\.60亿 ≥ 5000万/)).toBeInTheDocument();
  });

  it("每条规则标出来源：书（带行号）/ 推断 / 书外", async () => {
    await expandRules();
    expect(screen.getByText("书 L597")).toBeInTheDocument();
    expect(screen.getByText("书 L2386")).toBeInTheDocument();
    expect(screen.getByText("推断")).toBeInTheDocument();
    expect(screen.getByText("书外")).toBeInTheDocument();
  });

  it("按层分组展示（排除层 / 硬门槛 / 基础池）", async () => {
    await expandRules();
    expect(screen.getByText("硬门槛")).toBeInTheDocument();
    expect(screen.getByText("基础池")).toBeInTheDocument();
  });

  it("未判定的规则单独标出，并同时出现在扣分项里", async () => {
    await expandRules();
    expect(screen.getByText("（未判定）")).toBeInTheDocument();
    expect(screen.getByText(/^未判定：/)).toBeInTheDocument();
  });

  it("页头展示漏斗各档计数，且不做逐只淘汰原因清单", async () => {
    stubFetch({ ok: true, body: success });
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
    await screen.findByText("贵州茅台");

    expect(
      screen.getByText(/全市场 6030 → 排除池 5006 → 硬门槛 4855 → 基础池 337 → 有信号/),
    ).toBeInTheDocument();
    // 被淘汰的六千只不给逐条原因，只给计数
    expect(screen.queryByText(/淘汰原因/)).not.toBeInTheDocument();
  });
});

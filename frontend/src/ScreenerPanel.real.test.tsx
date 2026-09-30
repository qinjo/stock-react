import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import ScreenerPanel from "./components/ScreenerPanel";

/**
 * 用**真实后端响应**渲染界面。
 *
 * 此前所有前端测试都用手写夹具，而手写夹具往往只含"干净"的形状——
 * 类型层面的一致性已由 `backend/test/contract-types.test.ts` 守住，但
 * **界面能不能扛住真实数据的取值分布**（模型改过序、`null` 的可选字段、
 * 抑制出票等）从未验过。
 *
 * 夹具是 `curl` 真实接口抓下来的**逐字副本**（候选只截取前几只，字段未改），
 * 抓取命令见 `docs/verification-replay-2026-09-29.md` 所在目录的说明。
 */

// 直接用 JSON import：前端 tsconfig 不含 Node 类型，fs 会编译不过；
// Vite 原生支持 JSON 导入，而且夹具就在 src 下。
import trendReal from "./test-fixtures/screen-trend.real.json";
import eventReal from "./test-fixtures/screen-event.real.json";
import suppressedReal from "./test-fixtures/screen-suppressed.real.json";

// 三个夹具都是真实抓取的响应；类型由 JSON 结构推导，不再手写断言
const load = (name: string) =>
  name === "screen-trend.real.json"
    ? trendReal
    : name === "screen-event.real.json"
      ? eventReal
      : suppressedReal;

function stubFetch(body: unknown) {
  const spy = vi.fn(() =>
    Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as Response),
  );
  vi.stubGlobal("fetch", spy);
  return spy;
}

async function runScreen() {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "开始筛选" }));
  return user;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("真实响应 · 趋势模式", () => {
  const data = load("screen-trend.real.json");

  it("渲染真实候选（含名称与代码），而不是空白或崩溃", async () => {
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    for (const candidate of data.candidates) {
      const label = candidate.name ?? candidate.code;
      expect(await screen.findByText(label), `未渲染 ${label}`).toBeInTheDocument();
    }
  });

  it("档位徽章按趋势模式的标签渲染（真实数据的档位是 2/3/4）", async () => {
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
    await screen.findByText(data.candidates[0].name ?? data.candidates[0].code);

    // 这三种标签只可能来自趋势模式的档位表——事件模式的档位名完全不同
    const tiers = new Set(data.candidates.map((c: { signalTier: number }) => c.signalTier));
    expect(tiers.has(2)).toBe(true);
    expect(screen.getAllByText(/^档[234] · /).length).toBeGreaterThan(0);
    expect(screen.queryByText(/底背离双突破|涨停 B 形态/)).toBeNull();
  });

  it("渲染真实离场计划：入场、止损、依据与失效条件", async () => {
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
    await screen.findByText(data.candidates[0].name ?? data.candidates[0].code);

    const exit = data.candidates[0].exit;
    expect(screen.getAllByText(new RegExp(exit.stop.toFixed(2))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(new RegExp(exit.stopBasisLabel.slice(0, 8))).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/失效/).length).toBeGreaterThan(0);
  });

  it("漏斗渲染到「复核」这一档，且数字取自真实响应", async () => {
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    const line = await screen.findByText(/全市场/);
    expect(line.textContent).toContain(String(data.funnel.universe));
    expect(line.textContent).toContain(String(data.funnel.signalEligible));
    expect(line.textContent).toContain(String(data.funnel.reviewed));
    expect(line.textContent).toContain("复核");
  });

  it("真实载荷里模型改过顺序——界面按响应给的顺序渲染（不再自己排）", async () => {
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();
    await screen.findByText(data.candidates[0].name ?? data.candidates[0].code);

    const rendered = data.candidates.map(
      (c: { code: string; name: string | null }) => c.name ?? c.code,
    );
    const positions = rendered.map((label: string) => {
      const el = screen.getByText(label);
      return Number(el.closest("li")?.getAttribute("data-order") ?? -1);
    });
    // 卡片顺序与响应数组一致（接口已经把档序 + 档内次序都排好）
    const cards = Array.from(document.querySelectorAll("li"));
    const cardText = cards.map((li) => li.textContent ?? "");
    const order = rendered.map((label: string) => cardText.findIndex((t) => t.includes(label)));
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(positions).toBeDefined();
  });
});

describe("真实响应 · 事件模式", () => {
  it("用事件模式的档位标签渲染（与趋势模式不同的那套名字）", async () => {
    const data = load("screen-event.real.json");
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "事件驱动" }));
    await user.click(screen.getByRole("button", { name: "开始筛选" }));

    // 真实事件候选：涨停 B 形态（档2）与突破性涨停（档3）。
    // 用 findAll：同一个名字会同时出现在档位徽章与信号行里
    expect((await screen.findAllByText(/涨停 B 形态|突破性涨停/)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/底背离双突破/)).toBeNull();
  });
});

describe("真实响应 · 空仓档抑制出票", () => {
  it("显示空仓横幅、不给候选、且不叠一句「今日无符合条件」", async () => {
    const data = load("screen-suppressed.real.json");
    stubFetch(data);
    render(<ScreenerPanel onPick={() => {}} />);
    await runScreen();

    expect(await screen.findByText(/空仓信号/)).toBeInTheDocument();
    // 真实响应里 candidateTotal=12（本来有 12 只符合个股条件）。
    // 用 getAll：漏斗行里也有这个数
    expect(screen.getAllByText(String(data.candidateTotal)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/今日无符合条件的个股/)).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/eastmoney.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/eastmoney.js")>();
  return {
    ...actual,
    fetchEastmoneyQuote: vi.fn(),
    fetchEastmoneyKline: vi.fn(),
  };
});

vi.mock("../src/tencent.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/tencent.js")>();
  return {
    ...actual,
    fetchTencentQuote: vi.fn(),
    fetchTencentKline: vi.fn(),
  };
});

import { fetchKline, fetchQuote, setDegradeLogger } from "../src/datasource.js";
import { fetchEastmoneyKline, fetchEastmoneyQuote } from "../src/eastmoney.js";
import { fetchTencentKline, fetchTencentQuote } from "../src/tencent.js";
import type { Kline, Quote } from "../src/domain.js";

const fakeQuote = { code: "600519", name: "贵州茅台" } as Quote;
const fakeKline = [{ date: "2026-09-18" }] as Kline[];

afterEach(() => {
  vi.clearAllMocks();
  setDegradeLogger(undefined);
});

describe("数据源降级（东财主 → 腾讯备）", () => {
  it("东财成功时不触碰腾讯", async () => {
    vi.mocked(fetchEastmoneyQuote).mockResolvedValue(fakeQuote);

    await expect(fetchQuote("600519")).resolves.toBe(fakeQuote);
    expect(fetchTencentQuote).not.toHaveBeenCalled();
  });

  it("东财失败时降级到腾讯并记录事件", async () => {
    const events: Array<{ from: string; to: string; reason: string }> = [];
    setDegradeLogger((e) => events.push(e));
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(new Error("Empty reply from server"));
    vi.mocked(fetchTencentQuote).mockResolvedValue(fakeQuote);

    await expect(fetchQuote("600519")).resolves.toBe(fakeQuote);
    expect(fetchTencentQuote).toHaveBeenCalledWith("600519");
    expect(events).toEqual([
      { from: "eastmoney", to: "tencent", reason: "Empty reply from server" },
    ]);
  });

  it("K 线同样降级", async () => {
    vi.mocked(fetchEastmoneyKline).mockRejectedValue(new Error("HTTP 502"));
    vi.mocked(fetchTencentKline).mockResolvedValue(fakeKline);

    await expect(fetchKline("600519", 60)).resolves.toBe(fakeKline);
    expect(fetchTencentKline).toHaveBeenCalledWith("600519", 60);
  });

  it("非法输入不触发降级（两源结论相同，重试无意义）", async () => {
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(new Error("无法识别的股票代码：茅台"));

    await expect(fetchQuote("茅台")).rejects.toThrow("无法识别");
    expect(fetchTencentQuote).not.toHaveBeenCalled();
  });

  it("两源都失败时抛出备源错误", async () => {
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(new Error("东财断连"));
    vi.mocked(fetchTencentQuote).mockRejectedValue(new Error("腾讯不可用"));

    await expect(fetchQuote("600519")).rejects.toThrow("腾讯不可用");
  });
});

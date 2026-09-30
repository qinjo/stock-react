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
import { SourceUnavailableError, UnknownSymbolError } from "../src/domain.js";

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

  it("代码格式无法解析时不触发降级（两源结论相同，重试无意义）", async () => {
    // 用类型化错误：新设计里"代码不存在"由 UnknownSymbolError 表达，
    // 不再靠消息前缀（原实现靠 startsWith("无法识别")，那个分支实际从未走到）
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(
      new UnknownSymbolError("茅台", "代码格式无法解析"),
    );

    await expect(fetchQuote("茅台")).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(fetchTencentQuote).not.toHaveBeenCalled();
  });

  it("两源都失败且都是源问题 → 抛出源错误（不是「代码不存在」）", async () => {
    // 网络/HTTP 故障现在是类型化的（SourceUnavailableError / TypeError），
    // 旧测试用普通 Error 表示断连——那正是新设计消除的歧义
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(new SourceUnavailableError("东财断连"));
    vi.mocked(fetchTencentQuote).mockRejectedValue(new SourceUnavailableError("腾讯不可用"));

    await expect(fetchQuote("600519")).rejects.toThrow("腾讯不可用");
  });

  it("两源都失败且都不是源问题 → 判定为代码不存在（用户决策 #30）", async () => {
    vi.mocked(fetchEastmoneyQuote).mockRejectedValue(new Error("行情响应缺少 data 字段"));
    vi.mocked(fetchTencentQuote).mockRejectedValue(new Error("腾讯行情响应字段不足"));

    await expect(fetchQuote("999999")).rejects.toBeInstanceOf(UnknownSymbolError);
  });
});

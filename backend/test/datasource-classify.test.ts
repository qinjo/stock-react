import { describe, expect, it, vi, beforeEach } from "vitest";
import { SourceUnavailableError, UnknownSymbolError } from "../src/domain.js";

/**
 * 「代码不存在」与「数据源不可用」必须分得开。
 *
 * 原缺陷：两个源对未知代码抛的都是**字段形态错误**（东财"缺少 data 字段"、
 * 腾讯"响应字段不足"），而路由靠 `startsWith("无法识别")` 判断——
 * 那个分支从来没被走到过，于是用户打错代码看到的是「数据源暂时不可用」。
 *
 * 现判据：**两源都失败、且都不是源问题 → 代码不存在**；只要有一边是源问题 → 源不可用。
 * 靠类型区分，不靠消息前缀。
 */

vi.mock("../src/eastmoney.js", () => ({
  fetchEastmoneyQuote: vi.fn(),
  fetchEastmoneyKline: vi.fn(),
}));
vi.mock("../src/tencent.js", () => ({
  fetchTencentQuote: vi.fn(),
  fetchTencentKline: vi.fn(),
}));

import { fetchEastmoneyQuote } from "../src/eastmoney.js";
import { fetchTencentQuote } from "../src/tencent.js";
import { fetchQuote } from "../src/datasource.js";

const east = vi.mocked(fetchEastmoneyQuote);
const tencent = vi.mocked(fetchTencentQuote);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("双源失败后的归类", () => {
  it("两源都抛「响应无数据」→ UnknownSymbolError（代码不存在，该改输入）", async () => {
    east.mockRejectedValue(new Error("行情响应缺少 data 字段"));
    tencent.mockRejectedValue(new Error("腾讯行情响应字段不足"));

    await expect(fetchQuote("999999")).rejects.toBeInstanceOf(UnknownSymbolError);
  });

  it("错误消息里带上原始输入，便于用户核对自己打了什么", async () => {
    east.mockRejectedValue(new Error("行情响应缺少 data 字段"));
    tencent.mockRejectedValue(new Error("腾讯行情响应字段不足"));

    await expect(fetchQuote("999999")).rejects.toThrow(/999999/);
  });

  it("腾讯报「源不可用」→ 按源不可用报，不把服务端故障说成用户打错代码", async () => {
    // 判据以**腾讯**为准：它是唯一能区分"无此代码"的端点
    east.mockRejectedValue(new Error("行情响应缺少 data 字段"));
    tencent.mockRejectedValue(new SourceUnavailableError("腾讯请求失败：HTTP 502", 502));

    const err = await fetchQuote("600519").catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(UnknownSymbolError);
    expect((err as Error).message).toContain("502");
  });

  it("东财断连（TypeError）+ 腾讯报无数据 → 判定为代码不存在（这是实测的真实特征）", async () => {
    // 实测：东财对不存在的 secid **直接断连**，undici 报 TypeError「fetch failed」，
    // 与真正的网络故障在类型上无法区分。所以不能靠"两源都说是无数据"投票——
    // 这一组（东财 TypeError + 腾讯字段形态错误）恰是"代码不存在"的真实签名。
    east.mockRejectedValue(new TypeError("fetch failed"));
    tencent.mockRejectedValue(new Error("腾讯行情响应字段不足"));

    await expect(fetchQuote("999999")).rejects.toBeInstanceOf(UnknownSymbolError);
  });

  it("腾讯超时也算源问题（不是「代码不存在」）", async () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const timeout = new Error("timed out");
      timeout.name = name;
      east.mockRejectedValue(new Error("行情响应缺少 data 字段"));
      tencent.mockRejectedValue(timeout);
      const err = await fetchQuote("600519").catch((e: unknown) => e);
      expect(err, name).not.toBeInstanceOf(UnknownSymbolError);
    }
  });

  it("主源成功时不降级（也就不会误判）", async () => {
    east.mockResolvedValue({ code: "600519", name: "贵州茅台" } as never);
    await expect(fetchQuote("600519")).resolves.toMatchObject({ name: "贵州茅台" });
    expect(tencent).not.toHaveBeenCalled();
  });

  it("代码格式本身无法解析时不必降级试探", async () => {
    east.mockRejectedValue(new UnknownSymbolError("abc", "代码格式无法解析"));
    await expect(fetchQuote("abc")).rejects.toBeInstanceOf(UnknownSymbolError);
    expect(tencent).not.toHaveBeenCalled();
  });
});

import { describe, expect, it } from "vitest";
import {
  fromDateKey,
  parseCalendar,
  parseFeatureBin,
  parseInstruments,
  parseQlibSymbol,
  toDateKey,
  toRawAmount,
  toRawPrice,
  toRawVolume,
} from "../src/market/qlib.js";

/** 构造一个特征文件：元素 0 是起始索引，其余是数值，**没有数量字段**。 */
function featureBin(startIndex: number, values: number[]): Buffer {
  const floats = [startIndex, ...values];
  const buf = Buffer.alloc(floats.length * 4);
  floats.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

describe("parseCalendar", () => {
  it("按行解析并去掉空行与首尾空白", () => {
    expect(parseCalendar("2026-09-28\n2026-09-29\n\n  2026-09-30  \n")).toEqual([
      "2026-09-28",
      "2026-09-29",
      "2026-09-30",
    ]);
  });
});

describe("parseInstruments", () => {
  it("解析 SYMBOL\tSTART\tEND，保留大写符号", () => {
    const parsed = parseInstruments("SH600519\t2001-08-27\t2026-09-29\nBJ430017\t2023-05-31\t2025-09-30\n");
    expect(parsed).toEqual([
      { symbol: "SH600519", start: "2001-08-27", end: "2026-09-29" },
      { symbol: "BJ430017", start: "2023-05-31", end: "2025-09-30" },
    ]);
  });

  it("跳过空行", () => {
    expect(parseInstruments("\n\n")).toEqual([]);
  });
});

describe("parseFeatureBin", () => {
  it("元素 0 是日历起始索引，其余是数值；数量 = 字节数/4 - 1（没有数量字段）", () => {
    const buf = featureBin(393, [1.5, 2.5, 3.5]);
    expect(buf.length).toBe(16);

    const series = parseFeatureBin(buf);
    expect(series.startIndex).toBe(393);
    expect(Array.from(series.values)).toEqual([1.5, 2.5, 3.5]);
    // 这条断言就是「没有数量字段」的判据：若头部含数量字段，长度会是 5 个 float
    expect(series.values.length).toBe(buf.length / 4 - 1);
  });

  it("空文件抛错", () => {
    expect(() => parseFeatureBin(Buffer.alloc(0))).toThrow(/为空/);
  });

  it("长度不是 4 的倍数抛错", () => {
    expect(() => parseFeatureBin(Buffer.alloc(6))).toThrow(/4 的倍数/);
  });

  it("头部不是合法的日历起始索引时抛错", () => {
    expect(() => parseFeatureBin(featureBin(-1, [1]))).toThrow(/起始索引/);
    expect(() => parseFeatureBin(featureBin(1.5, [1]))).toThrow(/起始索引/);
  });
});

describe("parseQlibSymbol", () => {
  it("沪市主板 / 科创板", () => {
    expect(parseQlibSymbol("SH600519")).toMatchObject({ market: "sh", code: "600519", board: "main", dirName: "sh600519" });
    expect(parseQlibSymbol("SH688981")).toMatchObject({ market: "sh", code: "688981", board: "star" });
  });

  it("深市主板 / 创业板", () => {
    expect(parseQlibSymbol("SZ000001")).toMatchObject({ market: "sz", code: "000001", board: "main" });
    expect(parseQlibSymbol("SZ300750")).toMatchObject({ market: "sz", code: "300750", board: "growth" });
    expect(parseQlibSymbol("SZ301716")).toMatchObject({ board: "growth" });
  });

  it("北交所", () => {
    expect(parseQlibSymbol("BJ920002")).toMatchObject({ market: "bj", code: "920002", board: "bj" });
  });

  it("指数单列：同为 000001，沪市是指数、深市是平安银行", () => {
    expect(parseQlibSymbol("SH000001").board).toBe("index");
    expect(parseQlibSymbol("SZ000001").board).toBe("main");
    expect(parseQlibSymbol("SH000300").board).toBe("index");
    expect(parseQlibSymbol("SZ399300").board).toBe("index");
  });

  it("目录名是小写符号（归档里清单大写、目录小写，必须归一化）", () => {
    expect(parseQlibSymbol("bj920002").dirName).toBe("bj920002");
    expect(parseQlibSymbol("BJ920002").dirName).toBe("bj920002");
  });

  it("无法识别时抛错", () => {
    expect(() => parseQlibSymbol("US600519")).toThrow(/无法识别/);
    expect(() => parseQlibSymbol("SH60051")).toThrow(/无法识别/);
  });
});

describe("单位换算", () => {
  it("不复权价 = 缩放价 / 因子（用实测值锚定）", () => {
    // 实测：sh600519 2026-09-29 缩放 close=300.5027、factor=0.243208
    // 不复权价 1235.5801，与腾讯行情快照的收盘价 1235.58 一致
    expect(toRawPrice(300.5027, 0.243208)).toBeCloseTo(1235.58, 2);
  });

  it("因子不可用时返回 null，而不是 Infinity/NaN", () => {
    expect(toRawPrice(100, 0)).toBeNull();
    expect(toRawPrice(Number.NaN, 1)).toBeNull();
    expect(toRawPrice(100, Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("不复权成交量 = 缩放成交量 × 因子", () => {
    expect(toRawVolume(1000, 0.5)).toBeCloseTo(500, 6);
    expect(toRawVolume(Number.NaN, 1)).toBeNull();
  });

  it("成交额 = 缩放成交额 × 1000（该字段以千元存储）", () => {
    expect(toRawAmount(1234.5)).toBe(1_234_500);
    expect(toRawAmount(Number.NaN)).toBeNull();
  });
});

describe("日期键", () => {
  it("YYYY-MM-DD 与 YYYYMMDD 整数互转", () => {
    expect(toDateKey("2026-09-29")).toBe(20260929);
    expect(fromDateKey(20260929)).toBe("2026-09-29");
    expect(fromDateKey(toDateKey("2001-08-27"))).toBe("2001-08-27");
  });

  it("非法输入抛错", () => {
    expect(() => toDateKey("2026/09/29")).toThrow(/无法识别/);
    expect(() => fromDateKey(2026)).toThrow(/无法识别/);
  });
});

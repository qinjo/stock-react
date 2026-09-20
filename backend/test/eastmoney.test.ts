import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeKline,
  normalizeQuote,
  normalizeTencentSuggest,
  parseMaybeJsonp,
  resolveSecid,
} from "../src/eastmoney.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));
const loadText = (name: string) => readFileSync(join(fixtures, name), "utf8");

describe("resolveSecid", () => {
  it("6 位纯代码按市场前缀判定（6 开头沪市）", () => {
    expect(resolveSecid("600519")).toBe("1.600519");
  });

  it("0/3 开头判定为深市", () => {
    expect(resolveSecid("000001")).toBe("0.000001");
    expect(resolveSecid("300750")).toBe("0.300750");
  });

  it("宽容 sh/sz 前缀与 .SH/.SZ 后缀，大小写不限", () => {
    expect(resolveSecid("sh600519")).toBe("1.600519");
    expect(resolveSecid("SH600519")).toBe("1.600519");
    expect(resolveSecid("600519.SH")).toBe("1.600519");
    expect(resolveSecid("sz000001")).toBe("0.000001");
    expect(resolveSecid("000001.SZ")).toBe("0.000001");
  });

  it("已带市场前缀的 secid 原样返回", () => {
    expect(resolveSecid("1.600519")).toBe("1.600519");
  });

  it("无法识别时抛错", () => {
    expect(() => resolveSecid("茅台")).toThrow();
    expect(() => resolveSecid("")).toThrow();
  });
});

describe("normalizeQuote", () => {
  const quote = normalizeQuote(load("quote-600519.raw.json"));

  it("价格类字段按 ×100 缩放还原", () => {
    // fixture: f43=125712, f46=126299, f44=126588, f45=125610, f60=126698
    expect(quote.price).toBeCloseTo(1257.12, 2);
    expect(quote.open).toBeCloseTo(1262.99, 2);
    expect(quote.high).toBeCloseTo(1265.88, 2);
    expect(quote.low).toBeCloseTo(1256.1, 2);
    expect(quote.prevClose).toBeCloseTo(1266.98, 2);
    expect(quote.limitUp).toBeCloseTo(1393.68, 2);
    expect(quote.limitDown).toBeCloseTo(1140.28, 2);
  });

  it("比率类字段按 ×100 缩放还原", () => {
    // fixture: f170=-78, f168=20, f162=1765, f167=625
    expect(quote.changePercent).toBeCloseTo(-0.78, 2);
    expect(quote.turnoverRate).toBeCloseTo(0.2, 2);
    expect(quote.pe).toBeCloseTo(17.65, 2);
    expect(quote.pb).toBeCloseTo(6.25, 2);
  });

  it("成交量/成交额/市值不缩放", () => {
    // fixture: f47=24891 手, f48=3135849108 元, f116=1571502582249.12 元
    expect(quote.volume).toBe(24891);
    expect(quote.amount).toBeCloseTo(3135849108, 0);
    expect(quote.marketCap).toBeCloseTo(1571502582249.12, 0);
  });

  it("身份字段为代码与名称", () => {
    expect(quote.code).toBe("600519");
    expect(quote.name).toBe("贵州茅台");
  });

  it("缺失值（-）转为 null", () => {
    const q = normalizeQuote({ data: { f57: "600519", f58: "测试", f43: "-", f162: null } });
    expect(q.price).toBeNull();
    expect(q.pe).toBeNull();
  });

  it("缺少 data 时抛错", () => {
    expect(() => normalizeQuote({})).toThrow();
  });
});

describe("normalizeKline", () => {
  const raw = load("kline-600519.raw.json");
  const rows = normalizeKline(raw);

  it("按实测列序解析（date,open,close,high,low,…）而非标准 OHLC 顺序", () => {
    // fixture 首行: 2024-01-02,1580.66,1550.67,1583.85,1543.76,32156,…
    const first = rows[0]!;
    expect(first.date).toBe("2024-01-02");
    expect(first.open).toBeCloseTo(1580.66, 2);
    expect(first.close).toBeCloseTo(1550.67, 2);
    expect(first.high).toBeCloseTo(1583.85, 2);
    expect(first.low).toBeCloseTo(1543.76, 2);
  });

  it("量额与比率字段映射正确", () => {
    const first = rows[0]!;
    expect(first.volume).toBe(32156);
    expect(first.amount).toBeCloseTo(5440082548, 0);
    expect(first.amplitude).toBeCloseTo(2.52, 2);
    expect(first.changePercent).toBeCloseTo(-2.58, 2);
    expect(first.turnoverRate).toBeCloseTo(0.26, 2);
  });

  it("limit 截取最近 N 根（东财 lmt 参数实测不可靠）", () => {
    const all = normalizeKline(raw);
    const last60 = normalizeKline(raw, 60);
    expect(all.length).toBeGreaterThan(60);
    expect(last60).toHaveLength(60);
    expect(last60.at(-1)!.date).toBe(all.at(-1)!.date);
    expect(last60[0]!.date).toBe(all.at(-60)!.date);
  });

  it("缺少 klines 时抛错", () => {
    expect(() => normalizeKline({ data: {} })).toThrow();
  });
});

describe("parseMaybeJsonp", () => {
  it("解析纯 JSON", () => {
    expect(parseMaybeJsonp('{"a":1}')).toEqual({ a: 1 });
  });

  it("剥离 JSONP 包装（东财对浏览器 UA 的实测行为）", () => {
    expect(parseMaybeJsonp('jQuery35108723733748578402_1693632913001({"a":1});')).toEqual({
      a: 1,
    });
    expect(parseMaybeJsonp('cb({"x":{"y":[1,2]}});')).toEqual({ x: { y: [1, 2] } });
  });

  it("空响应与非法格式抛错", () => {
    expect(() => parseMaybeJsonp("")).toThrow();
    expect(() => parseMaybeJsonp("not json at all")).toThrow();
  });
});

describe("normalizeTencentSuggest", () => {
  it("中文名搜索解析出 A 股候选（unicode 转义解码）", () => {
    const list = normalizeTencentSuggest(loadText("suggest-tencent-maotai.raw.txt"));
    expect(list).toHaveLength(1);
    expect(list[0]).toEqual({
      code: "600519",
      name: "贵州茅台",
      secid: "1.600519",
      market: "沪A",
      pinyin: "GZMT",
    });
  });

  it("过滤非 A 股类型（FJ/LOF），仅保留 GP-A", () => {
    const list = normalizeTencentSuggest(loadText("suggest-tencent-multi.raw.txt"));
    expect(list.length).toBeGreaterThan(0);
    expect(list.every((c) => !c.name.includes("REIT"))).toBe(true);
    expect(list[0]).toEqual({
      code: "000001",
      name: "平安银行",
      secid: "0.000001",
      market: "深A",
      pinyin: "PAYH",
    });
  });

  it("空响应与异常格式返回空数组", () => {
    expect(normalizeTencentSuggest('v_hint="N";')).toEqual([]);
    expect(normalizeTencentSuggest("")).toEqual([]);
    expect(normalizeTencentSuggest("garbage")).toEqual([]);
  });
});

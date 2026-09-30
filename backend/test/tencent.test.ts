import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeTencentBatch,
  normalizeTencentKline,
  normalizeTencentQuote,
  normalizeTencentSuggest,
  secidToTencentSymbol,
  volumeToLots,
} from "../src/tencent.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const loadText = (name: string) => readFileSync(join(fixtures, name), "utf8");
const loadJson = (name: string) => JSON.parse(loadText(name));
/** 腾讯实时接口是 GBK 编码，fixture 保存原始字节。 */
const loadGbk = (name: string) =>
  new TextDecoder("gbk").decode(readFileSync(join(fixtures, name)));

describe("secidToTencentSymbol", () => {
  it("沪市 secid 映射为 sh 前缀", () => {
    expect(secidToTencentSymbol("1.600519")).toBe("sh600519");
  });

  it("深市 secid 映射为 sz 前缀", () => {
    expect(secidToTencentSymbol("0.000001")).toBe("sz000001");
  });
});

describe("normalizeTencentQuote", () => {
  const quote = normalizeTencentQuote(loadGbk("quote-600519.tencent.gbk"));

  it("身份与价格字段正确（GBK 解码后中文名无乱码）", () => {
    expect(quote.code).toBe("600519");
    expect(quote.name).toBe("贵州茅台");
    expect(quote.price).toBeCloseTo(1257.12, 2);
    expect(quote.prevClose).toBeCloseTo(1266.98, 2);
    expect(quote.open).toBeCloseTo(1262.99, 2);
    expect(quote.high).toBeCloseTo(1265.88, 2);
    expect(quote.low).toBeCloseTo(1256.1, 2);
    expect(quote.changePercent).toBeCloseTo(-0.78, 2);
  });

  it("成交额（万元）与市值（亿元）换算为元，与东财口径一致", () => {
    // 腾讯字段 37=313585 万元 → 3,135,850,000 元（东财 3,135,849,108 元，万元级精度差异）
    expect(quote.amount).toBeCloseTo(3135850000, 0);
    // 字段 44/45=15715.03 亿元 → 1,571,503,000,000 元（东财 1,571,502,582,249 元）
    expect(quote.marketCap).toBeCloseTo(1.571503e12, -6);
    expect(quote.floatMarketCap).toBeCloseTo(1.571503e12, -6);
  });

  it("比率与涨跌停字段正确", () => {
    expect(quote.turnoverRate).toBeCloseTo(0.2, 2);
    expect(quote.pb).toBeCloseTo(6.25, 2);
    expect(quote.pe).toBeCloseTo(17.65, 2);
    expect(quote.limitUp).toBeCloseTo(1393.68, 2);
    expect(quote.limitDown).toBeCloseTo(1140.28, 2);
    expect(quote.volume).toBe(24891);
  });

  it("字段不足或格式异常时抛错", () => {
    expect(() => normalizeTencentQuote('v_sh600519="1~2~3";')).toThrow();
    expect(() => normalizeTencentQuote("")).toThrow();
  });
});

describe("normalizeTencentKline", () => {
  const raw = loadJson("kline-600519.tencent.json");
  const rows = normalizeTencentKline(raw);

  it("按 [date,open,close,high,low,volume] 列序解析", () => {
    const last = rows.at(-1)!;
    expect(last.date).toBe("2026-09-18");
    expect(last.open).toBeCloseTo(1262.99, 2);
    expect(last.close).toBeCloseTo(1257.12, 2);
    expect(last.high).toBeCloseTo(1265.88, 2);
    expect(last.low).toBeCloseTo(1256.1, 2);
    expect(last.volume).toBe(24891);
  });

  it("腾讯不提供的字段置 null（不伪造数据）", () => {
    expect(rows[0]!.amount).toBeNull();
    expect(rows[0]!.turnoverRate).toBeNull();
  });

  it("limit 截取最近 N 根", () => {
    expect(normalizeTencentKline(raw, 10)).toHaveLength(10);
    expect(normalizeTencentKline(raw, 10).at(-1)!.date).toBe(rows.at(-1)!.date);
  });

  it("缺少 data 或日线数组时抛错", () => {
    expect(() => normalizeTencentKline({})).toThrow();
    expect(() => normalizeTencentKline({ data: { sh600519: {} } })).toThrow();
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

/* ------------------------- 批量快照与成交量单位 ------------------------- */

describe("volumeToLots：科创板返回「股」、其余板块「手」", () => {
  it("科创板除以 100 换成手", () => {
    // 实测：4 只科创板标的的 成交额 ÷ (成交量 × 100 × 现价) 全部 ≈0.01
    expect(volumeToLots(17334942, "sh688981")).toBeCloseTo(173349.42, 2);
    expect(volumeToLots(1000, "sh689009")).toBeCloseTo(10, 6);
  });

  it("其他板块原样返回", () => {
    expect(volumeToLots(26366, "sh600519")).toBe(26366);
    expect(volumeToLots(171065, "sz300750")).toBe(171065);
    expect(volumeToLots(15726, "bj920002")).toBe(15726);
  });

  it("空值保持 null（停牌标的）", () => {
    expect(volumeToLots(null, "sh600519")).toBeNull();
  });
});

describe("normalizeTencentBatch", () => {
  const rows = normalizeTencentBatch(loadGbk("snapshot-batch.tencent.gbk"));

  it("逐行解析，覆盖沪深主板 / 创业板 / 科创板 / 北交所 / 指数", () => {
    expect(rows.map((r) => r.symbol)).toEqual([
      "sh600519",
      "sz000001",
      "sz300750",
      "sh688981",
      "bj920002",
      "sh601398",
      "sh000001",
      "sz399006",
    ]);
  });

  it("取出时间戳与交易日", () => {
    const maotai = rows[0]!;
    expect(maotai.timestamp).toMatch(/^\d{14}$/);
    expect(maotai.tradeDate).toBe(Number(maotai.timestamp!.slice(0, 8)));
  });

  it("科创板成交量已换成手，与成交额自洽", () => {
    const star = rows.find((r) => r.symbol === "sh688981")!;
    const { volume, amount, price } = star.quote;
    // 成交额 ≈ 手 × 100 × 均价：不换算的话这里会差两个数量级
    const ratio = (amount as number) / ((volume as number) * 100 * (price as number));
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("主板成交量本就是手，同样自洽", () => {
    const main = rows.find((r) => r.symbol === "sh600519")!;
    const ratio = (main.quote.amount as number) / ((main.quote.volume as number) * 100 * (main.quote.price as number));
    expect(ratio).toBeGreaterThan(0.9);
    expect(ratio).toBeLessThan(1.1);
  });

  it("字段个数不固定（北交所实测少一个）也能解析", () => {
    const bj = rows.find((r) => r.symbol === "bj920002")!;
    expect(bj.quote.name).toBe("万达轴承");
    expect(bj.quote.price).toBeGreaterThan(0);
    expect(bj.tradeDate).not.toBeNull();
  });

  it("单位换算：成交额万元→元、市值亿元→元", () => {
    const maotai = rows[0]!;
    expect(maotai.quote.amount).toBeGreaterThan(1e8); // 十几亿
    expect(maotai.quote.floatMarketCap).toBeGreaterThan(1e10); // 万亿级
  });

  it("单行异常不影响其余标的（批量里个别停牌是常态）", () => {
    const text = [
      'v_sh600519="1~贵州茅台~600519~1235.58~1243.88~1244.60~26366~',
      "x",
      'v_sz000001="1~平安银行~000001~11.35~11.30~11.31~385367~0~0~11.35~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~0~20260930113954~0.05~0.44~11.41~11.28~11.35/385367/441430000~385367~44143~1.99~0.21~5.07~~11.41~11.28~1.14~2229.71~2229.71~0.47~12.41~10.17~0.94~-8~6~";',
    ].join("\n");
    const parsed = normalizeTencentBatch(text);
    expect(parsed.map((r) => r.symbol)).toEqual(["sz000001"]);
  });

  it("空响应返回空数组，不抛错", () => {
    expect(normalizeTencentBatch("")).toEqual([]);
  });
});

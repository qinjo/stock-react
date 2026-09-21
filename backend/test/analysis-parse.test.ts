import { describe, expect, it } from "vitest";
import { ParseError, extractJson, parseAnalysis } from "../src/analysis/parse.js";
import { buildAnalysisPrompt } from "../src/analysis/prompt.js";
import type { AnalysisInput } from "../src/analysis/types.js";

const sampleInput: AnalysisInput = {
  code: "600519",
  name: "贵州茅台",
  dataDate: "2026-09-18",
  quote: {
    price: 1257.12,
    changePercent: -0.78,
    open: 1262.99,
    high: 1265.88,
    low: 1256.1,
    prevClose: 1266.98,
    marketCap: 1571503000000,
    pe: 17.65,
    pb: 6.25,
    turnoverRate: 0.2,
  },
  indicators: {
    sampleSize: 250,
    sma50: 1300.97,
    sma200: 1335.94,
    rsi14: 37.02,
    macd: { dif: -11.45, dea: -6.12, hist: -5.33 },
    atr14: 19.27,
    return20d: -4.07,
    sma500: null,
  },
  klines: [
    { date: "2026-09-17", open: 1257.98, close: 1266.98, high: 1267.6, low: 1254, volume: 17554 },
    { date: "2026-09-18", open: 1262.99, close: 1257.12, high: 1265.88, low: 1256.1, volume: 24891 },
  ],
};

const goodJson = JSON.stringify({
  rating: "overweight",
  confidence: 72,
  reasoning: "估值偏低但趋势尚未反转",
  price_target: 1400,
  time_horizon: "3-6 个月",
  sections: {
    snapshot: "贵州茅台，白酒龙头，市值 15715 亿元。",
    fundamentals: "PE 17.65、PB 6.25，处于历史中性偏低区间。",
    technicals: "价格 1257.12 低于 SMA50(1300.97) 与 SMA200(1335.94)，MACD 柱为负。",
    risks: ["趋势仍处下行", "换手率偏低"],
    conclusion: "维持增持，目标区间 1300-1400。",
  },
});

describe("提示词构造器（六段 persona 模板）", () => {
  const { system, user } = buildAnalysisPrompt(sampleInput);

  it("system 含六段模板的全部要件", () => {
    expect(system).toContain("分析师"); // ① 角色定位
    expect(system).toContain("清单"); // ② 清单式思维链
    expect(system).toContain("信号规则"); // ③ 信号规则
    expect(system).toContain("置信度锚定"); // ④ 置信度分档
    expect(system).toContain("硬规则"); // ⑤ 硬规则
    expect(system).toContain("JSON"); // ⑥ JSON-only
  });

  it("system 含点时间约束与反幻觉硬规则", () => {
    expect(system).toContain("数据截至日");
    expect(system).toContain("不要编造");
  });

  it("user 注入身份、数据截至日、快照、指标与 K 线列序说明", () => {
    expect(user).toContain("贵州茅台");
    expect(user).toContain("600519");
    expect(user).toContain("2026-09-18");
    expect(user).toContain("1257.12"); // 最新价
    expect(user).toContain("1300.97"); // SMA50
    expect(user).toContain("date,open,close,high,low,volume"); // 列序声明，防误读
  });

  it("缺失值渲染为「无数据」而非 0 或 null 字样", () => {
    expect(user).toContain("sma500: 无数据");
    expect(user).not.toContain("null");
  });
});

describe("extractJson 三级回退", () => {
  it("① 直接是 JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it("② markdown 代码块包裹", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("③ 前后有杂散文字时提取第一个平衡花括号块", () => {
    expect(extractJson('好的，分析如下：{"a":{"b":2}} 以上。')).toEqual({ a: { b: 2 } });
  });

  it("字符串内的花括号不干扰平衡判断", () => {
    expect(extractJson('前言 {"a":"含 } 和 { 的文本","b":2} 后记')).toEqual({
      a: "含 } 和 { 的文本",
      b: 2,
    });
  });

  it("空内容或完全非 JSON 时抛 ParseError", () => {
    expect(() => extractJson("")).toThrow(ParseError);
    expect(() => extractJson("完全没有 JSON")).toThrow(ParseError);
  });
});

describe("parseAnalysis 校验与空值兜底", () => {
  it("解析合法输出并规范化字段名", () => {
    const a = parseAnalysis(goodJson);
    expect(a.rating).toBe("overweight");
    expect(a.confidence).toBe(72);
    expect(a.priceTarget).toBe(1400);
    expect(a.timeHorizon).toBe("3-6 个月");
    expect(a.sections.risks).toHaveLength(2);
  });

  it("空值字符串转 null（None / N/A / -）", () => {
    const a = parseAnalysis(
      JSON.stringify({
        rating: "hold",
        confidence: 50,
        reasoning: "证据不足",
        price_target: "N/A",
        time_horizon: "None",
        sections: { risks: ["-"] },
      }),
    );
    expect(a.priceTarget).toBeNull();
    expect(a.timeHorizon).toBeNull();
    expect(a.sections.risks).toEqual([]);
  });

  it("置信度越界收敛到 0-100 边界", () => {
    const high = parseAnalysis(JSON.stringify({ rating: "buy", confidence: 130 }));
    const low = parseAnalysis(JSON.stringify({ rating: "sell", confidence: -20 }));
    expect(high.confidence).toBe(100);
    expect(low.confidence).toBe(0);
  });

  it("评级不在 5 档枚举内时抛 ParseError", () => {
    expect(() => parseAnalysis(JSON.stringify({ rating: "strong_buy", confidence: 80 }))).toThrow(
      ParseError,
    );
    expect(() => parseAnalysis(JSON.stringify({ confidence: 80 }))).toThrow(ParseError);
  });

  it("置信度非数字时抛 ParseError", () => {
    expect(() => parseAnalysis(JSON.stringify({ rating: "buy", confidence: "很高" }))).toThrow(
      ParseError,
    );
  });

  it("外围字段缺失时宽容填充而非丢弃整份分析", () => {
    const a = parseAnalysis(JSON.stringify({ rating: "hold", confidence: 45 }));
    expect(a.reasoning).toBe("（模型未给出理由）");
    expect(a.sections.snapshot).toBe("");
    expect(a.sections.risks).toEqual([]);
  });

  it("risks 为单个字符串时包装为数组", () => {
    const a = parseAnalysis(
      JSON.stringify({ rating: "hold", confidence: 45, sections: { risks: "单一风险" } }),
    );
    expect(a.sections.risks).toEqual(["单一风险"]);
  });
});

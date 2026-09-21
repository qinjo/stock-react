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
  implied: {
    impliedRoe: 35.41,
    impliedEps: 71.23,
    impliedBvps: 201.14,
    impliedNetProfit: 8.9e10,
    impliedEquity: 2.51e11,
  },
  tally: {
    bullish: 3,
    bearish: 7,
    neutral: 1,
    total: 11,
    consistency: 0.7,
    maxConfidence: 65,
    items: [
      { name: "价格/SMA50", direction: "bearish", detail: "1257.12 vs 1300.97" },
      { name: "MACD 柱", direction: "bearish", detail: "hist -5.33" },
    ],
  },
  klines: [
    { date: "2026-09-17", open: 1257.98, close: 1266.98, high: 1267.6, low: 1254, volume: 17554 },
    { date: "2026-09-18", open: 1262.99, close: 1257.12, high: 1265.88, low: 1256.1, volume: 24891 },
  ],
  fundamentals: {
    periods: [
      {
        reportDate: "2026-06-30",
        reportName: "2026中报",
        revenue: 92278072083.21,
        revenueYoy: 1.3,
        netProfit: 44516880421.86,
        netProfitYoy: -1.95,
        deductedNetProfit: 4.4e10,
        deductedNetProfitYoy: -2.1,
        roe: 16.75,
        grossMargin: 89.56,
        netMargin: 50.75,
        debtRatio: 15.19,
        bps: 200.99,
        eps: 35.57,
        ocfPerShare: 56.55,
      },
      {
        reportDate: "2025-12-31",
        reportName: "2025年报",
        revenue: 172054000000,
        revenueYoy: -1.2,
        netProfit: 82320000000,
        netProfitYoy: -4.53,
        deductedNetProfit: 8.1e10,
        deductedNetProfitYoy: -5,
        roe: 32.53,
        grossMargin: 91.18,
        netMargin: 50.52,
        debtRatio: 16.41,
        bps: 195.36,
        eps: 65.66,
        ocfPerShare: 56.55,
      },
    ],
    valuation: {
      asOf: "2026-09-18",
      pe: {
        current: 19.3,
        y3: { percentile: 5.6, min: 18.2, median: 28.4, max: 45.6, samples: 730 },
        y5: { percentile: 3.4, min: 17.1, median: 31.2, max: 62.3, samples: 1215 },
      },
      pb: {
        current: 6.25,
        y3: { percentile: 6.3, min: 5.8, median: 9.1, max: 14.2, samples: 730 },
        y5: { percentile: 3.8, min: 5.5, median: 10.4, max: 18.9, samples: 1215 },
      },
    },
    industry: "白酒Ⅱ",
  },
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
  },
  price_target_basis: "以隐含 EPS 71.23 × 合理 PE 18-20 推导",
  invalidation: { price: 1151.01, basis: "近期区间低点", distance_percent: 8.4 },
  data_limits: ["未提供财报明细", "未提供历史估值分位"],
  what_would_change_my_mind: "若价格站稳 SMA50 且 MACD 柱转正",
  monitoring: ["MACD 柱是否收敛", "换手率是否放大"],
});

describe("提示词契约（防止后续改动悄悄丢失关键约束）", () => {
  const { system, user } = buildAnalysisPrompt(sampleInput);

  it("包含角色定位与推理清单", () => {
    expect(system).toContain("分析师");
    expect(system).toContain("推理清单");
  });

  it("包含点时间约束（以数据截至日为今天）", () => {
    expect(system).toContain("数据截至日");
    expect(system).toContain("当作今天");
  });

  it("包含禁止编造数字", () => {
    expect(system).toMatch(/绝不编造|不得编造|不编造/);
  });

  it("包含具名谬误清单（线性外推/基数/因果/选择性用数）", () => {
    expect(system).toContain("线性外推");
    expect(system).toContain("基数");
    expect(system).toContain("相关当因果");
    expect(system).toContain("选择性用数");
  });

  it("包含输出前自检清单", () => {
    expect(system).toContain("自检");
  });

  it("规定 fundamentals 字数下限（治空泛）", () => {
    expect(system).toMatch(/至少 \d+ 字/);
  });

  it("用可数一致性约束 confidence 上限", () => {
    expect(system).toContain("confidence 上限");
    expect(system).toMatch(/不得超过/);
  });

  it("禁用 hold 作为「看不清」的逃生舱", () => {
    expect(system).toMatch(/不允许因为|势均力敌/);
  });

  it("要求目标价双轨（有锚给推导，无锚说明缺什么）", () => {
    expect(system).toContain("price_target_basis");
    expect(system).toMatch(/推导路径|缺什么数据/);
  });

  it("要求给出判断失效位", () => {
    expect(system).toContain("invalidation");
    expect(system).toMatch(/区间低点|SMA50|2×ATR|2xATR/);
  });

  it("schema 字段名齐全（含新增字段）", () => {
    for (const key of [
      "rating",
      "confidence",
      "reasoning",
      "price_target",
      "price_target_basis",
      "time_horizon",
      "invalidation",
      "sections",
      "data_limits",
      "what_would_change_my_mind",
      "monitoring",
    ]) {
      expect(system, `schema 缺少字段 ${key}`).toContain(key);
    }
    // conclusion 已按调研结论删除
    expect(system).not.toMatch(/"conclusion"/);
  });
});

describe("提示词的数据注入", () => {
  const { system, user } = buildAnalysisPrompt(sampleInput);

  it("user 注入身份与数据截至日", () => {
    expect(user).toContain("贵州茅台");
    expect(user).toContain("600519");
    expect(user).toContain("2026-09-18");
  });

  it("user 注入隐含估值量（PE/PB 推导，零外部数据）", () => {
    expect(user).toContain("隐含 ROE");
    expect(user).toContain("35.41%");
    expect(user).toContain("71.23"); // 隐含 EPS
  });

  it("user 注入多空一致性统计与 confidence 上限", () => {
    expect(user).toContain("看多 3 项");
    expect(user).toContain("看空 7 项");
    expect(user).toContain("confidence 上限：65");
  });

  it("user 声明数据边界，避免模型用常识填空", () => {
    expect(user).toContain("数据边界");
    expect(user).toContain("未提供");
    expect(user).toContain("历史估值分位");
  });

  it("K 线列序有表头声明，防误读", () => {
    expect(user).toContain("date,open,close,high,low,volume");
  });

  it("缺失值渲染为「无数据」而非 null 字样", () => {
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

describe("新增 schema 字段的解析", () => {
  it("解析目标价推导依据与失效位", () => {
    const a = parseAnalysis(goodJson);
    expect(a.priceTargetBasis).toContain("隐含 EPS");
    expect(a.invalidation).toEqual({
      price: 1151.01,
      basis: "近期区间低点",
      distancePercent: 8.4,
    });
  });

  it("解析数据边界、证伪条件与监控指标", () => {
    const a = parseAnalysis(goodJson);
    expect(a.dataLimits).toHaveLength(2);
    expect(a.whatWouldChangeMyMind).toContain("SMA50");
    expect(a.monitoring).toHaveLength(2);
  });

  it("失效位缺价格或格式异常时为 null（不伪造）", () => {
    const noPrice = parseAnalysis(
      JSON.stringify({ rating: "hold", confidence: 50, invalidation: { basis: "SMA50" } }),
    );
    expect(noPrice.invalidation).toBeNull();

    const malformed = parseAnalysis(
      JSON.stringify({ rating: "hold", confidence: 50, invalidation: "SMA50" }),
    );
    expect(malformed.invalidation).toBeNull();
  });

  it("失效位支持 camelCase 变体（模型偶发不遵守 snake_case）", () => {
    const a = parseAnalysis(
      JSON.stringify({
        rating: "hold",
        confidence: 50,
        invalidation: { price: 100, basis: "SMA50", distancePercent: 5 },
      }),
    );
    expect(a.invalidation?.distancePercent).toBe(5);
  });

  it("sections 不再包含 conclusion（已按调研结论删除）", () => {
    const a = parseAnalysis(goodJson);
    expect(a.sections).not.toHaveProperty("conclusion");
    expect(Object.keys(a.sections).sort()).toEqual([
      "fundamentals",
      "risks",
      "snapshot",
      "technicals",
    ]);
  });

  it("新字段全部缺失时优雅降级（空数组/空串而非崩溃）", () => {
    const a = parseAnalysis(JSON.stringify({ rating: "hold", confidence: 50 }));
    expect(a.priceTargetBasis).toBeNull();
    expect(a.invalidation).toBeNull();
    expect(a.dataLimits).toEqual([]);
    expect(a.whatWouldChangeMyMind).toBe("");
    expect(a.monitoring).toEqual([]);
  });
});


describe("数据边界是动态生成的（不再声明其实已有的数据）", () => {
  it("未提供财报与分位时，明确声明这两项缺失", () => {
    const { user } = buildAnalysisPrompt({ ...sampleInput, fundamentals: null });
    expect(user).toContain("未提供");
    expect(user).toContain("财务报表明细");
    expect(user).toContain("历史估值分位");
  });

  it("提供财报与分位后，改列为「已提供」且不再声明缺失估值分位", () => {
    const { user } = buildAnalysisPrompt(sampleInput);
    expect(user).toContain("已提供");
    expect(user).toContain("财务主指标（近 2 期");
    expect(user).toContain("历史估值分位（PE/PB 近 3 年与近 5 年）");
    // 这是本次改造的核心：不能再让模型说"未提供历史估值分位"
    expect(user).not.toMatch(/未提供[^。]*历史估值分位/);
    expect(user).toContain("同业个股对比数据"); // 该项仍未提供，应如实声明
  });

  it("渲染财报表格（亿元换算 + YTD 口径声明）", () => {
    const { user } = buildAnalysisPrompt(sampleInput);
    expect(user).toContain("2026中报");
    expect(user).toContain("922.78"); // 营收亿元化
    expect(user).toContain("年内累计");
  });

  it("渲染估值分位（含区间/中位/样本数）", () => {
    const { user } = buildAnalysisPrompt(sampleInput);
    expect(user).toContain("近3年 5.6% 分位");
    expect(user).toContain("近5年 3.4% 分位");
    expect(user).toContain("样本 730 日");
    expect(user).toContain("白酒Ⅱ");
  });
});

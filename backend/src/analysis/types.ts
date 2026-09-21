import type { ImpliedValuation, SignalTally } from "../derived.js";

/** 分析领域类型：LLM 输出契约与编排结果。 */

/** 5 档评级（与 TradingAgents 的 5 档体系对齐）。 */
export const RATINGS = ["buy", "overweight", "hold", "underweight", "sell"] as const;
export type Rating = (typeof RATINGS)[number];

/**
 * 报告分节：①快照 ②基本面 ③技术面 ④风险清单。
 *
 * 注意：**已删除 conclusion 段**（调研结论：顶层已有 rating，再写 conclusion
 * 只会产出"综上所述"式套话；收尾改为 whatWouldChangeMyMind + monitoring）。
 */
export type AnalysisSections = {
  snapshot: string;
  fundamentals: string;
  technicals: string;
  risks: string[];
};

/** 判断失效位：价格触及此位则原结论需重新评估。 */
export type Invalidation = {
  price: number;
  /** 选取依据（区间低点 / SMA50 / SMA200 / 价-2ATR） */
  basis: string;
  /** 距当前价的百分比（正=需下跌，负=需上涨） */
  distancePercent: number | null;
};

/** LLM 返回的结构化信号（原始契约，字段名与提示词一致）。 */
export type RawAnalysis = {
  rating: Rating;
  confidence: number;
  reasoning: string;
  price_target: number | null;
  price_target_basis: string | null;
  time_horizon: string | null;
  invalidation: { price: number; basis: string; distance_percent: number | null } | null;
  sections: AnalysisSections;
  data_limits: string[];
  what_would_change_my_mind: string;
  monitoring: string[];
};

/** 规范化后的分析结果（供 API 与 UI 使用）。 */
export type Analysis = {
  rating: Rating;
  confidence: number;
  reasoning: string;
  priceTarget: number | null;
  /** 目标价推导路径；为 null 时必须说明缺什么数据（由提示词强制） */
  priceTargetBasis: string | null;
  timeHorizon: string | null;
  invalidation: Invalidation | null;
  sections: AnalysisSections;
  /** 数据边界：本次未提供的数据维度及其对结论的限制 */
  dataLimits: string[];
  /** 什么可观察信号会改变该判断 */
  whatWouldChangeMyMind: string;
  /** 需持续跟踪的指标与阈值 */
  monitoring: string[];
};

/**
 * 编排结果：区分「有结论」与「无法判断」。
 *
 * abstain 契约来自调研笔记：LLM 失败或数据不足时**绝不静默变成中性观点**，
 * 否则会污染信号语义（看空 ≠ 无法判断）。
 */
export type AnalysisOutcome =
  | {
      status: "ok";
      analysis: Analysis;
      model: string;
      analyzedAt: string;
      fromCache: boolean;
      /** 本次（或首次分析时）的 token 用量；数据源未返回时为 undefined */
      usage?: TokenUsage;
    }
  | { status: "abstained"; reason: string; detail: string };

/** LLM 调用的 token 用量（用于成本可观测）。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中服务端提示词缓存的输入 token（DeepSeek 自动缓存，计价更低） */
  cachedTokens?: number;
};

/** 分析输入：冻结的确定性域对象（不触网，便于测试与缓存指纹）。 */
export type AnalysisInput = {
  code: string;
  name: string;
  /** 数据截至日（点时间约束：模型须以此日为「今天」） */
  dataDate: string;
  quote: {
    price: number | null;
    changePercent: number | null;
    open: number | null;
    high: number | null;
    low: number | null;
    prevClose: number | null;
    marketCap: number | null;
    pe: number | null;
    pb: number | null;
    turnoverRate: number | null;
  };
  indicators: Record<string, unknown>;
  /** 隐含估值量（由 PE/PB 推导，零外部数据）；缺省表示未计算 */
  implied?: ImpliedValuation | null;
  /** 12 项指标的多空一致性统计（用于校准 confidence 上限） */
  tally?: SignalTally;
  /** 截尾日 K（喂给模型以感知近期形态） */
  klines: Array<{ date: string; open: number; close: number; high: number; low: number; volume: number }>;
};

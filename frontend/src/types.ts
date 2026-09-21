/** 前端领域类型：与后端 domain.ts 对应（独立声明，保持前端可独立构建）。 */

export type SearchCandidate = {
  code: string;
  name: string;
  secid: string;
  market: string;
  pinyin: string;
};

export type Quote = {
  code: string;
  name: string;
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  changePercent: number | null;
  limitUp: number | null;
  limitDown: number | null;
  volume: number | null;
  amount: number | null;
  marketCap: number | null;
  floatMarketCap: number | null;
  pe: number | null;
  pb: number | null;
  turnoverRate: number | null;
};

export type Kline = {
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  volume: number;
  amount: number | null;
  amplitude: number | null;
  changePercent: number | null;
  changeAmount: number | null;
  turnoverRate: number | null;
};

export type ApiErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "INSUFFICIENT_DATA"
  | "ANALYSIS_FAILED";

export type ApiErrorBody = {
  status: "error";
  code: ApiErrorCode;
  message: string;
};

/** 数据源不可用 / 输入错误等，携带 code 便于 UI 分流展示。 */
export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/* ------------------------------ 分析（T5） ------------------------------ */

export type Rating = "buy" | "overweight" | "hold" | "underweight" | "sell";

/** 5 档评级的中文展示名。 */
export const RATING_LABELS: Record<Rating, string> = {
  buy: "买入",
  overweight: "增持",
  hold: "持有",
  underweight: "减持",
  sell: "卖出",
};

/** 报告分节（conclusion 已删除：顶层 rating + 收尾三块已覆盖其作用）。 */
export type AnalysisSections = {
  snapshot: string;
  fundamentals: string;
  technicals: string;
  risks: string[];
};

/** 判断失效位：价格触及此位则原结论需重新评估。 */
export type Invalidation = {
  price: number;
  basis: string;
  distancePercent: number | null;
};

export type Analysis = {
  rating: Rating;
  confidence: number;
  reasoning: string;
  priceTarget: number | null;
  /** 目标价推导路径，或说明缺什么数据 */
  priceTargetBasis: string | null;
  timeHorizon: string | null;
  invalidation: Invalidation | null;
  sections: AnalysisSections;
  /** 数据边界：本次未提供的数据维度及其对结论的限制 */
  dataLimits: string[];
  /** 什么可观察信号会改变该判断 */
  whatWouldChangeMyMind: string;
  /** 后续需跟踪的指标与阈值 */
  monitoring: string[];
};

/** LLM 调用的 token 用量（成本可观测）。 */
export type TokenUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** 命中 DeepSeek 服务端提示词缓存的输入 token（计价更低） */
  cachedTokens?: number;
};

export type AnalyzeResponse = {
  status: "ok";
  analysis: Analysis;
  model: string;
  analyzedAt: string;
  fromCache: boolean;
  /** 数据源未返回用量时缺省，UI 据此决定是否展示 */
  usage?: TokenUsage;
  input: { code: string; name: string; dataDate: string };
};

/* ------------------------- 技术指标（T3 后端产出） ------------------------- */

export type Indicators = {
  sampleSize: number;
  fromDate: string;
  toDate: string;
  sma50: number | null;
  sma200: number | null;
  priceVsSma50: number | null;
  priceVsSma200: number | null;
  rsi14: number | null;
  macd: { dif: number | null; dea: number | null; hist: number | null };
  atr14: number | null;
  atrPercent: number | null;
  return20d: number | null;
  return60d: number | null;
  volatility20d: number | null;
  periodHigh: number;
  periodLow: number;
  positionInRange: number | null;
};

/* --------------------------- 基本面（数据层） --------------------------- */

export type FinancialPeriod = {
  reportDate: string;
  reportName: string;
  revenue: number | null;
  revenueYoy: number | null;
  netProfit: number | null;
  netProfitYoy: number | null;
  deductedNetProfit: number | null;
  deductedNetProfitYoy: number | null;
  roe: number | null;
  grossMargin: number | null;
  netMargin: number | null;
  debtRatio: number | null;
  bps: number | null;
  eps: number | null;
  ocfPerShare: number | null;
};

export type PercentileStats = {
  percentile: number;
  min: number;
  median: number;
  max: number;
  samples: number;
};

export type MetricPercentiles = {
  current: number | null;
  y3: PercentileStats | null;
  y5: PercentileStats | null;
};

export type ValuationPercentiles = {
  asOf: string | null;
  pe: MetricPercentiles;
  pb: MetricPercentiles;
};

export type PeerStats = {
  median: number;
  p25: number;
  p75: number;
  min: number;
  max: number;
  count: number;
};

export type PeerComparison = {
  industry: string;
  boardCode: string;
  tradeDate: string;
  peerCount: number;
  pe: PeerStats | null;
  pb: PeerStats | null;
  pePremium: number | null;
  pbPremium: number | null;
  peRank: number | null;
  cheaperPeers: number | null;
};

export type Fundamentals = {
  periods: FinancialPeriod[];
  valuation: ValuationPercentiles;
  industry: string | null;
  peers?: PeerComparison | null;
};

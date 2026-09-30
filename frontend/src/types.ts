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
  | "ANALYSIS_FAILED"
  /** 本地日K库尚未初始化：与 SOURCE_UNAVAILABLE 区分，因为用户要采取的动作不同 */
  | "DATA_NOT_READY";

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
  /** 书的均线阶梯：核心选股判据是「收盘价 > MA100」 */
  ma: {
    ma5: number | null;
    ma10: number | null;
    ma20: number | null;
    ma60: number | null;
    ma100: number | null;
    ma120: number | null;
    ma144: number | null;
  };
  /** 最新收盘相对 MA100 的偏离（%）：正=在 MA100 上方 */
  priceVsMa100: number | null;
  /** 周线重采样后的 MA20（书 L500：周线 MA20 ≡ 日线 MA100） */
  weeklyMa20: number | null;
  /** 周线样本根数（含当前尚未走完的一周） */
  weeklySampleSize: number;
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

/* --------------------------- 短线筛选器 (#16) --------------------------- */

/** 规则来源：书内带行号 / 书内但阈值为推断 / 项目自加的补丁 */
export type RuleSource = "book" | "inferred" | "offbook";

export type ScreenRuleHit = {
  id: string;
  label: string;
  source: RuleSource;
  /** 书内定位，如 `L597` */
  bookRef?: string;
  /** 阈值与实测值的对照 */
  detail: string;
  /** 因缺数据而未判定 */
  unknown: boolean;
};

export type ScreenMetrics = {
  lastClose: number | null;
  changePercent: number | null;
  ma100: number | null;
  /** 后复权收盘相对 MA100 的偏离（比值，非百分比） */
  ma100Deviation: number | null;
  /** 最近一次上穿 MA100 距今多少根；从未上穿为 null */
  barsSinceMa100Cross: number | null;
  trendR2: number | null;
  floatMarketCap: number | null;
  turnoverAmount: number | null;
};

export type SignalId = "S1" | "S2" | "S3" | "S5" | "S13";

export type SignalHit = {
  id: SignalId;
  label: string;
  /** 档序：数字越小越强 */
  tier: number;
  detail: string;
  /** 书内定位，如 L681 */
  bookRef: string;
};

export type SignalSet = {
  signals: SignalHit[];
  /** 最强信号的档序；无信号为 null */
  bestTier: number | null;
};

export type StopBasis = "low123" | "ma-pairing" | "fixed-ratio";

/** 离场计划。**刻意没有"目标价"**：源书的逻辑是跟随趋势直到结构破坏，而不是到价卖出。 */
export type ExitPlan = {
  /** 入场参考价（最新不复权收盘） */
  entry: number;
  /** 止损位（真实成交价口径） */
  stop: number;
  stopBasis: StopBasis;
  stopBasisLabel: string;
  /** 止损空间占入场价比例 */
  stopSpace: number;
  /** 信号失效条件 */
  invalidation: string;
  /** 分批止盈规则 */
  scaleOut: string;
  bookRef: string;
};

/** 参考压力位：可能受阻的位置，不是涨幅预测。 */
export type ReferenceResistance = {
  kind: "prior-high" | "range-high";
  price: number;
  detail: string;
};

export type ScreenCandidate = {
  code: string;
  /** bootstrap 阶段为空，待行情快照回填 */
  name: string | null;
  price: number | null;
  changePercent: number | null;
  metrics: ScreenMetrics;
  ruleHits: ScreenRuleHit[];
  /** 扣分项 / 未判定项 */
  deductions: string[];
  /** 命中的入场信号（按档序升序） */
  signals: SignalSet;
  /** 最强信号的档序，越小越强 */
  signalTier: number | null;
  exit: ExitPlan;
  resistance: ReferenceResistance[];
};

export type ScreenFunnel = {
  universe: number;
  afterExclusions: number;
  afterHardFilters: number;
  shortlisted: number;
  /** 通过信号层与止损空间闸门的数量 */
  signalEligible: number;
};

export type ScreenMode = "trend" | "event";
export type Strictness = "loose" | "standard" | "strict";
export type BoardName = "main" | "growth" | "star" | "bj";

export type ScreenParams = {
  mode: ScreenMode;
  strictness: Strictness;
  boards: BoardName[];
  ignoreMarketGate: boolean;
  refresh: boolean;
};

export type ScreenResponse = {
  status: "ok";
  /** 库内最新交易日 `YYYY-MM-DD` */
  dataDate: string;
  refreshedAt: string;
  params: ScreenParams;
  funnel: ScreenFunnel;
  /** 通过基础池的总数；candidates 是它的前 N 个 */
  candidateTotal: number;
  candidates: ScreenCandidate[];
  /** 当前并未真正生效的规则 */
  inactiveRules: string[];
  /** `llmReview: true` 表示本次结果未经大模型复核（降级） */
  degraded: { llmReview: boolean; reason: string | null };
  /** 本次结果直接来自当日缓存（零额外计算） */
  fromCache: boolean;
  /** 惰性刷新的执行情况：库落后时后端会先补当日行情再筛 */
  increment: IncrementSummary;
};

/** 惰性刷新（每日增量）的执行摘要。 */
export type IncrementSummary = {
  /** 是否真的尝试了增量 */
  ran: boolean;
  /** 增量失败：此时仍用库内既有数据出结果，必须在界面上如实标注 */
  failed: boolean;
  error: string | null;
  /** 快照所属交易日 */
  snapshotDate: number | null;
  barsWritten: number;
  barsRefreshed: number;
  exDividends: number;
  namesUpdated: number;
  marketCapsUpdated: number;
  skippedTotal: number;
  durationMs: number;
};

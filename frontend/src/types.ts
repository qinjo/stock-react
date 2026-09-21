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

export type AnalysisSections = {
  snapshot: string;
  fundamentals: string;
  technicals: string;
  risks: string[];
  conclusion: string;
};

export type Analysis = {
  rating: Rating;
  confidence: number;
  reasoning: string;
  priceTarget: number | null;
  timeHorizon: string | null;
  sections: AnalysisSections;
};

export type AnalyzeResponse = {
  status: "ok";
  analysis: Analysis;
  model: string;
  analyzedAt: string;
  fromCache: boolean;
  input: { code: string; name: string; dataDate: string };
};

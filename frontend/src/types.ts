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

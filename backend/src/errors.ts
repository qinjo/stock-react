/** 统一 API 错误形状：{ status, code, message }。 */
export type ApiErrorCode =
  | "INVALID_INPUT"
  | "RATE_LIMITED"
  | "NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "INSUFFICIENT_DATA"
  | "ANALYSIS_FAILED"
  /**
   * 本地日K库尚未初始化。刻意与 SOURCE_UNAVAILABLE 区分：
   * 后者的语义是"外部数据源挂了"，而这是"你还没做初始化"——一个**可操作**的状态，
   * 混在一起会让用户看到一句误导性的"数据源不可用"。
   */
  | "DATA_NOT_READY";

export type ApiErrorBody = {
  status: "error";
  code: ApiErrorCode;
  message: string;
};

export class ApiError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly httpStatus = 400,
  ) {
    super(message);
    this.name = "ApiError";
  }

  toBody(): ApiErrorBody {
    return { status: "error", code: this.code, message: this.message };
  }
}

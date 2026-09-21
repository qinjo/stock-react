/** 统一 API 错误形状：{ status, code, message }。 */
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

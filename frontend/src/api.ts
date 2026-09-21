import {
  ApiError,
  type AnalyzeResponse,
  type ApiErrorBody,
  type Fundamentals,
  type Indicators,
  type Kline,
  type Quote,
  type SearchCandidate,
} from "./types";

async function request<T>(url: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    throw new ApiError("SOURCE_UNAVAILABLE", "无法连接服务，请确认后端已启动", 0);
  }

  if (!res.ok) {
    let body: ApiErrorBody | null = null;
    try {
      body = (await res.json()) as ApiErrorBody;
    } catch {
      body = null;
    }
    throw new ApiError(
      body?.code ?? "SOURCE_UNAVAILABLE",
      body?.message ?? `请求失败：HTTP ${res.status}`,
      res.status,
    );
  }

  return (await res.json()) as T;
}

export async function searchStocks(q: string, signal?: AbortSignal): Promise<SearchCandidate[]> {
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { candidates: SearchCandidate[] };
  return data.candidates;
}

export function getQuote(code: string): Promise<Quote> {
  return request<{ quote: Quote }>(`/api/quote?code=${encodeURIComponent(code)}`).then((d) => d.quote);
}

export function getKline(code: string, limit = 60): Promise<Kline[]> {
  return request<{ klines: Kline[] }>(
    `/api/kline?code=${encodeURIComponent(code)}&limit=${limit}`,
  ).then((d) => d.klines);
}

/* ------------------------------ 分析（T5） ------------------------------ */

/** 请求 AI 分析。数据不足/分析失败会以 ApiError(code) 抛出，由 UI 分流展示。 */
export function getAnalysis(code: string): Promise<AnalyzeResponse> {
  return request<AnalyzeResponse>(`/api/analyze?code=${encodeURIComponent(code)}`);
}

/** 派生技术指标（后端已算好，前端只做展示）。 */
export function getIndicators(code: string, limit = 250): Promise<Indicators> {
  return request<{ indicators: Indicators }>(
    `/api/indicators?code=${encodeURIComponent(code)}&limit=${limit}`,
  ).then((d) => d.indicators);
}

/** 基本面数据（财报 + 估值分位 + 同业对比），不消耗 LLM 调用。 */
export function getFundamentals(code: string): Promise<Fundamentals> {
  return request<{ fundamentals: Fundamentals }>(
    `/api/fundamentals?code=${encodeURIComponent(code)}`,
  ).then((d) => d.fundamentals);
}

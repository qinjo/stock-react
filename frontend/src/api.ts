import { ApiError, type ApiErrorBody, type Kline, type Quote, type SearchCandidate } from "./types";

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

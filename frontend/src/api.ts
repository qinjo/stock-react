import {
  ApiError,
  type AnalyzeResponse,
  type ApiErrorBody,
  type BoardName,
  type Fundamentals,
  type Indicators,
  type Kline,
  type Quote,
  type ScreenMode,
  type ScreenResponse,
  type SearchCandidate,
  type Strictness,
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

/**
 * 请求 AI 分析。数据不足/分析失败会以 ApiError(code) 抛出，由 UI 分流展示。
 *
 * `view="short"` 走短线操盘框架（筛选器候选卡片上的「深度分析」）：判据是
 * MA100 位置 / 结构形态 / 离场条件 / 仓位建议，**不出目标价**。
 */
export function getAnalysis(code: string, view: "general" | "short" = "general"): Promise<AnalyzeResponse> {
  const suffix = view === "short" ? "&view=short" : "";
  return request<AnalyzeResponse>(`/api/analyze?code=${encodeURIComponent(code)}${suffix}`);
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

/* --------------------------- 短线筛选器 (#16) --------------------------- */

export type ScreenQuery = {
  mode?: ScreenMode;
  strictness?: Strictness;
  boards?: BoardName[];
  ignoreMarketGate?: boolean;
  refresh?: boolean;
  signal?: AbortSignal;
};

/**
 * 全市场筛选。库未初始化时会以 `ApiError("DATA_NOT_READY")` 抛出，
 * 由界面分流成"请先初始化"而不是"数据源不可用"。
 */
export function getScreen(query: ScreenQuery = {}): Promise<ScreenResponse> {
  const search = new URLSearchParams();
  if (query.mode) search.set("mode", query.mode);
  if (query.strictness) search.set("strictness", query.strictness);
  if (query.boards) search.set("boards", query.boards.join(","));
  if (query.ignoreMarketGate) search.set("ignoreMarketGate", "true");
  if (query.refresh) search.set("refresh", "true");

  const suffix = search.toString();
  return request<ScreenResponse>(`/api/screen${suffix ? `?${suffix}` : ""}`);
}

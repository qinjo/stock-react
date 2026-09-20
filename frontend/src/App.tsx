import { useEffect, useState } from "react";
import KlineChart from "./components/KlineChart";
import QuoteCard from "./components/QuoteCard";
import SearchBox from "./components/SearchBox";
import { getKline, getQuote } from "./api";
import { ApiError, type ApiErrorCode, type Kline, type Quote, type SearchCandidate } from "./types";

type Health = { status: string; service: string; time: string };

/** 已选股票的取数状态机。 */
type StockState =
  | { kind: "idle" }
  | { kind: "loading"; candidate: SearchCandidate }
  | { kind: "success"; candidate: SearchCandidate; quote: Quote; klines: Kline[] }
  | { kind: "error"; code: ApiErrorCode; message: string };

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [stock, setStock] = useState<StockState>({ kind: "idle" });

  // 后端连通状态（T1）
  useEffect(() => {
    let cancelled = false;
    fetch("/api/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data: Health) => {
        if (!cancelled) setHealth(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setBackendError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSelect(candidate: SearchCandidate) {
    setStock({ kind: "loading", candidate });
    try {
      const [quote, klines] = await Promise.all([
        getQuote(candidate.code),
        getKline(candidate.code, 60),
      ]);
      setStock({ kind: "success", candidate, quote, klines });
    } catch (err) {
      if (err instanceof ApiError) {
        setStock({ kind: "error", code: err.code, message: err.message });
      } else {
        setStock({
          kind: "error",
          code: "SOURCE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "取数失败",
        });
      }
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white px-6 py-4">
        <h1 className="text-xl font-semibold">A股智能分析</h1>
        <p className="mt-1 text-sm text-slate-500">
          输入股票代码或名称，获取行情与 AI 分析（AI 分析开发中）
        </p>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <SearchBox onSelect={handleSelect} disabled={stock.kind === "loading"} />
        </div>

        {stock.kind === "loading" && (
          <p className="text-sm text-slate-500" role="status">
            正在获取 {stock.candidate.name} 的行情数据…
          </p>
        )}

        {stock.kind === "error" && (
          <div
            role="alert"
            className={`rounded-lg border p-4 text-sm ${
              stock.code === "SOURCE_UNAVAILABLE"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-red-200 bg-red-50 text-red-700"
            }`}
          >
            <p className="font-medium">
              {stock.code === "SOURCE_UNAVAILABLE" ? "数据源暂时不可用" : "请求失败"}
            </p>
            <p className="mt-1">{stock.message}</p>
            {stock.code === "SOURCE_UNAVAILABLE" && (
              <p className="mt-1 text-xs">
                可能是数据源限流（东财有 IP 级反爬），请稍后重试。
              </p>
            )}
          </div>
        )}

        {stock.kind === "success" && (
          <>
            <QuoteCard quote={stock.quote} dataDate={stock.klines.at(-1)?.date} />
            <KlineChart klines={stock.klines} symbol={stock.candidate.code} />
          </>
        )}
      </main>

      <footer className="mx-auto max-w-3xl px-6 pb-8 text-xs text-slate-400">
        {backendError ? (
          <span className="text-red-500" role="alert">
            无法连接后端：{backendError}
          </span>
        ) : health ? (
          <span>
            {health.service} · {health.status}
          </span>
        ) : (
          <span>检测后端状态…</span>
        )}
      </footer>
    </div>
  );
}

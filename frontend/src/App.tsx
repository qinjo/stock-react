import { useEffect, useState } from "react";
import AnalysisPanel from "./components/AnalysisPanel";
import FundamentalsPanel from "./components/FundamentalsPanel";
import IndicatorPanel from "./components/IndicatorPanel";
import KlineChart from "./components/KlineChart";
import QuoteCard from "./components/QuoteCard";
import SearchBox from "./components/SearchBox";
import { getFundamentals, getIndicators, getKline, getQuote } from "./api";
import {
  ApiError,
  type ApiErrorCode,
  type Fundamentals,
  type Indicators,
  type Kline,
  type Quote,
  type SearchCandidate,
} from "./types";

type Health = { status: string; service: string; time: string; analysisReady?: boolean };

/** 已选股票的取数状态机。 */
type StockState =
  | { kind: "idle" }
  | { kind: "loading"; candidate: SearchCandidate }
  | {
      kind: "success";
      candidate: SearchCandidate;
      quote: Quote;
      klines: Kline[];
      indicators: Indicators | null;
      fundamentals: Fundamentals | null;
    }
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
      // K 线取 250 根：既供图表叠加 MA200，也与指标样本区间一致
      const [quote, klines, indicators, fundamentals] = await Promise.all([
        getQuote(candidate.code),
        getKline(candidate.code, 250),
        // 指标/基本面失败不该拖垮行情展示（各自降级为不显示对应面板）
        getIndicators(candidate.code).catch(() => null),
        getFundamentals(candidate.code).catch(() => null),
      ]);
      setStock({ kind: "success", candidate, quote, klines, indicators, fundamentals });
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
      <header className="border-b border-slate-200 bg-white px-6 py-4 lg:px-10">
        <h1 className="text-xl font-semibold">A股智能分析</h1>
        <p className="mt-1 text-sm text-slate-500">
          输入股票代码或名称，获取行情、技术指标与 AI 分析
        </p>
      </header>

      <main className="w-full space-y-6 px-6 py-8 lg:px-10">
        <div className="max-w-2xl rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
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

        {/*
          宽屏两栏：左栏行情常驻（sticky），右栏 AI 分析。
          —— 读长报告时行情/图表不会滚走，便于随时对照。
          窄屏（<lg）自动降级为单列堆叠。
        */}
        {stock.kind === "success" && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,32rem)_minmax(0,1fr)] lg:items-start">
            {/*
              左栏在宽屏下高度贴合视口：flex 列 + 固定视口高度，
              K 线图吃掉剩余空间（fillHeight），从而不出现「左栏内部滚动条」；
              overflow-y-auto 仅作极矮视口的兜底。
            */}
            <aside className="space-y-6 lg:sticky lg:top-6 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col lg:gap-6 lg:space-y-0 lg:self-start lg:overflow-y-auto">
              <QuoteCard quote={stock.quote} dataDate={stock.klines.at(-1)?.date} />
              <KlineChart klines={stock.klines} symbol={stock.candidate.code} fillHeight />
              {stock.indicators && <IndicatorPanel indicators={stock.indicators} />}
            </aside>

            <div className="space-y-6">
              {/* 基本面数据先于 AI 分析呈现：不消耗 LLM，选中即可看 */}
              {stock.fundamentals && <FundamentalsPanel fundamentals={stock.fundamentals} />}
              {/* key 确保换股票时分析状态重置 */}
              <AnalysisPanel
                key={stock.candidate.code}
                code={stock.candidate.code}
                name={stock.candidate.name}
              />
            </div>
          </div>
        )}
      </main>

      <footer className="w-full space-y-2 px-6 pb-8 text-xs text-slate-400 lg:px-10">
        <p className="rounded border border-slate-200 bg-white px-3 py-2 text-slate-500">
          ⚠️ 本页所有分析由 AI 生成，仅供学习与研究参考，<strong>不构成任何投资建议</strong>。
          数据来自公开免费接口，可能存在延迟或错误，请以交易所披露为准。
        </p>
        {backendError ? (
          <span className="text-red-500" role="alert">
            无法连接后端：{backendError}
          </span>
        ) : health ? (
          <span>
            {health.service} · {health.status}
            {health.analysisReady === false && " · 分析未就绪（未配置 API key）"}
          </span>
        ) : (
          <span>检测后端状态…</span>
        )}
      </footer>
    </div>
  );
}

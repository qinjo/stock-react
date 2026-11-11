import { useEffect, useState } from "react";
import AnalysisPanel from "./components/AnalysisPanel";
import BacktestPanel from "./components/BacktestPanel";
import FundamentalsPanel from "./components/FundamentalsPanel";
import IndicatorPanel from "./components/IndicatorPanel";
import KlineChart from "./components/KlineChart";
import QuoteCard from "./components/QuoteCard";
import ScreenerPanel from "./components/ScreenerPanel";
import SearchBox from "./components/SearchBox";
import { Panel } from "./components/ui/Panel";
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
/** 单票分析的目标：搜索补全给完整候选，筛选器只给代码与名称，故用最小形状。 */
type StockTarget = { code: string; name: string };

type StockState =
  | { kind: "idle" }
  | { kind: "loading"; target: StockTarget }
  | {
      kind: "success";
      target: StockTarget;
      quote: Quote;
      klines: Kline[];
      indicators: Indicators | null;
      fundamentals: Fundamentals | null;
    }
  | { kind: "error"; code: ApiErrorCode; message: string };

type Mode = "single" | "screener" | "backtest";

/**
 * 三个一级栏目：单票分析｜短线筛选器｜策略回测（不引入路由）。
 * 布局上它们共用同一套「左侧导航 + 顶部栏 + 面板」外壳，切换只换主内容区。
 */
const MODE_TABS: Array<{
  value: Mode;
  label: string;
  hint: string;
  eyebrow: string;
  title: string;
  description: string;
}> = [
  {
    value: "single",
    label: "单票分析",
    hint: "行情 · 指标",
    eyebrow: "Single Stock",
    title: "个股研判",
    description: "输入股票代码或名称，获取行情、技术指标与 AI 分析",
  },
  {
    value: "screener",
    label: "短线筛选器",
    hint: "规则筛选",
    eyebrow: "Screener",
    title: "全市场短线筛选",
    description: "按《短线操盘实战技法》的规则筛选全市场，点候选股进入单票分析",
  },
  {
    value: "backtest",
    label: "策略回测",
    hint: "历史回放",
    eyebrow: "Backtest",
    title: "规则历史回放",
    description:
      "把「热门+涨停 → KDJ 金叉买/死叉清」这套规则在历史上机械回放，看它在不同股票上的表现",
  },
];

/** 导航图标：纯装饰，不参与可访问名（按钮另有 aria-label）。 */
function TabIcon({ mode }: { mode: Mode }) {
  const common = "h-4 w-4 shrink-0";
  if (mode === "screener") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 5h18M6 12h12M10 19h4" />
      </svg>
    );
  }
  if (mode === "backtest") {
    return (
      <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 17l5-5 4 3 8-9" />
        <path d="M21 6v5h-5" />
      </svg>
    );
  }
  return (
    <svg className={common} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 19V9M10 19V5M16 19v-7M22 19H2" />
    </svg>
  );
}

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [backendError, setBackendError] = useState<string | null>(null);
  const [stock, setStock] = useState<StockState>({ kind: "idle" });
  const [mode, setMode] = useState<Mode>("single");

  const current = MODE_TABS.find((tab) => tab.value === mode) ?? MODE_TABS[0]!;

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

  /** 打开一只股票：搜索框与筛选器候选共用这一条取数路径。 */
  async function openStock(target: StockTarget) {
    setStock({ kind: "loading", target });
    try {
      // K 线取 250 根：既供图表叠加 MA200，也与指标样本区间一致
      const [quote, klines, indicators, fundamentals] = await Promise.all([
        getQuote(target.code),
        getKline(target.code, 250),
        // 指标/基本面失败不该拖垮行情展示（各自降级为不显示对应面板）
        getIndicators(target.code).catch(() => null),
        getFundamentals(target.code).catch(() => null),
      ]);
      setStock({ kind: "success", target, quote, klines, indicators, fundamentals });
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

  function handleSelect(candidate: SearchCandidate) {
    void openStock({ code: candidate.code, name: candidate.name });
  }

  /** 从筛选器点中候选：切回单票分析并载入该股。 */
  function handlePickFromScreener(target: StockTarget) {
    setMode("single");
    void openStock(target);
  }

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900">
      {/*
        左侧导航（窄屏折叠为顶部横向栏）：品牌 + 三个栏目 + 服务状态。
        只有一份导航 DOM，避免窄屏/宽屏各渲染一套导致重复的可访问名。
      */}
      <aside className="fixed inset-x-0 top-0 z-40 flex h-14 items-center gap-2 border-b border-slate-200 bg-white px-4 lg:inset-y-0 lg:left-0 lg:right-auto lg:h-auto lg:w-60 lg:flex-col lg:items-stretch lg:gap-0 lg:border-b-0 lg:border-r lg:px-0">
        <div className="flex shrink-0 items-center gap-2.5 lg:h-16 lg:border-b lg:border-slate-100 lg:px-5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-slate-900 text-[11px] font-bold tracking-tight text-white lg:h-9 lg:w-9">
            A股
          </span>
          <div className="hidden min-w-0 sm:block">
            <h1 className="truncate text-sm font-bold leading-tight tracking-tight text-slate-900 lg:text-[15px]">
              A股智能分析
            </h1>
            <p className="hidden text-[11px] text-slate-400 lg:block">行情 · 指标 · 规则 · 回测</p>
          </div>
        </div>

        <nav
          aria-label="主导航"
          className="ml-auto flex min-w-0 items-center gap-1 overflow-x-auto lg:ml-0 lg:mt-4 lg:w-full lg:flex-col lg:items-stretch lg:gap-0.5 lg:overflow-visible lg:px-3"
        >
          {MODE_TABS.map((tab) => {
            const active = mode === tab.value;
            return (
              <button
                key={tab.value}
                type="button"
                aria-label={tab.label}
                aria-pressed={active}
                onClick={() => setMode(tab.value)}
                className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition-colors lg:justify-start lg:rounded-lg lg:px-3 lg:py-2 lg:text-sm ${
                  active
                    ? "bg-slate-900 text-white shadow-sm"
                    : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
                }`}
              >
                <TabIcon mode={tab.value} />
                <span>{tab.label}</span>
                <span
                  className={`hidden text-[10px] font-normal tracking-wide lg:ml-auto lg:inline ${
                    active ? "text-slate-400" : "text-slate-400"
                  }`}
                >
                  {tab.hint}
                </span>
              </button>
            );
          })}
        </nav>

        <div className="mt-auto hidden border-t border-slate-100 p-4 lg:block">
          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            数据说明
          </p>
          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500">
            <p>行情：东方财富 / 腾讯财经（免费接口）</p>
            <p>分析：DeepSeek（服务端调用）</p>
            <p className="text-slate-400">仅行情与研究，不接任何交易委托。</p>
          </div>
        </div>
      </aside>

      {/* 内容区：窄屏让出顶部导航高度，宽屏让出左侧栏宽度 */}
      <div className="pt-14 lg:pl-60 lg:pt-0">
        <header className="sticky top-14 z-30 border-b border-slate-200 bg-white/85 backdrop-blur lg:top-0">
          <div className="mx-auto flex h-12 w-full max-w-[1440px] items-center justify-between gap-3 px-4 lg:h-14 lg:px-8">
            <div className="flex min-w-0 items-center gap-2 text-xs lg:text-sm">
              <span className="hidden text-slate-400 sm:inline">工作空间</span>
              <span className="hidden text-slate-300 sm:inline">/</span>
              <span className="truncate font-medium text-slate-800">{current.label}</span>
            </div>

            <div className="flex shrink-0 items-center gap-1.5 text-[11px]">
              {backendError ? (
                <span
                  role="alert"
                  className="inline-flex items-center gap-1.5 rounded-full border border-red-200 bg-red-50 px-2.5 py-1 text-red-600"
                >
                  <i className="h-1.5 w-1.5 rounded-full bg-red-500" aria-hidden="true" />
                  无法连接后端：{backendError}
                </span>
              ) : health ? (
                <span className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-slate-600">
                  <i className="h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                  <span className="tabular">
                    {health.service} · {health.status}
                  </span>
                </span>
              ) : (
                <span className="text-slate-400">检测后端状态…</span>
              )}
              {health?.analysisReady === false && (
                <span className="hidden rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-amber-700 sm:inline">
                  分析未就绪（未配置 API key）
                </span>
              )}
            </div>
          </div>
        </header>

        <main className="mx-auto w-full max-w-[1440px] px-4 py-6 lg:px-8 lg:py-8">
          {/* 页面标题区：栏目 eyebrow + 标题 + 当前栏目的一句话说明 */}
          <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-400">
                {current.eyebrow}
              </p>
              <h2 className="mt-1.5 text-2xl font-semibold tracking-tight text-slate-900">
                {current.title}
              </h2>
              <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-slate-500">
                {current.description}
              </p>
            </div>
            <div className="hidden items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500 md:flex">
              <span className="font-medium text-slate-700">口径</span>
              <span>免费公开接口 · 可能延迟</span>
            </div>
          </div>

          <div className="space-y-5">
            {mode === "screener" ? (
              <ScreenerPanel onPick={handlePickFromScreener} />
            ) : mode === "backtest" ? (
              <BacktestPanel />
            ) : (
              <>
                <Panel title="股票检索" meta="代码 / 中文名 / 拼音首字母" bodyClassName="p-4">
                  <div className="max-w-2xl">
                    <SearchBox onSelect={handleSelect} disabled={stock.kind === "loading"} />
                  </div>
                </Panel>

                {/* 首屏空状态：给第一次打开的人一条最短路径，而不是一片灰 */}
                {stock.kind === "idle" && (
                  <Panel title="使用路径" meta="三步拿到一份可复核的分析" bodyClassName="p-0">
                    <ol className="grid divide-y divide-slate-100 sm:grid-cols-3 sm:divide-x sm:divide-y-0">
                      {[
                        {
                          step: "01",
                          title: "选一只股票",
                          detail: "输入代码、中文名或拼音首字母，选中即加载行情快照与日K。",
                        },
                        {
                          step: "02",
                          title: "看行情与指标",
                          detail: "左栏是价格、成交与技术指标；基本面数据不消耗模型调用。",
                        },
                        {
                          step: "03",
                          title: "生成 AI 分析",
                          detail: "右侧点「开始 AI 分析」，得到评级、置信度与可复核的证据链。",
                        },
                      ].map((item) => (
                        <li key={item.step} className="p-4">
                          <p className="text-[11px] font-semibold tracking-[0.16em] text-slate-400">
                            {item.step}
                          </p>
                          <p className="mt-1 text-sm font-medium text-slate-800">{item.title}</p>
                          <p className="mt-1 text-xs leading-relaxed text-slate-500">{item.detail}</p>
                        </li>
                      ))}
                    </ol>
                  </Panel>
                )}

                {stock.kind === "loading" && (
                  <p className="text-sm text-slate-500" role="status">
                    正在获取 {stock.target.name} 的行情数据…
                  </p>
                )}

                {stock.kind === "error" && (
                  <div
                    role="alert"
                    className={`rounded-xl border p-4 text-sm ${
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
                  单列全宽：每一块信息占满一整行，自上而下阅读——
                  行情快照 → 日 K → 技术指标 → 基本面与估值 → AI 分析。
                  不做左右分栏：K 线一行显示全，图表和报告都不再被栏宽挤压。
                */}
                {stock.kind === "success" && (
                  <div className="space-y-5">
                    <QuoteCard quote={stock.quote} dataDate={stock.klines.at(-1)?.date} />
                    <KlineChart klines={stock.klines} symbol={stock.target.code} />
                    {stock.indicators && <IndicatorPanel indicators={stock.indicators} />}
                    {/* 基本面数据先于 AI 分析呈现：不消耗 LLM，选中即可看 */}
                    {stock.fundamentals && (
                      <FundamentalsPanel fundamentals={stock.fundamentals} />
                    )}
                    {/* key 确保换股票时分析状态重置 */}
                    <AnalysisPanel
                      key={stock.target.code}
                      code={stock.target.code}
                      name={stock.target.name}
                    />
                  </div>
                )}
              </>
            )}
          </div>
        </main>

        <footer className="mx-auto w-full max-w-[1440px] px-4 pb-8 lg:px-8">
          <p className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs leading-relaxed text-slate-500">
            ⚠️ 本页所有分析由 AI 生成，仅供学习与研究参考，<strong>不构成任何投资建议</strong>。
            数据来自公开免费接口，可能存在延迟或错误，请以交易所披露为准。
          </p>
          <p className="mt-2 px-1 text-[11px] text-slate-400">
            本地运行 · 研究记录不离开本机 · 请独立判断并自担风险
          </p>
        </footer>
      </div>
    </div>
  );
}

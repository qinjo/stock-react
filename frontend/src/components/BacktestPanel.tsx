import { useEffect, useState } from "react";
import { getBacktest } from "../api";
import { ApiError, type ApiErrorCode, type BacktestResponse } from "../types";
import BacktestResult from "./backtest/BacktestResult";

/**
 * 策略回测面板（第三个 tab）。
 *
 * 全市场回测首次约 40–60 秒（后端分片执行，不阻塞其它请求），因此这里做三件事：
 * 1. loading 期间显示已等待秒数，避免用户以为页面卡死；
 * 2. 结果缓存由后端负责（键=数据截止日+全部参数），同参数重复点几乎立即返回；
 * 3. 参数改动后明确提示"结果仍是上一次的"，不让人误以为改参数会自动重算。
 */

type BacktestState =
  | { kind: "idle" }
  | { kind: "loading"; startedAt: number }
  | { kind: "success"; data: BacktestResponse }
  | { kind: "error"; code: ApiErrorCode; message: string };

const HOT_TOP_OPTIONS = [100, 300, 500] as const;
const WINDOW_OPTIONS = [10, 20, 30, 60] as const;
const SAMPLE_OPTIONS = [
  { value: 0, label: "全市场（首次约 40–60 秒）" },
  { value: 800, label: "快速试跑：800 只" },
  { value: 2000, label: "中等：2000 只" },
] as const;

export default function BacktestPanel() {
  const [from, setFrom] = useState("2021-01-01");
  const [to, setTo] = useState("");
  const [hotTop, setHotTop] = useState<number>(100);
  const [windowDays, setWindowDays] = useState<number>(20);
  const [sample, setSample] = useState<number>(0);
  const [state, setState] = useState<BacktestState>({ kind: "idle" });
  const [elapsed, setElapsed] = useState(0);

  // loading 期间每秒更新"已等待 N 秒"，让长任务可见
  useEffect(() => {
    if (state.kind !== "loading") return;
    const id = setInterval(() => {
      setElapsed(Math.floor((Date.now() - state.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [state]);

  async function run(force = false) {
    setElapsed(0);
    setState({ kind: "loading", startedAt: Date.now() });
    try {
      const data = await getBacktest({
        from,
        ...(to ? { to } : {}),
        hotTop,
        window: windowDays,
        sample,
        ...(force ? { refresh: true } : {}),
      });
      setState({ kind: "success", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code, message: err.message });
      } else {
        setState({
          kind: "error",
          code: "SOURCE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "回测失败",
        });
      }
    }
  }

  const loading = state.kind === "loading";
  const stale =
    state.kind === "success" &&
    (state.data.params.hotTopN !== hotTop ||
      state.data.params.hotWindow !== windowDays ||
      state.data.from !== from ||
      (to !== "" && state.data.to !== to) ||
      (state.data.sample ?? 0) !== sample);

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <label className="text-xs font-medium text-slate-500">
            <span className="block">回测起点</span>
            <input
              type="date"
              aria-label="回测起点"
              value={from}
              disabled={loading}
              onChange={(event) => setFrom(event.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm text-slate-800"
            />
          </label>

          <label className="text-xs font-medium text-slate-500">
            <span className="block">终点（留空 = 库内最新交易日）</span>
            <input
              type="date"
              aria-label="回测终点"
              value={to}
              disabled={loading}
              onChange={(event) => setTo(event.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm text-slate-800"
            />
          </label>

          <label className="text-xs font-medium text-slate-500">
            <span className="block">热门 Top-N（代理宇宙）</span>
            <select
              aria-label="热门 Top-N"
              value={hotTop}
              disabled={loading}
              onChange={(event) => setHotTop(Number(event.target.value))}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm text-slate-800"
            >
              {HOT_TOP_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  Top {value}
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-500">
            <span className="block">「近一个月」窗口</span>
            <select
              aria-label="近一个月窗口"
              value={windowDays}
              disabled={loading}
              onChange={(event) => setWindowDays(Number(event.target.value))}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm text-slate-800"
            >
              {WINDOW_OPTIONS.map((value) => (
                <option key={value} value={value}>
                  {value} 个交易日
                </option>
              ))}
            </select>
          </label>

          <label className="text-xs font-medium text-slate-500">
            <span className="block">样本</span>
            <select
              aria-label="样本"
              value={sample}
              disabled={loading}
              onChange={(event) => setSample(Number(event.target.value))}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm text-slate-800"
            >
              {SAMPLE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={loading || from === ""}
              onClick={() => void run()}
              className="rounded border border-slate-800 bg-slate-800 px-4 py-1.5 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
            >
              {loading ? `回测中…（${elapsed}s）` : "开始回测"}
            </button>
            {state.kind === "success" && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void run(true)}
                className="rounded border border-slate-300 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                忽略缓存重算
              </button>
            )}
          </div>
        </div>

        <p className="mt-3 text-xs leading-relaxed text-slate-500">
          规则：近 {windowDays} 个交易日内成交额排名前 {hotTop} 且出现过涨停的股票 → KDJ(9,3,3) 金叉次日开盘买入、
          死叉次日开盘清仓；逐票独立、满仓、含佣金/印花税/过户费，涨跌停顺延，滑点未建模。
        </p>
      </div>

      {stale && (
        <p className="text-xs text-amber-700" role="status">
          参数已修改，下面仍是上一次的结果——点「开始回测」重新计算。
        </p>
      )}

      {state.kind === "loading" && (
        <p className="text-sm text-slate-500" role="status">
          正在回测（已等待 {elapsed} 秒）。全市场约 40–60 秒；同一天同参数再次查询会直接命中缓存。
        </p>
      )}

      {state.kind === "error" && (
        <div
          role="alert"
          className={`rounded-lg border p-4 text-sm ${
            state.code === "SOURCE_UNAVAILABLE"
              ? "border-amber-200 bg-amber-50 text-amber-800"
              : "border-red-200 bg-red-50 text-red-700"
          }`}
        >
          <p className="font-medium">
            {state.code === "DATA_NOT_READY"
              ? "本地日K库未就绪"
              : state.code === "SOURCE_UNAVAILABLE"
                ? "数据源暂时不可用"
                : "回测失败"}
          </p>
          <p className="mt-1">{state.message}</p>
          {state.code === "DATA_NOT_READY" && (
            <p className="mt-1 text-xs">
              先在 <code className="rounded bg-white/60 px-1">backend</code> 下运行{" "}
              <code className="rounded bg-white/60 px-1">npm run bootstrap:kline</code> 建本地日K库。
            </p>
          )}
        </div>
      )}

      {state.kind === "success" && <BacktestResult data={state.data} />}
    </section>
  );
}

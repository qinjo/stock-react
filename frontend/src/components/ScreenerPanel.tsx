import { useState } from "react";
import { getScreen } from "../api";
import {
  ApiError,
  ApiErrorCode,
  BoardName,
  ScreenMode,
  ScreenResponse,
  Strictness,
} from "../types";
import { ResultView } from "./screener/ResultView";
import { DEFAULT_BOARDS, MODE_LABELS, NEXT_LOOSER, STRICTNESS_LABELS, BOARD_LABELS } from "./screener/labels";

type ScreenState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: ScreenResponse }
  | { kind: "error"; code: ApiErrorCode; message: string };

type Props = {
  /** 点候选股：切回单票分析并载入该股 */
  onPick: (target: { code: string; name: string }) => void;
};

export default function ScreenerPanel({ onPick }: Props) {
  const [mode, setMode] = useState<ScreenMode>("trend");
  const [strictness, setStrictness] = useState<Strictness>("standard");
  const [boards, setBoards] = useState<BoardName[]>(DEFAULT_BOARDS);
  /** 逃生开关：大盘空仓档时默认不出票，打开它才照常出票 */
  const [ignoreMarketGate, setIgnoreMarketGate] = useState(false);
  const [state, setState] = useState<ScreenState>({ kind: "idle" });

  function toggleBoard(board: BoardName) {
    setBoards((current) =>
      current.includes(board) ? current.filter((b) => b !== board) : [...current, board],
    );
  }

  async function run(override?: { ignoreMarketGate?: boolean; strictness?: Strictness }) {
    if (boards.length === 0) {
      setState({ kind: "error", code: "INVALID_INPUT", message: "至少要选择一个板块" });
      return;
    }
    const gateOverride = override?.ignoreMarketGate ?? ignoreMarketGate;
    // 放宽严格度时要用**新的档位**立刻重跑：setState 是异步的，这里不能读 state
    const tierOverride = override?.strictness ?? strictness;
    setIgnoreMarketGate(gateOverride);
    setStrictness(tierOverride);
    setState({ kind: "loading" });
    try {
      const data = await getScreen({
        mode,
        strictness: tierOverride,
        boards,
        ...(gateOverride ? { ignoreMarketGate: true } : {}),
      });
      setState({ kind: "success", data });
    } catch (err) {
      if (err instanceof ApiError) {
        setState({ kind: "error", code: err.code, message: err.message });
      } else {
        setState({
          kind: "error",
          code: "SOURCE_UNAVAILABLE",
          message: err instanceof Error ? err.message : "筛选失败",
        });
      }
    }
  }

  const loading = state.kind === "loading";

  return (
    <section className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap items-end gap-x-6 gap-y-3">
          <fieldset>
            <legend className="text-xs font-medium text-slate-500">模式</legend>
            <div className="mt-1 flex gap-1">
              {MODE_LABELS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  title={item.hint}
                  aria-pressed={mode === item.value}
                  onClick={() => {
                    // 旧结果必须立即作废：档位标签是按模式渲染的，
                    // 留着旧结果会让"档2 低位123"被标成"档2 涨停B形态"
                    setMode(item.value);
                    setState({ kind: "idle" });
                  }}
                  className={`rounded border px-3 py-1 text-sm ${
                    mode === item.value
                      ? "border-slate-800 bg-slate-800 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-slate-500">严格度</legend>
            <div className="mt-1 flex gap-1">
              {STRICTNESS_LABELS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={strictness === item.value}
                  onClick={() => {
                    // 同理：严格度变了，旧漏斗与旧候选都不再对应当前参数
                    setStrictness(item.value);
                    setState({ kind: "idle" });
                  }}
                  className={`rounded border px-3 py-1 text-sm ${
                    strictness === item.value
                      ? "border-slate-800 bg-slate-800 text-white"
                      : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset>
            <legend className="text-xs font-medium text-slate-500">股票池</legend>
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {BOARD_LABELS.map((item) => (
                <label key={item.value} className="flex items-center gap-1 text-sm text-slate-700">
                  <input
                    type="checkbox"
                    checked={boards.includes(item.value)}
                    onChange={() => toggleBoard(item.value)}
                  />
                  {item.label}
                </label>
              ))}
            </div>
          </fieldset>

          <button
            type="button"
            onClick={() => void run()}
            disabled={loading}
            className="rounded bg-slate-900 px-4 py-1.5 text-sm font-medium text-white disabled:opacity-50"
          >
            {loading ? "筛选中…" : "开始筛选"}
          </button>
        </div>

        <p className="mt-3 text-xs text-slate-400">
          规则来自《短线操盘实战技法》，每条结果都标注了依据是书内还是系统补充的补丁。
        </p>
      </div>

      {loading && (
        <p className="text-sm text-slate-500" role="status">
          正在遍历全市场并逐条判定规则，通常需要数秒…
        </p>
      )}

      {state.kind === "error" && <ErrorBox code={state.code} message={state.message} />}

      {state.kind === "success" && (
        <ResultView
          data={state.data}
          onPick={onPick}
          onIgnoreMarketGate={() => void run({ ignoreMarketGate: true })}
          onRelax={() => {
            const next = NEXT_LOOSER[state.data.params.strictness];
            if (next) void run({ strictness: next });
          }}
        />
      )}
    </section>
  );
}

function ErrorBox({ code, message }: { code: ApiErrorCode; message: string }) {
  if (code === "DATA_NOT_READY") {
    return (
      <div role="alert" className="rounded-lg border border-sky-200 bg-sky-50 p-4 text-sm text-sky-900">
        <p className="font-medium">本地日K库尚未初始化</p>
        <p className="mt-1">{message}</p>
        <p className="mt-2 text-xs text-sky-700">
          这是本地数据准备步骤，不是数据源故障。在 backend 目录执行
          <code className="mx-1 rounded bg-white px-1 py-0.5">npm run bootstrap:kline</code>
          后重试。
        </p>
      </div>
    );
  }

  const isSource = code === "SOURCE_UNAVAILABLE";
  return (
    <div
      role="alert"
      className={`rounded-lg border p-4 text-sm ${
        isSource ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700"
      }`}
    >
      <p className="font-medium">{isSource ? "数据源暂时不可用" : "筛选请求失败"}</p>
      <p className="mt-1">{message}</p>
      {isSource && (
        <p className="mt-1 text-xs">可能是数据源限流（东财有 IP 级反爬），请稍后重试。</p>
      )}
    </div>
  );
}

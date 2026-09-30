import { useState } from "react";
import { getScreen } from "../api";
import {
  ApiError,
  type ApiErrorCode,
  type BoardName,
  type ScreenCandidate,
  type ScreenMode,
  type ScreenParams,
  type ScreenResponse,
  type Strictness,
} from "../types";

/**
 * 短线筛选器面板：全市场筛出候选，点一只切回单票分析。
 *
 * 三态与既有一致（loading / success / error），但错误分流多了一档：
 * `DATA_NOT_READY`（本地库还没初始化，用户可自行解决）与
 * `SOURCE_UNAVAILABLE`（外部数据源挂了，只能等）必须区分展示——
 * 混成一句"数据源不可用"会让用户去排查一个根本不存在的问题。
 */

const MODE_LABELS: Array<{ value: ScreenMode; label: string; hint: string }> = [
  { value: "trend", label: "均线跟随", hint: "站上 MA100 的均线结构" },
  { value: "event", label: "事件驱动", hint: "缺口与涨停突破" },
];

const STRICTNESS_LABELS: Array<{ value: Strictness; label: string }> = [
  { value: "loose", label: "宽松" },
  { value: "standard", label: "标准" },
  { value: "strict", label: "严格" },
];

const BOARD_LABELS: Array<{ value: BoardName; label: string }> = [
  { value: "main", label: "主板" },
  { value: "growth", label: "创业板" },
  { value: "star", label: "科创板" },
  { value: "bj", label: "北交所" },
];

const DEFAULT_BOARDS: BoardName[] = ["main", "growth", "star"];

type ScreenState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "success"; data: ScreenResponse }
  | { kind: "error"; code: ApiErrorCode; message: string };

type Props = {
  /** 点候选股：切回单票分析并载入该股 */
  onPick: (target: { code: string; name: string }) => void;
};

const pct = (v: number | null, digits = 1): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;

const money = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : `${(v / 1e8).toFixed(2)}亿`;

const price = (v: number | null): string =>
  v === null || !Number.isFinite(v) ? "—" : v.toFixed(2);

function signClass(v: number | null): string {
  if (v === null || v === undefined || v === 0) return "text-slate-700";
  return v > 0 ? "text-red-600" : "text-emerald-600";
}

export default function ScreenerPanel({ onPick }: Props) {
  const [mode, setMode] = useState<ScreenMode>("trend");
  const [strictness, setStrictness] = useState<Strictness>("standard");
  const [boards, setBoards] = useState<BoardName[]>(DEFAULT_BOARDS);
  const [state, setState] = useState<ScreenState>({ kind: "idle" });

  function toggleBoard(board: BoardName) {
    setBoards((current) =>
      current.includes(board) ? current.filter((b) => b !== board) : [...current, board],
    );
  }

  async function run() {
    if (boards.length === 0) {
      setState({ kind: "error", code: "INVALID_INPUT", message: "至少要选择一个板块" });
      return;
    }
    setState({ kind: "loading" });
    try {
      const data = await getScreen({ mode, strictness, boards });
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
                  onClick={() => setMode(item.value)}
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
                  onClick={() => setStrictness(item.value)}
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
            onClick={run}
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

      {state.kind === "success" && <ResultView data={state.data} onPick={onPick} />}
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

function ResultView({
  data,
  onPick,
}: {
  data: ScreenResponse;
  onPick: (target: { code: string; name: string }) => void;
}) {
  const { funnel } = data;

  return (
    <div className="space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
        <header className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-sm font-medium text-slate-700">
            筛出 {data.candidateTotal} 只
            {data.candidateTotal > data.candidates.length &&
              `（展示前 ${data.candidates.length} 只）`}
          </h2>
          <p className="text-xs text-slate-400">数据截至 {data.dataDate}</p>
        </header>

        <p className="mt-2 text-xs text-slate-500">
          漏斗：全市场 {funnel.universe} → 排除池 {funnel.afterExclusions} → 硬门槛{" "}
          {funnel.afterHardFilters} → 基础池 {funnel.shortlisted}
        </p>

        {data.degraded.llmReview && (
          <p className="mt-2 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-500">
            未经大模型复核：{data.degraded.reason ?? "当前结果全部来自确定性规则"}
          </p>
        )}

        {data.inactiveRules.length > 0 && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
            ⚠ 以下规则当前未生效（多为缺数据）：{data.inactiveRules.join("、")}
          </p>
        )}
      </div>

      {data.candidates.length === 0 ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-medium text-slate-700">今日无符合条件的个股</p>
          <p className="mt-1 text-xs text-slate-500">
            这不是故障：源书主张「空仓时间应长于持仓时间」，筛不出票本身就是这套方法的正常输出。
          </p>
        </div>
      ) : (
        <ul className="space-y-2">
          {data.candidates.map((candidate) => (
            <CandidateCard key={candidate.code} candidate={candidate} onPick={onPick} />
          ))}
        </ul>
      )}

      <p className="rounded border border-slate-200 bg-white px-3 py-2 text-xs text-slate-500">
        ⚠️ 本页结果为规则 / AI 生成，<strong>仅供学习与研究参考，不构成任何投资建议</strong>。
        源书作者自述该系统胜率约「牛市 50%、熊市 30%」，并主张空仓时间应长于持仓时间——
        请据此校准预期。结果未经基本面与合规审查。
      </p>
    </div>
  );
}

function CandidateCard({
  candidate,
  onPick,
}: {
  candidate: ScreenCandidate;
  onPick: (target: { code: string; name: string }) => void;
}) {
  const { metrics } = candidate;
  const since = metrics.barsSinceMa100Cross;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <button
            type="button"
            onClick={() => onPick({ code: candidate.code, name: candidate.name ?? candidate.code })}
            className="text-sm font-medium text-slate-900 underline decoration-slate-300 hover:decoration-slate-900"
          >
            {candidate.name ?? candidate.code}
          </button>
          <span className="text-xs text-slate-400">{candidate.code}</span>
        </div>
        <div className="flex items-baseline gap-3 text-sm">
          <span className="font-medium text-slate-900">{price(candidate.price)}</span>
          <span className={signClass(candidate.changePercent)}>
            {candidate.changePercent === null ? "—" : `${candidate.changePercent.toFixed(2)}%`}
          </span>
        </div>
      </div>

      <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        <div className="flex gap-1">
          <dt className="text-slate-500">MA100 偏离</dt>
          <dd className="font-medium text-slate-800">{pct(metrics.ma100Deviation)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-slate-500">上穿 MA100</dt>
          <dd className="font-medium text-slate-800">
            {since === null ? "全程在上" : `距今 ${since} 根`}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-slate-500">成交额</dt>
          <dd className="font-medium text-slate-800">{money(metrics.turnoverAmount)}</dd>
        </div>
        {metrics.floatMarketCap !== null && (
          <div className="flex gap-1">
            <dt className="text-slate-500">流通市值</dt>
            <dd className="font-medium text-slate-800">{money(metrics.floatMarketCap)}</dd>
          </div>
        )}
      </dl>

      {candidate.deductions.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs text-amber-700">
          {candidate.deductions.map((item) => (
            <li key={item}>未判定：{item}</li>
          ))}
        </ul>
      )}

      <p className="mt-2 text-[11px] text-slate-400">
        规则生成，非投资建议。命中 {candidate.ruleHits.length} 条规则判定。
      </p>
    </li>
  );
}

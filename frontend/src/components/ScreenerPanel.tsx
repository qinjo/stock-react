import { useState } from "react";
import { getAnalysis, getScreen } from "../api";
import {
  ApiError,
  type AnalyzeResponse,
  type ApiErrorCode,
  type FunnelStage,
  type MarketGate,
  type RuleSource,
  type ScreenRuleHit,
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

const formatDateKey = (key: number | null): string => {
  if (key === null) return "—";
  const text = String(key);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
};

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

/** 放宽的下一档；已是最宽档则为 null（不能再放宽）。 */
const NEXT_LOOSER: Record<Strictness, Strictness | null> = {
  strict: "standard",
  standard: "loose",
  loose: null,
};

function ResultView({
  data,
  onPick,
  onIgnoreMarketGate,
  onRelax,
}: {
  data: ScreenResponse;
  onPick: (target: { code: string; name: string }) => void;
  onIgnoreMarketGate: () => void;
  onRelax: () => void;
}) {
  const { funnel } = data;
  const nextTier = NEXT_LOOSER[data.params.strictness];

  return (
    <div className="space-y-4">
      {data.marketGate && <MarketGateBanner gate={data.marketGate} ignored={data.params.ignoreMarketGate} />}

      {data.suppressed && (
        <div role="alert" className="rounded-lg border border-slate-300 bg-slate-100 p-4 text-sm text-slate-800">
          <p className="font-medium">空仓信号：今天默认不出票</p>
          <p className="mt-1 text-xs">
            源书主张「空仓时间应长于持仓时间」，跌破 MA100 时短线操作应当停手。
            {data.candidateTotal > 0 ? (
              <>
                本次仍有 <span className="font-medium">{data.candidateTotal}</span> 只符合个股条件，
                但按书的择时前提不建议现在动手。
              </>
            ) : (
              // 本来就没有候选时，不能说成"是大盘门挡掉的"——那是两回事
              <>本次即便不看大盘门也没有符合条件的个股。</>
            )}
          </p>
          <button
            type="button"
            onClick={onIgnoreMarketGate}
            className="mt-2 rounded border border-slate-400 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
          >
            仍要查看（忽略大盘门）
          </button>
          <p className="mt-1 text-[11px] text-slate-500">
            点击后你将看到候选，但那是在**违反书的择时前提**下给出的。
          </p>
        </div>
      )}

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
          {funnel.afterHardFilters} → 基础池 {funnel.shortlisted} → 有信号{" "}
          <span className="font-medium text-slate-700">{funnel.signalEligible}</span>
          {funnel.reviewed !== undefined && (
            <>
              {" "}
              → 复核 <span className="font-medium text-slate-700">{funnel.reviewed}</span>
            </>
          )}
          {data.fromCache && <span className="ml-2 text-slate-400">· 来自当日缓存</span>}
        </p>

        {data.increment.ran && !data.increment.failed && (
          <p className="mt-2 rounded border border-sky-200 bg-sky-50 px-2 py-1 text-xs text-sky-800">
            已自动补齐当日行情：快照 {formatDateKey(data.increment.snapshotDate)}，
            写入 {data.increment.barsWritten} 只
            {data.increment.exDividends > 0 && `（其中 ${data.increment.exDividends} 只除权已修正复权因子）`}
            {data.increment.namesUpdated > 0 && `，回填名称 ${data.increment.namesUpdated} 只`}
          </p>
        )}

        {data.increment.failed && (
          <p className="mt-2 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-xs text-amber-800">
            ⚠ 当日行情补齐失败，以下结果基于库内已有数据（可能不是最新交易日）：
            {data.increment.error ?? "未知原因"}
          </p>
        )}

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

      {/* 空仓抑制已经单独解释过了，这里不要再叠一句"今日无符合条件" */}
      {data.candidates.length === 0 && !data.suppressed ? (
        <div className="rounded-lg border border-slate-200 bg-white p-6 text-center">
          <p className="text-sm font-medium text-slate-700">今日无符合条件的个股</p>
          <p className="mt-1 text-xs text-slate-500">
            这不是故障：源书主张「空仓时间应长于持仓时间」，筛不出票本身就是这套方法的正常输出。
          </p>
          {/*
            但"筛不出来"与"门槛卡太死"要能区分。给一条自助的出口，
            而不是让用户回去手动逐个改参数。
          */}
          {nextTier && (
            <button
              type="button"
              onClick={onRelax}
              className="mt-3 rounded border border-slate-300 bg-white px-3 py-1 text-xs text-slate-700 hover:bg-slate-50"
            >
              放宽到「{STRICTNESS_LABELS.find((item) => item.value === nextTier)?.label}」档重跑
            </button>
          )}
          {!nextTier && (
            <p className="mt-2 text-xs text-slate-400">已是最宽档；再往下就需要调整股票池了。</p>
          )}
        </div>
      ) : (
        <ul className="space-y-2">
          {data.candidates.map((candidate) => (
            <CandidateCard
              key={candidate.code}
              candidate={candidate}
              mode={data.params.mode}
              unreviewed={data.degraded.llmReview}
              onPick={onPick}
            />
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

const GATE_STYLE: Record<string, { box: string; label: string; position: string }> = {
  offense: { box: "border-emerald-200 bg-emerald-50 text-emerald-900", label: "进攻", position: "满仓" },
  defense: { box: "border-amber-200 bg-amber-50 text-amber-900", label: "防守", position: "半仓" },
  empty: { box: "border-red-200 bg-red-50 text-red-800", label: "空仓", position: "空仓" },
};

function MarketGateBanner({ gate, ignored }: { gate: MarketGate; ignored: boolean }) {
  const style = GATE_STYLE[gate.state] ?? GATE_STYLE.defense!;
  const positionPct = `${Math.round(gate.positionAdvice * 100)}%`;

  return (
    <div className={`rounded-lg border p-3 text-sm ${style.box}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">大盘门：{style.label}档</p>
        <p className="text-xs">
          今日建议总仓位
          <span className="ml-1 font-medium">{positionPct}</span>
          <span className="ml-1 opacity-70">（{style.position}）</span>
        </p>
      </div>
      <p className="mt-1 text-xs opacity-90">{gate.reason}</p>
      {ignored && gate.state === "empty" && (
        <p className="mt-1 text-xs font-medium">
          ⚠ 你已忽略大盘门：以下候选是在违反书的择时前提（跌破 MA100 应停手）的情况下给出的。
        </p>
      )}
    </div>
  );
}

/**
 * 按需触发的短线视角深度分析。
 *
 * **不自动对全部候选调用**：一次筛选可能出十只票，自动跑就是十次大模型调用，
 * 既慢又贵。这里只在用户点按钮时才请求一只。
 */
function DeepAnalysis({ code, name }: { code: string; name: string }) {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "ok"; data: AnalyzeResponse }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  async function run() {
    setState({ kind: "loading" });
    try {
      setState({ kind: "ok", data: await getAnalysis(code, "short") });
    } catch (err) {
      setState({ kind: "error", message: err instanceof Error ? err.message : "分析失败" });
    }
  }

  const report = state.kind === "ok" ? state.data.analysis : null;

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => void run()}
        disabled={state.kind === "loading"}
        className="rounded border border-slate-300 bg-white px-2 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
      >
        {state.kind === "loading" ? "分析中…" : "深度分析（短线视角）"}
      </button>

      {state.kind === "error" && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {state.message}
        </p>
      )}

      {report && (
        <div className="mt-2 space-y-1.5 rounded border border-slate-200 bg-slate-50 p-2 text-xs">
          <p className="text-slate-500">
            {name} · 短线视角 · 置信度 {report.confidence}
          </p>
          <p className="text-slate-700">{report.reasoning}</p>
          <p className="text-slate-600">
            <span className="text-slate-400">①MA100 位置：</span>
            {report.sections.snapshot}
          </p>
          <p className="text-slate-600">
            <span className="text-slate-400">②结构形态：</span>
            {report.sections.fundamentals}
          </p>
          <p className="text-slate-600">
            <span className="text-slate-400">③离场条件：</span>
            {report.sections.technicals}
          </p>
          <ul className="space-y-0.5 text-slate-600">
            {report.sections.risks.map((item) => (
              <li key={item}>
                <span className="text-slate-400">④</span>
                {item}
              </li>
            ))}
          </ul>
          {report.dataLimits.length > 0 && (
            <p className="text-[11px] text-amber-700">数据边界：{report.dataLimits.join("；")}</p>
          )}
        </div>
      )}
    </div>
  );
}

const STAGE_ORDER: FunnelStage[] = ["exclusions", "hardFilters", "shortlist"];
const STAGE_LABELS: Record<FunnelStage, string> = {
  exclusions: "排除层",
  hardFilters: "硬门槛",
  shortlist: "基础池",
};

/** 规则来源徽章：让用户一眼分清"书挑的"与"我们加的"。 */
function SourceBadge({ hit }: { hit: ScreenRuleHit }) {
  const style =
    hit.source === "book"
      ? "bg-sky-50 text-sky-700"
      : hit.source === "inferred"
        ? "bg-amber-50 text-amber-700"
        : "bg-slate-100 text-slate-500";
  const text =
    hit.source === "book" ? `书 ${hit.bookRef ?? ""}`.trim() : hit.source === "inferred" ? "推断" : "书外";
  return (
    <span className={`shrink-0 rounded px-1 py-0.5 text-[10px] ${style}`} title={SOURCE_TITLE[hit.source]}>
      {text}
    </span>
  );
}

const SOURCE_TITLE: Record<RuleSource, string> = {
  book: "源书明确写出，附书内行号",
  inferred: "源书只给定性描述，阈值由本项目推断",
  offbook: "源书没有、由本项目补充的安全或工程约束",
};

/**
 * 可展开的规则明细：逐条给出「规则名 + 阈值 + 该股实际值 + 来源」。
 *
 * 这是"能验证它为什么被选中"的那一环。默认收起，避免十五条判定把卡片撑长。
 */
function RuleDetails({ hits }: { hits: ScreenRuleHit[] }) {
  if (hits.length === 0) return null;
  const unknownCount = hits.filter((hit) => hit.unknown).length;

  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-slate-500 hover:text-slate-700">
        规则明细（{hits.length} 条判定，全部通过
        {unknownCount > 0 && `，其中 ${unknownCount} 条因缺数据未判定`}）
      </summary>
      <div className="mt-1.5 space-y-1.5">
        {STAGE_ORDER.map((stage) => {
          const stageHits = hits.filter((hit) => hit.stage === stage);
          if (stageHits.length === 0) return null;
          return (
            <div key={stage}>
              <p className="text-[11px] text-slate-400">{STAGE_LABELS[stage]}</p>
              <ul className="mt-0.5 space-y-0.5">
                {stageHits.map((hit) => (
                  <li key={hit.id} className="flex flex-wrap items-baseline gap-1.5">
                    <SourceBadge hit={hit} />
                    <span className="text-slate-700">{hit.label}</span>
                    <span className="text-slate-500">{hit.detail}</span>
                    {hit.unknown && <span className="text-amber-700">（未判定）</span>}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </details>
  );
}

/** 档序 → 中文名，与后端的 TIER_OF / EVENT_TIER_OF 一一对应。 */
const TIER_LABELS: Record<ScreenMode, Record<number, string>> = {
  trend: {
    1: "底背离双突破",
    2: "低位 123",
    3: "三档入场",
    4: "MA20 上穿",
    5: "阻力突破 / 支撑回踩",
  },
  event: {
    1: "涨停 + 低位 123",
    2: "涨停 B 形态",
    3: "突破性涨停",
    4: "向上突破性缺口",
    5: "向上持续性缺口",
  },
};

/** 档位徽章文案：档号在两种模式下含义不同，标签必须跟着模式走。 */
function tierLabel(mode: ScreenMode, tier: number): string {
  return TIER_LABELS[mode][tier] ?? "信号";
}

function CandidateCard({
  candidate,
  mode,
  unreviewed,
  onPick,
}: {
  candidate: ScreenCandidate;
  mode: ScreenMode;
  /** 本次结果未经大模型复核（降级）——每条候选都要自己标出来，而不只靠页面顶部一次提示 */
  unreviewed: boolean;
  onPick: (target: { code: string; name: string }) => void;
}) {
  const { metrics, exit } = candidate;
  const since = metrics.barsSinceMa100Cross;
  const strongest = candidate.signals.signals[0] ?? null;

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          <button
            type="button"
            onClick={() => onPick({ code: candidate.code, name: candidate.name ?? candidate.code })}
            className="text-sm font-medium text-slate-900 underline decoration-slate-300 hover:decoration-slate-900"
          >
            {candidate.name ?? candidate.code}
          </button>
          <span className="text-xs text-slate-400">{candidate.code}</span>
          {candidate.signalTier !== null && (
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">
              档{candidate.signalTier} · {tierLabel(mode, candidate.signalTier)}
            </span>
          )}
        </div>
        <div className="flex items-baseline gap-3 text-sm">
          <span className="font-medium text-slate-900">{price(candidate.price)}</span>
          <span className={signClass(candidate.changePercent)}>
            {candidate.changePercent === null ? "—" : `${candidate.changePercent.toFixed(2)}%`}
          </span>
        </div>
      </div>

      {candidate.reasoning && (
        <p className="mt-2 text-xs text-slate-600">
          <span className="rounded bg-emerald-50 px-1 py-0.5 text-[10px] text-emerald-700">AI 复核</span>
          <span className="ml-1.5">{candidate.reasoning}</span>
        </p>
      )}

      {strongest && (
        <p className="mt-2 text-xs text-slate-600">
          <span className="text-slate-400">信号：</span>
          <span className="font-medium text-slate-800">{strongest.label}</span>
          <span className="ml-1 text-slate-400">（书 {strongest.bookRef}）</span>
          <span className="ml-1 text-slate-500">{strongest.detail}</span>
        </p>
      )}

      {/*
        离场计划：源书的逻辑是"跟随趋势直到结构被破坏"，而不是"到价卖出"，
        所以这里给的是止损位、失效条件与分批止盈，**不给目标价**。
      */}
      <div className="mt-2 rounded border border-slate-200 bg-slate-50 p-2">
        <p className="text-xs text-slate-700">
          <span className="text-slate-400">入场 </span>
          <span className="font-medium">{price(exit.entry)}</span>
          <span className="mx-1.5 text-slate-300">|</span>
          <span className="text-slate-400">止损 </span>
          <span className="font-medium text-emerald-700">{price(exit.stop)}</span>
          <span className="ml-1 text-slate-500">
            （{exit.stopBasisLabel}，空间 {(exit.stopSpace * 100).toFixed(1)}%）
          </span>
        </p>
        <p className="mt-1 text-xs text-slate-600">
          <span className="text-slate-400">失效：</span>
          {exit.invalidation}
        </p>
        <p className="mt-0.5 text-xs text-slate-600">
          <span className="text-slate-400">止盈：</span>
          {exit.scaleOut}
        </p>
      </div>

      {candidate.resistance.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-xs">
          {candidate.resistance.map((item) => (
            <li key={item.kind}>
              <span className="text-slate-400">参考压力位 </span>
              <span className="font-medium text-slate-800">{price(item.price)}</span>
              <span className="ml-1 text-slate-400">{item.detail}</span>
            </li>
          ))}
        </ul>
      )}

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

      <DeepAnalysis code={candidate.code} name={candidate.name ?? candidate.code} />

      <RuleDetails hits={candidate.ruleHits} />

      <p className="mt-2 text-[11px] text-slate-400">
        规则生成，非投资建议。命中 {candidate.ruleHits.length} 条规则判定。
        {/* 与顶部横幅用同一句话，避免同一件事两种说法 */}
        {unreviewed && <span className="ml-1 text-amber-700">· 未经大模型复核</span>}
      </p>
    </li>
  );
}

import type { ScreenCandidate, ScreenMode } from "../../types";
import { pct, money, price, signClass } from "./format";
import { DeepAnalysis } from "./DeepAnalysis";
import { RuleDetails } from "./RuleDetails";

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

export function CandidateCard({
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

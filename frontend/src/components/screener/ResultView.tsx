import type { ScreenResponse } from "../../types";
import { NEXT_LOOSER, STRICTNESS_LABELS } from "./labels";
import { formatDateKey } from "./format";
import { CandidateCard } from "./CandidateCard";
import { MarketGateBanner } from "./MarketGateBanner";

/** 放宽的下一档；已是最宽档则为 null（不能再放宽）。 */
export function ResultView({
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

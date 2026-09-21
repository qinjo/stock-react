import { RATING_LABELS, type Analysis, type TokenUsage } from "../types";

/** 评级配色：遵循 A 股习惯（偏多=红，偏空=绿，中性=灰）。 */
const RATING_STYLE: Record<string, { badge: string; bar: string }> = {
  buy: { badge: "bg-red-600 text-white", bar: "bg-red-500" },
  overweight: { badge: "bg-red-100 text-red-700", bar: "bg-red-400" },
  hold: { badge: "bg-slate-200 text-slate-700", bar: "bg-slate-400" },
  underweight: { badge: "bg-emerald-100 text-emerald-700", bar: "bg-emerald-400" },
  sell: { badge: "bg-emerald-600 text-white", bar: "bg-emerald-500" },
};

type Props = {
  analysis: Analysis;
  model: string;
  analyzedAt: string;
  fromCache: boolean;
  usage?: TokenUsage;
};

/** 千分位格式化 token 数。 */
function fmtTokens(n: number): string {
  return n.toLocaleString("zh-CN");
}

/** 信号卡：评级 + 置信度 + 一句话理由 + 可选目标价/时间窗 + 溯源信息。 */
export default function RatingCard({ analysis, model, analyzedAt, fromCache, usage }: Props) {
  const style = RATING_STYLE[analysis.rating] ?? RATING_STYLE.hold!;

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span
            className={`rounded-md px-3 py-1.5 text-base font-semibold ${style.badge}`}
            data-testid="rating-badge"
          >
            {RATING_LABELS[analysis.rating]}
          </span>
          <div className="text-sm text-slate-500">
            置信度 <span className="font-semibold text-slate-800">{analysis.confidence}</span> / 100
          </div>
        </div>

        <div className="flex flex-wrap gap-4 text-sm text-slate-600">
          {analysis.priceTarget !== null && (
            <span>
              目标价 <span className="font-medium text-slate-900">{analysis.priceTarget}</span>
            </span>
          )}
          {analysis.invalidation && (
            <span data-testid="invalidation">
              失效位 <span className="font-medium text-slate-900">{analysis.invalidation.price}</span>
              {analysis.invalidation.distancePercent !== null && (
                <span className="ml-1 text-xs text-slate-400">
                  （{analysis.invalidation.distancePercent > 0 ? "−" : "+"}
                  {Math.abs(analysis.invalidation.distancePercent).toFixed(2)}%）
                </span>
              )}
            </span>
          )}
          {analysis.timeHorizon && (
            <span>
              时间窗 <span className="font-medium text-slate-900">{analysis.timeHorizon}</span>
            </span>
          )}
        </div>
      </header>

      <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${style.bar}`}
          style={{ width: `${Math.min(100, Math.max(0, analysis.confidence))}%` }}
          role="progressbar"
          aria-valuenow={analysis.confidence}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="置信度"
        />
      </div>

      <p className="mt-3 max-w-4xl text-sm text-slate-800">{analysis.reasoning}</p>

      {analysis.priceTargetBasis && (
        <p className="mt-2 max-w-4xl text-xs text-slate-500" data-testid="price-target-basis">
          目标价依据：{analysis.priceTargetBasis}
        </p>
      )}
      {analysis.invalidation && (
        <p className="mt-1 max-w-4xl text-xs text-slate-500" data-testid="invalidation-basis">
          失效位依据：{analysis.invalidation.basis}
        </p>
      )}

      <div className="mt-3 space-y-0.5 text-xs text-slate-400">
        <p>
          {model} · {new Date(analyzedAt).toLocaleString("zh-CN")}
          {fromCache && " · 命中缓存（零 LLM 调用）"}
        </p>
        {usage && (
          <p data-testid="token-usage">
            本次消耗 {fmtTokens(usage.totalTokens)} tokens（输入 {fmtTokens(usage.promptTokens)} /
            输出 {fmtTokens(usage.completionTokens)}
            {usage.cachedTokens ? `，其中 ${fmtTokens(usage.cachedTokens)} 命中提示词缓存` : ""}）
          </p>
        )}
      </div>
    </section>
  );
}

import type { FunnelStage, RuleSource, ScreenRuleHit } from "../../types";

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
export function RuleDetails({ hits }: { hits: ScreenRuleHit[] }) {
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

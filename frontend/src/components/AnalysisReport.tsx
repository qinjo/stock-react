import type { Analysis } from "../types";

type Props = {
  analysis: Analysis;
};

/**
 * 分析报告：四节正文（快照/基本面/技术面/风险）+ 三个收尾块。
 *
 * 结构变更依据（调研笔记）：
 * - 删除 conclusion 段（顶层已有 rating，conclusion 只会产出"综上所述"套话）
 * - 改为「数据边界」「什么会改变判断」「监控指标」三块收尾
 *   （dexter `memo-style.md:80-88`：以监控 KPI 收尾，而非结论段）
 */
export default function AnalysisReport({ analysis }: Props) {
  const s = analysis.sections;

  const blocks: Array<{ title: string; body: string }> = [
    { title: "① 公司与数据快照", body: s.snapshot },
    { title: "② 基本面评估", body: s.fundamentals },
    { title: "③ 技术面评估", body: s.technicals },
  ];

  const hasTail =
    analysis.dataLimits.length > 0 ||
    analysis.whatWouldChangeMyMind !== "" ||
    analysis.monitoring.length > 0;

  return (
    <article className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {blocks.map(({ title, body }) => (
        <section key={title}>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          {/* 卡片保持全宽，仅正文限宽：超宽屏上长行难读（理想行宽约 65–75 字符） */}
          <p className="mt-1 max-w-4xl whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {body || "（模型未提供该节内容）"}
          </p>
        </section>
      ))}

      <section>
        <h3 className="text-sm font-semibold text-slate-800">④ 风险点清单</h3>
        {s.risks.length > 0 ? (
          <ul className="mt-1 max-w-4xl list-inside list-disc space-y-1 text-sm text-slate-700">
            {s.risks.map((risk, i) => (
              <li key={`${i}-${risk.slice(0, 12)}`}>{risk}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-slate-400">（模型未列出风险点）</p>
        )}
      </section>

      {hasTail && (
        <div className="space-y-4 border-t border-slate-100 pt-4">
          {analysis.dataLimits.length > 0 && (
            <section data-testid="data-limits">
              <h3 className="text-sm font-semibold text-amber-700">⑤ 数据边界与局限</h3>
              <p className="mt-0.5 text-xs text-slate-400">
                本次分析未覆盖的信息，及其对结论的限制
              </p>
              <ul className="mt-1 max-w-4xl list-inside list-disc space-y-1 text-sm text-slate-600">
                {analysis.dataLimits.map((limit, i) => (
                  <li key={`${i}-${limit.slice(0, 12)}`}>{limit}</li>
                ))}
              </ul>
            </section>
          )}

          {analysis.whatWouldChangeMyMind !== "" && (
            <section data-testid="change-my-mind">
              <h3 className="text-sm font-semibold text-slate-800">⑥ 什么会改变这一判断</h3>
              <p className="mt-1 max-w-4xl whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
                {analysis.whatWouldChangeMyMind}
              </p>
            </section>
          )}

          {analysis.monitoring.length > 0 && (
            <section data-testid="monitoring">
              <h3 className="text-sm font-semibold text-slate-800">⑦ 后续监控指标</h3>
              <ul className="mt-1 max-w-4xl list-inside list-disc space-y-1 text-sm text-slate-700">
                {analysis.monitoring.map((item, i) => (
                  <li key={`${i}-${item.slice(0, 12)}`}>{item}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </article>
  );
}

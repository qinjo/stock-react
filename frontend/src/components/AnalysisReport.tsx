import type { AnalysisSections } from "../types";

type Props = {
  sections: AnalysisSections;
};

/** 五节分析报告：①快照 ②基本面 ③技术面 ④风险清单 ⑤结论。 */
export default function AnalysisReport({ sections }: Props) {
  const blocks: Array<{ title: string; body: string }> = [
    { title: "① 公司与数据快照", body: sections.snapshot },
    { title: "② 基本面评估", body: sections.fundamentals },
    { title: "③ 技术面评估", body: sections.technicals },
  ];

  return (
    <article className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      {blocks.map(({ title, body }) => (
        <section key={title}>
          <h3 className="text-sm font-semibold text-slate-800">{title}</h3>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
            {body || "（模型未提供该节内容）"}
          </p>
        </section>
      ))}

      <section>
        <h3 className="text-sm font-semibold text-slate-800">④ 风险点清单</h3>
        {sections.risks.length > 0 ? (
          <ul className="mt-1 list-inside list-disc space-y-1 text-sm text-slate-700">
            {sections.risks.map((risk, i) => (
              <li key={`${i}-${risk.slice(0, 12)}`}>{risk}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-sm text-slate-400">（模型未列出风险点）</p>
        )}
      </section>

      <section>
        <h3 className="text-sm font-semibold text-slate-800">⑤ 结论与目标区间</h3>
        <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {sections.conclusion || "（模型未提供结论）"}
        </p>
      </section>
    </article>
  );
}

import type { Fundamentals, MetricPercentiles, PercentileStats } from "../types";

type Props = {
  fundamentals: Fundamentals;
};

function fmt(v: number | null | undefined, digits = 2, suffix = ""): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(digits)}${suffix}`;
}

function yi(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  const n = v / 1e8;
  return n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 涨跌/同比配色（正红负绿，A 股习惯）。 */
function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "text-slate-700";
  return v > 0 ? "text-red-600" : "text-emerald-600";
}

/** 分位可视化：左绿（低估）→ 右红（高估），标记当前分位位置。 */
function PercentileBar({ percentile }: { percentile: number }) {
  return (
    <div
      className="relative h-1.5 w-20 shrink-0 rounded-full bg-gradient-to-r from-emerald-300 via-amber-200 to-red-300"
      role="img"
      aria-label={`分位 ${percentile}%`}
    >
      <div
        className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded-sm bg-slate-700"
        style={{ left: `calc(${Math.min(100, Math.max(0, percentile))}% - 2px)` }}
      />
    </div>
  );
}

function percentileText(s: PercentileStats | null): string {
  return s ? `${s.percentile}%` : "样本不足";
}

/** 单行估值分位（当前值 + 近 3 年 / 近 5 年分位）。 */
function MetricRow({ label, m, digits = 2 }: { label: string; m: MetricPercentiles; digits?: number }) {
  const marker: PercentileStats | null = m.y3 ?? m.y5;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className="w-16 font-medium text-slate-600">{label}</span>
      <span className="w-16 text-right font-semibold text-slate-900">
        {fmt(m.current, digits)}
      </span>
      {marker && <PercentileBar percentile={marker.percentile} />}
      <span className="text-slate-500">
        近3年 <span className="font-medium text-slate-700">{percentileText(m.y3)}</span>
        {m.y3 && <span className="ml-1 text-slate-400">（{m.y3.min}–{m.y3.max}）</span>}
      </span>
      <span className="text-slate-500">
        近5年 <span className="font-medium text-slate-700">{percentileText(m.y5)}</span>
      </span>
    </div>
  );
}

/**
 * 基本面与估值面板：把此前只喂给模型的数据也展示给人看。
 * 三块：①估值分位（相对自身历史）②同业对比（相对同行业）③财务趋势
 */
export default function FundamentalsPanel({ fundamentals: f }: Props) {
  const peers = f.peers;
  const recent = f.periods.slice(0, 4);

  return (
    <section className="space-y-4 rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-700">基本面与估值</h2>
        <p className="text-xs text-slate-400">
          {f.industry ?? "行业未知"}
          {f.valuation.asOf && ` · 估值截至 ${f.valuation.asOf}`}
        </p>
      </header>

      {/* ① 估值分位（相对自身历史） */}
      <section data-testid="valuation-percentiles">
        <h3 className="text-xs font-semibold text-slate-500">相对自身历史分位</h3>
        <div className="mt-1.5 space-y-1">
          <MetricRow label="PE_TTM" m={f.valuation.pe} />
          <MetricRow label="PB_MRQ" m={f.valuation.pb} />
        </div>
        <p className="mt-1 text-xs text-slate-400">
          分位越低表示越接近历史低估区间（&lt;20% 低位，&gt;80% 高位）
        </p>
      </section>

      {/* ② 同业对比（相对同行业） */}
      {peers && (
        <section data-testid="peer-comparison" className="border-t border-slate-100 pt-3">
          <h3 className="text-xs font-semibold text-slate-500">
            同业对比 · {peers.industry}（{peers.peerCount} 只）
          </h3>
          <div className="mt-1.5 space-y-1 text-xs">
            {peers.pe && (
              <div className="flex flex-wrap items-center gap-x-3">
                <span className="text-slate-500">行业 PE 中位</span>
                <span className="font-medium text-slate-800">{peers.pe.median}</span>
                <span className="text-slate-400">
                  （25 分位 {peers.pe.p25} / 75 分位 {peers.pe.p75}）
                </span>
                {peers.pePremium !== null && (
                  <span className={signClass(-peers.pePremium)}>
                    本股{peers.pePremium > 0 ? "溢价" : "折价"} {Math.abs(peers.pePremium)}%
                  </span>
                )}
              </div>
            )}
            {peers.pb && (
              <div className="flex flex-wrap items-center gap-x-3">
                <span className="text-slate-500">行业 PB 中位</span>
                <span className="font-medium text-slate-800">{peers.pb.median}</span>
                {peers.pbPremium !== null && (
                  <span className={signClass(-peers.pbPremium)}>
                    本股{peers.pbPremium > 0 ? "溢价" : "折价"} {Math.abs(peers.pbPremium)}%
                  </span>
                )}
              </div>
            )}
            {peers.peRank !== null && (
              <p className="text-slate-500">
                PE 在 {peers.peerCount} 只同业中排第{" "}
                <span className="font-medium text-slate-800">{peers.peRank}</span> 低
                {peers.cheaperPeers !== null && `（${peers.cheaperPeers} 只更便宜）`}
              </p>
            )}
          </div>
        </section>
      )}

      {/* ③ 财务趋势 */}
      {recent.length > 0 && (
        <section data-testid="financial-trend" className="border-t border-slate-100 pt-3">
          <h3 className="text-xs font-semibold text-slate-500">
            财务趋势（最近 {recent.length} 期 · 年内累计口径）
          </h3>
          <div className="mt-1.5 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400">
                  <th className="py-1 text-left font-normal">报告期</th>
                  <th className="py-1 text-right font-normal">营收(亿)</th>
                  <th className="py-1 text-right font-normal">同比</th>
                  <th className="py-1 text-right font-normal">净利(亿)</th>
                  <th className="py-1 text-right font-normal">同比</th>
                  <th className="py-1 text-right font-normal">ROE</th>
                  <th className="py-1 text-right font-normal">毛利率</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((p) => (
                  <tr key={p.reportDate} className="border-t border-slate-50">
                    <td className="py-1 text-slate-700">{p.reportName}</td>
                    <td className="py-1 text-right text-slate-800">{yi(p.revenue)}</td>
                    <td className={`py-1 text-right ${signClass(p.revenueYoy)}`}>
                      {fmt(p.revenueYoy, 1, "%")}
                    </td>
                    <td className="py-1 text-right text-slate-800">{yi(p.netProfit)}</td>
                    <td className={`py-1 text-right ${signClass(p.netProfitYoy)}`}>
                      {fmt(p.netProfitYoy, 1, "%")}
                    </td>
                    <td className="py-1 text-right text-slate-700">{fmt(p.roe, 1, "%")}</td>
                    <td className="py-1 text-right text-slate-700">{fmt(p.grossMargin, 1, "%")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </section>
  );
}

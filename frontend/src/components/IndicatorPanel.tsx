import type { Indicators } from "../types";

type Props = {
  indicators: Indicators;
};

function fmt(v: number | null | undefined, digits = 2, suffix = ""): string {
  if (v === null || v === undefined) return "—";
  return `${v.toFixed(digits)}${suffix}`;
}

/** 涨跌用 A 股习惯配色（正=红，负=绿）。 */
function signClass(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "text-slate-700";
  return v > 0 ? "text-red-600" : "text-emerald-600";
}

/** RSI 分区提示（提示词里也强调强趋势中可能长期极端）。 */
function rsiHint(rsi: number | null): string {
  if (rsi === null) return "无数据";
  if (rsi >= 70) return "超买区";
  if (rsi <= 30) return "超卖区";
  return "中性区";
}

/** 紧凑技术指标面板：把后端算好的派生指标可视化（此前页面上完全看不到）。 */
export default function IndicatorPanel({ indicators: ind }: Props) {
  const macdState =
    ind.macd.hist === null ? "无数据" : ind.macd.hist > 0 ? "多头动能" : "空头动能";

  const cells: Array<{ group: string; items: Array<[string, string, string?]> }> = [
    {
      group: "趋势",
      items: [
        ["SMA50", fmt(ind.sma50)],
        ["SMA200", fmt(ind.sma200)],
        ["价格偏离", fmt(ind.priceVsSma50, 2, "%"), signClass(ind.priceVsSma50)],
      ],
    },
    {
      group: "动能",
      items: [
        ["RSI14", `${fmt(ind.rsi14)} · ${rsiHint(ind.rsi14)}`],
        ["MACD", fmt(ind.macd.dif), signClass(ind.macd.dif)],
        ["柱状图", fmt(ind.macd.hist), signClass(ind.macd.hist)],
      ],
    },
    {
      group: "波动",
      items: [
        ["ATR14", fmt(ind.atr14)],
        ["ATR占比", fmt(ind.atrPercent, 2, "%")],
        ["年化波动率", fmt(ind.volatility20d, 2, "%")],
      ],
    },
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-slate-700">技术指标</h2>
        <p className="text-xs text-slate-400">
          {ind.sampleSize} 根日K · {ind.fromDate} → {ind.toDate}
        </p>
      </header>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {cells.map(({ group, items }) => (
          <div key={group}>
            <p className="text-xs font-medium text-slate-400">{group}</p>
            <dl className="mt-1 space-y-0.5">
              {items.map(([label, value, color]) => (
                <div key={label} className="flex items-baseline justify-between gap-2">
                  <dt className="text-xs text-slate-500">{label}</dt>
                  <dd className={`text-xs font-medium ${color ?? "text-slate-800"}`}>{value}</dd>
                </div>
              ))}
            </dl>
          </div>
        ))}
      </div>

      <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1 border-t border-slate-100 pt-2 text-xs">
        <div className="flex gap-1.5">
          <dt className="text-slate-500">近20日</dt>
          <dd className={`font-medium ${signClass(ind.return20d)}`}>
            {fmt(ind.return20d, 2, "%")}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">近60日</dt>
          <dd className={`font-medium ${signClass(ind.return60d)}`}>
            {fmt(ind.return60d, 2, "%")}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">区间位置</dt>
          <dd className="font-medium text-slate-800">
            {fmt(ind.positionInRange, 1, "%")}
            <span className="ml-1 font-normal text-slate-400">
              （{fmt(ind.periodLow)}–{fmt(ind.periodHigh)}）
            </span>
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">MACD</dt>
          <dd className="text-slate-500">
            DIF {fmt(ind.macd.dif)} / DEA {fmt(ind.macd.dea)} · {macdState}
          </dd>
        </div>
      </dl>
    </section>
  );
}

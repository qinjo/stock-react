import type { Quote } from "../types";

function fmt(v: number | null, digits = 2, suffix = ""): string {
  if (v === null || v === undefined) return "—";
  return `${v.toLocaleString("zh-CN", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}${suffix}`;
}

/** 大额数值（市值/成交额）转「亿/万」可读单位。 */
function fmtBig(v: number | null): string {
  if (v === null || v === undefined) return "—";
  const grouped = (n: number) =>
    n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (Math.abs(v) >= 1e8) return `${grouped(v / 1e8)} 亿`;
  if (Math.abs(v) >= 1e4) return `${grouped(v / 1e4)} 万`;
  return grouped(v);
}

type Props = {
  quote: Quote;
  /** 数据截至日期（来自日K最后一根），用于时效标注 */
  dataDate?: string;
};

/** 行情快照卡：身份 + 价格 + 估值 + 数据时效。 */
export default function QuoteCard({ quote, dataDate }: Props) {
  const up = (quote.changePercent ?? 0) > 0;
  const down = (quote.changePercent ?? 0) < 0;
  const priceColor = up ? "text-red-600" : down ? "text-emerald-600" : "text-slate-900";

  const cells: Array<[string, string]> = [
    ["今开", fmt(quote.open)],
    ["最高", fmt(quote.high)],
    ["最低", fmt(quote.low)],
    ["昨收", fmt(quote.prevClose)],
    ["涨停", fmt(quote.limitUp)],
    ["跌停", fmt(quote.limitDown)],
    ["成交量", quote.volume === null ? "—" : `${quote.volume.toLocaleString("zh-CN")} 手`],
    ["成交额", fmtBig(quote.amount)],
    ["总市值", fmtBig(quote.marketCap)],
    ["流通市值", fmtBig(quote.floatMarketCap)],
    ["市盈率(动)", fmt(quote.pe)],
    ["市净率", fmt(quote.pb)],
    ["换手率", fmt(quote.turnoverRate, 2, "%")],
  ];

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">
            {quote.name} <span className="text-sm font-normal text-slate-500">{quote.code}</span>
          </h2>
        </div>
        <div className={`text-right ${priceColor}`}>
          <div className="text-2xl font-semibold">{fmt(quote.price)}</div>
          <div className="text-sm">
            {quote.changePercent === null
              ? "—"
              : `${quote.changePercent > 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%`}
          </div>
        </div>
      </header>

      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
        {cells.map(([label, value]) => (
          <div key={label} className="flex justify-between border-b border-slate-100 pb-1">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="text-sm text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>

      {dataDate && (
        <p className="mt-3 text-xs text-slate-400">数据截至：{dataDate}（行情快照与日K同源）</p>
      )}
    </section>
  );
}

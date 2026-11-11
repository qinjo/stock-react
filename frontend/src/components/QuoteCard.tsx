import { Panel } from "./ui/Panel";
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
    <Panel
      title={
        <span className="text-base font-semibold tracking-tight text-slate-900">
          {quote.name}{" "}
          <span className="text-xs font-normal tabular-nums text-slate-500">{quote.code}</span>
        </span>
      }
      meta="行情快照 · 与日K同源"
      actions={
        <div className={`text-right tabular-nums ${priceColor}`}>
          <div className="text-2xl font-semibold leading-tight">{fmt(quote.price)}</div>
          <div className="text-xs font-medium">
            {quote.changePercent === null
              ? "—"
              : `${quote.changePercent > 0 ? "+" : ""}${quote.changePercent.toFixed(2)}%`}
          </div>
        </div>
      }
      bodyClassName="p-3.5"
    >
      {/* 快照横跨整行渲染，列数随宽度增加；窄屏保持两列不挤 */}
      <dl className="grid grid-cols-2 gap-x-5 gap-y-1.5 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {cells.map(([label, value]) => (
          <div
            key={label}
            className="flex items-baseline justify-between gap-2 border-b border-slate-100 pb-1"
          >
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="text-sm tabular-nums text-slate-800">{value}</dd>
          </div>
        ))}
      </dl>

      {dataDate && (
        <p className="mt-3 text-xs text-slate-400">
          数据截至：{dataDate}（行情快照与日K同源）
        </p>
      )}
    </Panel>
  );
}

import type {
  BacktestBucket,
  BacktestResponse,
  BacktestStockRow,
  BacktestSummary,
} from "../../types";

/**
 * 回测结果的纯展示层。
 *
 * 设计约束：**先给边界、再给数字**。代理宇宙、单一行情周期、未建模滑点这些
 * 会改变结论可信度的事实放在最上面，防止读者只记住"胜率 31%"。
 */

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function ratio(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(2);
}

function num(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function bucketRows(buckets: readonly BacktestBucket[]) {
  return buckets.map((bucket) => (
    <tr key={bucket.key} className="border-t border-slate-100">
      <td className="px-2 py-1 text-slate-700">{bucket.key}</td>
      <td className="px-2 py-1 text-right tabular-nums text-slate-700">{bucket.trades}</td>
      <td className="px-2 py-1 text-right tabular-nums text-slate-700">{pct(bucket.winRate, 1)}</td>
      <td
        className={`px-2 py-1 text-right tabular-nums ${
          (bucket.avgNetReturn ?? 0) >= 0 ? "text-red-600" : "text-emerald-700"
        }`}
      >
        {pct(bucket.avgNetReturn)}
      </td>
    </tr>
  ));
}

function BucketTable({ title, buckets }: { title: string; buckets: readonly BacktestBucket[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
        {title}
      </h3>
      {buckets.length === 0 ? (
        <p className="px-3 py-3 text-sm text-slate-500">样本内没有交易。</p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-slate-500">
              <th className="px-2 py-1 font-medium">分组</th>
              <th className="px-2 py-1 text-right font-medium">交易数</th>
              <th className="px-2 py-1 text-right font-medium">胜率</th>
              <th className="px-2 py-1 text-right font-medium">平均单笔</th>
            </tr>
          </thead>
          <tbody>{bucketRows(buckets)}</tbody>
        </table>
      )}
    </div>
  );
}

function StockTable({ title, rows }: { title: string; rows: readonly BacktestStockRow[] }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <h3 className="border-b border-slate-100 px-3 py-2 text-sm font-medium text-slate-700">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="px-3 py-3 text-sm text-slate-500">样本内没有交易。</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-slate-500">
                <th className="px-2 py-1 font-medium">代码</th>
                <th className="px-2 py-1 font-medium">名称</th>
                <th className="px-2 py-1 text-right font-medium">交易</th>
                <th className="px-2 py-1 text-right font-medium">胜率</th>
                <th className="px-2 py-1 text-right font-medium">策略收益</th>
                <th className="px-2 py-1 text-right font-medium">买入持有</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.code} className="border-t border-slate-100">
                  <td className="px-2 py-1 tabular-nums text-slate-700">{row.code}</td>
                  <td className="px-2 py-1 text-slate-700">{row.name ?? "—"}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-700">{row.trades}</td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-700">
                    {pct(row.winRate, 1)}
                  </td>
                  <td
                    className={`px-2 py-1 text-right tabular-nums ${
                      row.totalReturn >= 0 ? "text-red-600" : "text-emerald-700"
                    }`}
                  >
                    {pct(row.totalReturn)}
                  </td>
                  <td className="px-2 py-1 text-right tabular-nums text-slate-500">
                    {pct(row.buyHoldReturn)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Histogram({ buckets }: { buckets: BacktestResponse["histogram"] }) {
  if (buckets.length === 0) {
    return <p className="text-sm text-slate-500">样本内没有交易。</p>;
  }
  const max = Math.max(...buckets.map((bucket) => bucket.count));
  return (
    <div className="space-y-0.5">
      {buckets.map((bucket) => (
        <div key={bucket.from} className="flex items-center gap-2 text-[11px]">
          <span className="w-20 shrink-0 text-right tabular-nums text-slate-500">
            {pct(bucket.from, 0)}~{pct(bucket.to, 0)}
          </span>
          <div className="h-2 flex-1 overflow-hidden rounded bg-slate-100">
            <div
              className={`h-full ${bucket.from < 0 ? "bg-emerald-400" : "bg-red-400"}`}
              style={{ width: `${max === 0 ? 0 : (bucket.count / max) * 100}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right tabular-nums text-slate-500">
            {bucket.count}
          </span>
        </div>
      ))}
    </div>
  );
}

function Comparison({ summary }: { summary: BacktestSummary }) {
  const beat = summary.beatBuyHoldStocks;
  const total = summary.stocksWithBuyHold;
  return (
    <p className="text-sm text-slate-600">
      有交易的标的：逐票平均总收益{" "}
      <strong className={(summary.avgTotalReturn ?? 0) >= 0 ? "text-red-600" : "text-emerald-700"}>
        {pct(summary.avgTotalReturn)}
      </strong>
      ，同期买入持有平均 <strong>{pct(summary.avgBuyHold)}</strong>；跑赢买入持有{" "}
      <strong>
        {beat}/{total}
      </strong>{" "}
      只。
    </p>
  );
}

export default function BacktestResult({ data }: { data: BacktestResponse }) {
  const summary = data.tradedSummary;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500">
        <span>
          数据截止 <strong className="text-slate-700">{data.dataDate}</strong>
        </span>
        <span>
          区间 {data.from} → {data.to}
        </span>
        <span>
          样本 {data.window.instruments} 只（有交易 {data.stocks.traded} 只）
        </span>
        <span>
          {summary.trades} 笔交易 · 耗时 {(data.elapsedMs / 1000).toFixed(1)}s
        </span>
        {data.fromCache && (
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-slate-600">缓存命中</span>
        )}
      </div>

      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900">
        <p className="font-medium">先说边界</p>
        <p className="mt-1">
          宇宙是<strong>代理指标</strong>（{data.universe}），不是真实人气榜；样本只覆盖这一段市场周期，
          <strong>结论不可外推</strong>。滑点未建模、涨跌停不可成交为近似、ST 历史状态不可知——这些都会让真实结果更差。
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard label="胜率" value={pct(summary.winRate, 1)} hint={`${summary.wins}/${summary.trades}`} />
        <StatCard label="平均单笔净收益" value={pct(summary.avgNetReturn)} hint={`中位 ${pct(summary.medianNetReturn)}`} />
        <StatCard label="盈亏比" value={ratio(summary.profitFactor)} hint={`最差单笔 ${pct(summary.maxLoss)}`} />
        <StatCard label="平均持有" value={`${num(summary.avgHoldingDays)} 交易日`} hint={`逐票平均回撤 ${pct(summary.avgMaxDrawdown)}`} />
      </div>

      <Comparison summary={summary} />

      <div className="grid gap-3 md:grid-cols-2">
        <BucketTable title="按年份" buckets={data.buckets.year} />
        <BucketTable title="按板块" buckets={data.buckets.board} />
      </div>

      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <h3 className="text-sm font-medium text-slate-700">单笔收益分布</h3>
        <p className="mt-1 text-xs text-slate-500">
          中位数 {pct(summary.medianNetReturn)} 才是"典型一笔"的样子；均值会被少数大赚的单子拉高。
        </p>
        <div className="mt-2">
          <Histogram buckets={data.histogram} />
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <StockTable title="表现最好 10 只" rows={data.stocks.best} />
        <StockTable title="表现最差 10 只" rows={data.stocks.worst} />
      </div>

      <p className="text-xs text-slate-400">
        逐票全部交易明细请用 CLI 导出：<code className="rounded bg-slate-100 px-1">npm run backtest:kdj -- --trades-out reports/trades.csv</code>
      </p>
    </section>
  );
}

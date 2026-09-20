import { useEffect, useRef } from "react";
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import type { Kline } from "../types";

/** 领域 K 线 → klinecharts v10 的 KLineData（timestamp 需毫秒）。 */
export function toKLineData(rows: Kline[]): KLineData[] {
  return rows.map((r) => ({
    timestamp: Date.parse(`${r.date}T00:00:00+08:00`),
    open: r.open,
    high: r.high,
    low: r.low,
    close: r.close,
    volume: r.volume,
  }));
}

type Props = {
  klines: Kline[];
  /** 标的变化时触发重载（如 600519） */
  symbol: string;
};

/**
 * 日 K 走势图（klinecharts v10）。
 * v10 无 applyNewData：通过 setDataLoader 的 getBars 回调按需供给数据，
 * 数据经 ref 读取最新值，避免初始化闭包拿到旧数组。
 */
export default function KlineChart({ klines, symbol }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<Chart | null>(null);
  const dataRef = useRef<KLineData[]>([]);

  dataRef.current = toKLineData(klines);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const chart = init(el);
    chartRef.current = chart;

    chart?.setDataLoader({
      getBars: ({ callback }) => {
        // 单次全量返回，不声明可继续加载（MVP 只展示 60 根）
        callback(dataRef.current, { forward: false, backward: false });
      },
    });
    chart?.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 });
    chart?.setPeriod({ type: "day", span: 1 });

    const onResize = () => chart?.resize();
    window.addEventListener("resize", onResize);

    return () => {
      window.removeEventListener("resize", onResize);
      dispose(el);
      chartRef.current = null;
    };
    // symbol 变化需要重新设置标的信息（下方 effect 处理）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 数据/标的更新 → 重新加载
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod({ type: "day", span: 1 });
  }, [symbol, klines]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-sm font-medium text-slate-700">日 K 走势（前复权）</h2>
      <div ref={containerRef} className="mt-2 h-80 w-full" data-testid="kline-container" />
      {klines.length === 0 && (
        <p className="mt-2 text-sm text-slate-400">暂无 K 线数据</p>
      )}
    </section>
  );
}

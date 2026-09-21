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
  /**
   * 宽屏下让图表填满左栏剩余高度（左栏为 flex 列布局时使用）。
   * 这样左栏总高恰好等于视口高度，不会出现「左栏内部滚动条」。
   * 窄屏仍用固定高度，避免非 flex 容器里 flex-1 失效导致塌陷。
   */
  fillHeight?: boolean;
};

/**
 * 日 K 走势图（klinecharts v10）。
 * v10 无 applyNewData：通过 setDataLoader 的 getBars 回调按需供给数据，
 * 数据经 ref 读取最新值，避免初始化闭包拿到旧数组。
 */
export default function KlineChart({ klines, symbol, fillHeight = false }: Props) {
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
        // 单次全量返回，不声明可继续加载（MVP 只展示已有数据）
        callback(dataRef.current, { forward: false, backward: false });
      },
    });

    // 主图叠加 SMA50 / SMA200：与后端指标口径一致，趋势关系一眼可见
    // （paneId 指向蜡烛主图；数据需 ≥200 根，故上游按 250 根取数）
    chart?.createIndicator(
      { name: "MA", calcParams: [50, 200], paneId: "candle_pane" },
      false,
    );
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
    // 弹性高度布局下列表变高变矮不触发 window resize，需主动重算
    chart.resize();
  }, [symbol, klines]);

  return (
    <section
      className={`rounded-lg border border-slate-200 bg-white p-4 shadow-sm ${
        fillHeight ? "lg:flex lg:min-h-0 lg:flex-col" : ""
      }`}
    >
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm font-medium text-slate-700">日 K 走势（前复权）</h2>
        <span className="text-xs text-slate-400">MA50 / MA200</span>
      </div>
      <div
        ref={containerRef}
        className={`mt-2 w-full ${
          fillHeight ? "h-[22rem] lg:h-auto lg:min-h-[12rem] lg:flex-1" : "h-[22rem]"
        }`}
        data-testid="kline-container"
      />
      {klines.length === 0 && (
        <p className="mt-2 text-sm text-slate-400">暂无 K 线数据</p>
      )}
    </section>
  );
}

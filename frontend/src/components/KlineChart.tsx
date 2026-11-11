import { useEffect, useRef } from "react";
import { dispose, init, type Chart, type KLineData } from "klinecharts";
import { Panel } from "./ui/Panel";
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
 *
 * 卡片外框交给 Panel；fillHeight 时把 Panel 自身与内容区都变成 flex 列，
 * 内层图表容器（h-[22rem] / lg:flex-1）才能吃掉剩余高度。
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

    // A 股习惯：红涨绿跌，与快照卡、指标面板的配色保持一致。
    // klinecharts 默认是绿涨红跌（欧美习惯），不改会与页面其余部分自相矛盾。
    chart?.setStyles({
      candle: {
        bar: {
          upColor: "#dc2626",
          downColor: "#059669",
          noChangeColor: "#64748b",
          upBorderColor: "#dc2626",
          downBorderColor: "#059669",
          noChangeBorderColor: "#64748b",
          upWickColor: "#dc2626",
          downWickColor: "#059669",
          noChangeWickColor: "#64748b",
        },
      },
      indicator: {
        ohlc: { upColor: "#dc2626", downColor: "#059669", noChangeColor: "#64748b" },
        bars: [
          {
            upColor: "rgba(220, 38, 38, 0.55)",
            downColor: "rgba(5, 150, 105, 0.55)",
            noChangeColor: "rgba(100, 116, 139, 0.55)",
          },
        ],
      },
    });

    const onResize = () => chart?.resize();
    window.addEventListener("resize", onResize);

    // 左栏是弹性高度：窗口/侧栏/面板内布局变化不触发 window resize，
    // 用 ResizeObserver 兜住，否则画布高度没跟上会裁掉底部日期轴。
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
    observer?.observe(el);

    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
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
    <Panel
      title="日 K 走势（前复权）"
      meta="MA50 / MA200"
      className={`overflow-hidden ${fillHeight ? "lg:flex lg:min-h-0 lg:flex-1 lg:flex-col" : ""}`}
      bodyClassName={
        fillHeight ? "flex min-h-0 flex-col p-4 lg:flex-1" : "p-4"
      }
    >
      <div
        ref={containerRef}
        className={`w-full ${
          fillHeight
            ? "h-[22rem] lg:h-auto lg:min-h-[12rem] lg:flex-1"
            : "h-[22rem] lg:h-[26rem]"
        }`}
        data-testid="kline-container"
      />
      {klines.length === 0 && (
        <p className="mt-2 text-sm text-slate-400">暂无 K 线数据</p>
      )}
    </Panel>
  );
}

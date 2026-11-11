import type { BacktestParams } from "./types.js";

/**
 * 回测参数表 —— 与 `screener/params.ts` 同样的纪律：**阈值不散落在代码里**，
 * 每条都带来源标注，报告会原样列出，读者才能分清"用户定的"与"我们补的"。
 *
 * 来源三级（沿用仓库既有词汇，但把 `book` 换成 `user`）：
 * - `user`     用户策略原话直接给出
 * - `inferred` 用户只说了定性概念，阈值由本项目推断（必须被回测校准）
 * - `offbook`  用户没有、由本项目补的工程/交易约束
 */

export type BacktestProvenance = {
  source: "user" | "inferred" | "offbook";
  note: string;
};

export const BACKTEST_PROVENANCE: Record<keyof BacktestParams, BacktestProvenance> = {
  kdjPeriod: { source: "inferred", note: "用户只说 KDJ，未给参数；A 股软件默认 RSV 窗口 9" },
  kdjKSmooth: { source: "inferred", note: "A 股 KDJ 默认 SMA(K,3,1) 平滑" },
  kdjDSmooth: { source: "inferred", note: "A 股 KDJ 默认 SMA(D,3,1) 平滑" },
  hotWindow: { source: "inferred", note: "「近一个月」按 20 个交易日近似，不是 30 个自然日" },
  hotTopN: { source: "inferred", note: "「热门列表」取横截面排名前 100；无历史榜单时的可重建代理" },
  minBars: { source: "offbook", note: "指标与窗口预热所需的最少 K 线根数" },
  capital: { source: "offbook", note: "逐票独立资金规模，只影响整手取整与最低佣金" },
  commissionRate: { source: "offbook", note: "券商佣金万分之 2.5（双边）" },
  commissionMin: { source: "offbook", note: "券商佣金最低 5 元/笔" },
  stampTaxRate: { source: "offbook", note: "印花税千分之 0.5，仅卖出" },
  transferFeeRate: { source: "offbook", note: "过户费万分之 0.1（双边）" },
  lotSize: { source: "offbook", note: "A 股整手 100 股" },
};

export const DEFAULT_BACKTEST_PARAMS: BacktestParams = {
  kdjPeriod: 9,
  kdjKSmooth: 3,
  kdjDSmooth: 3,
  hotWindow: 20,
  hotTopN: 100,
  minBars: 60,
  capital: 100_000,
  commissionRate: 0.00025,
  commissionMin: 5,
  stampTaxRate: 0.0005,
  transferFeeRate: 0.00001,
  lotSize: 100,
};

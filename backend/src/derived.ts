import type { Quote } from "./domain.js";
import type { Indicators } from "./indicators.js";

/**
 * 派生估值量与信号一致性（纯函数，零外部数据、零 LLM 成本）。
 *
 * 设计依据（调研笔记）：
 * - ai-hedge-fund `features/snapshot.py`：派生聚合必须在 Python 里算好再喂，
 *   "so the LLM reasons over facts instead of re-deriving arithmetic"。
 * - A_Share_investment_Agent `src/agents/technicals.py:134-136`：
 *   `confidence = max(bullish, bearish) / total_signals`，用指标一致性约束置信度，
 *   比任何措辞都更能治「永远 60-70 分」的中庸输出。
 */

/**
 * 隐含估值量：**仅用 PE(动)、PB、最新价、市值**反推。
 *
 * 数学依据：PB/PE = (P/B) ÷ (P/E) = E/B = ROE。
 * 同理：EPS = P/PE，BVPS = P/PB，净利润 = 市值/PE，净资产 = 市值/PB。
 *
 * 实测校准（2026-09）：茅台 35.4%（实际约 35%）、宁德 23.2%（约 22%）、
 * 招行 13.4%（约 13%）—— 精度足以支撑基本面讨论，且是推导而非编造。
 */
export type ImpliedValuation = {
  /** 隐含 ROE（%）= PB / PE × 100 */
  impliedRoe: number | null;
  /** 隐含每股收益（元）= 最新价 / PE(动) */
  impliedEps: number | null;
  /** 隐含每股净资产（元）= 最新价 / PB */
  impliedBvps: number | null;
  /** 隐含净利润（元）= 总市值 / PE(动) */
  impliedNetProfit: number | null;
  /** 隐含净资产（元）= 总市值 / PB */
  impliedEquity: number | null;
};

function safeDiv(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
  return a / b;
}

function round(v: number | null, digits = 2): number | null {
  return v === null || !Number.isFinite(v) ? null : Number(v.toFixed(digits));
}

export function deriveValuation(quote: Quote): ImpliedValuation {
  const { pe, pb, price, marketCap } = quote;

  // PE/PB 为负或为 0 时（亏损公司）推导无意义，一律置 null
  const usablePe = pe !== null && pe > 0 ? pe : null;
  const usablePb = pb !== null && pb > 0 ? pb : null;

  return {
    impliedRoe: round(
      usablePe !== null && usablePb !== null ? (usablePb / usablePe) * 100 : null,
    ),
    impliedEps: round(safeDiv(price, usablePe)),
    impliedBvps: round(safeDiv(price, usablePb)),
    impliedNetProfit: round(safeDiv(marketCap, usablePe), 0),
    impliedEquity: round(safeDiv(marketCap, usablePb), 0),
  };
}

/** 单个信号的方向判定。 */
export type SignalDirection = "bullish" | "bearish" | "neutral";

export type SignalTally = {
  bullish: number;
  bearish: number;
  neutral: number;
  total: number;
  /** 一致性比例 = max(看多, 看空) / 总数，0.5 表示完全分歧 */
  consistency: number;
  /** 由一致性推出的置信度上限（供提示词约束 LLM） */
  maxConfidence: number;
  /** 逐项明细，便于在提示词里列出（模型可见自己的判断依据） */
  items: Array<{ name: string; direction: SignalDirection; detail: string }>;
};

/**
 * 用 12 项派生指标统计多空一致性。
 *
 * 一致性到置信度上限的映射（保守设计，宁可压低也不放任模型给高分）：
 * - consistency ≥ 0.9 → 90
 * - ≥ 0.75 → 80
 * - ≥ 0.6  → 65
 * - ≥ 0.5  → 50（完全分歧）
 */
export function tallySignals(ind: Indicators, quote: Quote): SignalTally {
  const items: SignalTally["items"] = [];
  const push = (name: string, direction: SignalDirection, detail: string) =>
    items.push({ name, direction, detail });

  const price = quote.price;

  // 1) 价格 vs SMA50
  if (ind.sma50 !== null && price !== null) {
    push(
      "价格/SMA50",
      price > ind.sma50 ? "bullish" : "bearish",
      `${price} vs ${ind.sma50}`,
    );
  }
  // 2) 价格 vs SMA200
  if (ind.sma200 !== null && price !== null) {
    push(
      "价格/SMA200",
      price > ind.sma200 ? "bullish" : "bearish",
      `${price} vs ${ind.sma200}`,
    );
  }
  // 3) 均线多头/空头排列
  if (ind.sma50 !== null && ind.sma200 !== null) {
    push(
      "均线排列",
      ind.sma50 > ind.sma200 ? "bullish" : "bearish",
      `SMA50 ${ind.sma50} vs SMA200 ${ind.sma200}`,
    );
  }
  // 4) MACD DIF vs DEA
  if (ind.macd.dif !== null && ind.macd.dea !== null) {
    push(
      "MACD DIF/DEA",
      ind.macd.dif > ind.macd.dea ? "bullish" : "bearish",
      `DIF ${ind.macd.dif} vs DEA ${ind.macd.dea}`,
    );
  }
  // 5) MACD 柱状图
  if (ind.macd.hist !== null) {
    push(
      "MACD 柱",
      ind.macd.hist > 0 ? "bullish" : "bearish",
      `hist ${ind.macd.hist}`,
    );
  }
  // 6) RSI 50 轴（超买超卖单独标注但不作为方向）
  if (ind.rsi14 !== null) {
    const dir: SignalDirection = ind.rsi14 > 50 ? "bullish" : "bearish";
    const zone = ind.rsi14 >= 70 ? "（超买）" : ind.rsi14 <= 30 ? "（超卖）" : "";
    push("RSI14", dir, `${ind.rsi14}${zone}`);
  }
  // 7/8) 区间涨跌幅
  if (ind.return20d !== null) {
    push("20日涨跌", ind.return20d > 0 ? "bullish" : "bearish", `${ind.return20d}%`);
  }
  if (ind.return60d !== null) {
    push("60日涨跌", ind.return60d > 0 ? "bullish" : "bearish", `${ind.return60d}%`);
  }
  // 9) 区间位置（中位以上偏多）
  if (ind.positionInRange !== null) {
    push(
      "区间位置",
      ind.positionInRange > 50 ? "bullish" : "bearish",
      `${ind.positionInRange}%`,
    );
  }
  // 10) 20日 vs 60日动能（加速度）
  if (ind.return20d !== null && ind.return60d !== null) {
    push(
      "动能加速度",
      ind.return20d > ind.return60d ? "bullish" : "bearish",
      `20日 ${ind.return20d}% vs 60日 ${ind.return60d}%`,
    );
  }
  // 11) 波动率水平（年化 >40% 视为风险偏高 → 偏空）
  if (ind.volatility20d !== null) {
    push(
      "波动率",
      ind.volatility20d > 40 ? "bearish" : "neutral",
      `${ind.volatility20d}%`,
    );
  }
  // 12) 价格 vs 隐含每股净资产（PB 视角，破净偏空/低估）
  if (quote.pb !== null) {
    push(
      "市净率",
      quote.pb < 1 ? "bearish" : "neutral",
      `PB ${quote.pb}${quote.pb < 1 ? "（破净）" : ""}`,
    );
  }

  const bullish = items.filter((i) => i.direction === "bullish").length;
  const bearish = items.filter((i) => i.direction === "bearish").length;
  const neutral = items.filter((i) => i.direction === "neutral").length;
  const decisive = bullish + bearish;
  const consistency = decisive === 0 ? 0 : Math.max(bullish, bearish) / decisive;

  return {
    bullish,
    bearish,
    neutral,
    total: items.length,
    consistency: Number(consistency.toFixed(2)),
    maxConfidence: consistencyToMaxConfidence(consistency),
    items,
  };
}

/** 一致性比例 → 置信度上限。 */
export function consistencyToMaxConfidence(consistency: number): number {
  if (consistency >= 0.9) return 90;
  if (consistency >= 0.75) return 80;
  if (consistency >= 0.6) return 65;
  if (consistency >= 0.5) return 50;
  return 45;
}

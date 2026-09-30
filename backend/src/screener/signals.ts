import type { Board } from "../market/qlib.js";
import { toDisplayPrice, type RuleContext } from "./rules.js";
import {
  detectLow123,
  fallingTrendlineAt,
  findSwingHighs,
  findSwingLows,
  rangeBounds,
  type SwingPoint,
} from "./structure.js";
import type {
  DailyBar,
  ExitPlan,
  ReferenceResistance,
  SignalHit,
  SignalId,
  SignalSet,
} from "./types.js";

export type { ExitPlan, ReferenceResistance, SignalHit, SignalId, SignalSet };

/**
 * 信号层（均线跟随模式）。
 *
 * 与基础池的分工：基础池回答"这只票**能不能**买"（站上 MA100、市值、流动性、非下跌趋势线之下），
 * 信号层回答"**现在**是不是买点"。两者都不看未来数据。
 *
 * 档序来自书里各条入场法的可靠性排序（见 `TIER_OF`）：
 * 底背离双突破 > 低位 123 > 三档入场 > MA20 上穿 > 阻力突破/支撑回踩。
 *
 * 所有结构位、止损位在**后复权空间**里计算（跨除权连续），最后统一折算回
 * **真实成交价**给用户——用户看到的价格必须是他能在盘口上认出来的那个数。
 */

/** 档序：数字越小越强。调整这里就调整了整个候选名单的顺序。 */
export const TIER_OF: Record<SignalId, number> = {
  S5: 1, // 底背离双突破（三重条件复合）
  S3: 2, // 低位 123 突破高点 2
  S2: 3, // 大参数均线入场（MA60 / MA100）
  S1: 4, // MA20 上穿
  S13: 5, // 阻力突破 / 支撑回踩（最泛化）
};

export type TrendSignals = {
  signals: SignalSet;
  exit: ExitPlan;
  resistance: ReferenceResistance[];
};

/** 固定比例止损：书 P6 的候选值里取中位（B12）。 */
const FIXED_STOP_RATIO = 0.02;

/** 上穿：当根在参考线上方、上一根不在。`offset` 用于回看。 */
function crossedUp(
  values: readonly number[],
  reference: ReadonlyArray<number | null>,
  offset = 0,
): boolean {
  const i = values.length - 1 - offset;
  if (i < 1) return false;
  const cur = reference[i];
  const prev = reference[i - 1];
  if (cur === null || cur === undefined || prev === null || prev === undefined) return false;
  return (values[i] as number) > cur && (values[i - 1] as number) <= prev;
}

/** 前一区间的最高价（不含最后一根）：书 S13 的"阻力"就是这么来的。 */
export function priorHigh(bars: readonly DailyBar[], lookback: number): number | null {
  if (bars.length < 2) return null;
  const slice = bars.slice(Math.max(0, bars.length - 1 - lookback), bars.length - 1);
  if (slice.length === 0) return null;
  return Math.max(...slice.map((bar) => bar.high));
}

/**
 * MACD 黄白线底背离的核心不变式：**价格创新低、DIF 没有创新低**。
 *
 * 书里画了 6 种形态（抬升式 / 下降式 / 平行式等），差异在两条线的相对位置；
 * 这里实现的是它们共同满足的那一条。`min(DIF, DEA)` 那种保守取值见 B6——
 * 我们用 DIF 单线，与书里「看黄白线」的用法一致。
 */
export function detectBullishDivergence(
  bars: readonly DailyBar[],
  dif: readonly number[],
  swingWindow: number,
  lookback: number,
): { recent: SwingPoint; previous: SwingPoint } | null {
  const from = Math.max(0, bars.length - lookback);
  const lows = findSwingLows(bars, swingWindow).filter((p) => p.index >= from);
  if (lows.length < 2) return null;

  const recent = lows[lows.length - 1] as SwingPoint;
  const previous = lows[lows.length - 2] as SwingPoint;
  // 价格创出更低的低点，而 DIF 的对应低点反而抬高 → 底背离
  if (recent.price >= previous.price) return null;
  const difRecent = dif[recent.index];
  const difPrevious = dif[previous.index];
  if (difRecent === undefined || difPrevious === undefined) return null;
  if (difRecent <= difPrevious) return null;

  return { recent, previous };
}

function detectSignals(ctx: RuleContext): SignalHit[] {
  const { adjBars, ma10, ma20, ma60, ma100, dif, params } = ctx;
  const closes = adjBars.map((bar) => bar.close);
  const last = adjBars[adjBars.length - 1];
  if (!last) return [];

  const hits: SignalHit[] = [];
  const push = (id: SignalId, label: string, detail: string, bookRef: string) => {
    hits.push({ id, label, tier: TIER_OF[id], detail, bookRef });
  };

  // ---- S1 / S2：均线突破入场（书 L462/L1877）----
  if (crossedUp(closes, ma20)) {
    push("S1", "MA20 上穿", `收盘 ${last.close.toFixed(2)} 上穿 MA20 ${(ma20[ma20.length - 1] ?? 0).toFixed(2)}`, "L462");
  }
  const bigMa = crossedUp(closes, ma100)
    ? { name: "MA100", value: ma100[ma100.length - 1] as number }
    : crossedUp(closes, ma60)
      ? { name: "MA60", value: ma60[ma60.length - 1] as number }
      : null;
  if (bigMa) {
    push(
      "S2",
      `大参数均线入场（${bigMa.name} 上穿）`,
      `收盘 ${last.close.toFixed(2)} 上穿 ${bigMa.name} ${bigMa.value.toFixed(2)}`,
      "L1877",
    );
  }

  // ---- S3：低位 123 突破高点 2（书 L681）----
  const low123 = detectLow123(adjBars, {
    swingWindow: params.swingWindow,
    lookback: params.low123Lookback,
  });
  if (low123?.brokenOut) {
    push(
      "S3",
      "低位 123 突破高点 2",
      `低点1 ${low123.l1.price.toFixed(2)} → 高点2 ${low123.h2.price.toFixed(2)} → 低点3 ${low123.l3.price.toFixed(2)}，已突破`,
      "L681",
    );
  }

  // ---- S5：底背离双突破（书 L958 五步流程的复合条件）----
  const divergence = detectBullishDivergence(adjBars, dif, params.swingWindow, params.low123Lookback);
  if (divergence) {
    const trendline = fallingTrendlineAt(adjBars, params.swingWindow, params.trendlineLookback);
    const resistance = findSwingHighs(adjBars, params.swingWindow).filter(
      (p) => p.index >= divergence.previous.index,
    );
    const pivot = resistance.length > 0 ? (resistance[resistance.length - 1] as SwingPoint) : null;
    const brokeTrendline = trendline !== null && last.close > trendline;
    const brokeResistance = pivot !== null && last.close > pivot.price;
    if (brokeTrendline && brokeResistance) {
      push(
        "S5",
        "底背离双突破",
        `价格创新低而 DIF 抬高（${divergence.previous.price.toFixed(2)} → ${divergence.recent.price.toFixed(2)}），` +
          `且同时突破下降趋势线 ${trendline.toFixed(2)} 与水平阻力 ${pivot.price.toFixed(2)}`,
        "L958",
      );
    }
  }

  // ---- S13：阻力突破 / 支撑回踩（书 L814：买入点一般有两个）----
  const resistanceLevel = priorHigh(adjBars, params.trendlineLookback);
  if (resistanceLevel !== null && last.close > resistanceLevel) {
    push(
      "S13",
      "阻力突破",
      `收盘 ${last.close.toFixed(2)} 突破前 ${params.trendlineLookback} 根高点 ${resistanceLevel.toFixed(2)}`,
      "L814",
    );
  } else {
    const lows = findSwingLows(adjBars, params.swingWindow);
    const support = lows.length > 0 ? (lows[lows.length - 1] as SwingPoint) : null;
    if (support && last.low <= support.price * 1.01 && last.close > support.price) {
      push(
        "S13",
        "支撑回踩确认",
        `回踩至 ${support.price.toFixed(2)} 后收在其上方（收盘 ${last.close.toFixed(2)}）`,
        "L814",
      );
    }
  }

  return hits.sort((a, b) => a.tier - b.tier);
}

/** 由命中的信号决定入场所用的大参数均线，进而决定止损配对（书 L1877）。 */
function maPairing(signals: readonly SignalHit[]): { entryMa: 20 | 60 | 100; stopMa: 10 | 20 | 60 } {
  const s2 = signals.find((hit) => hit.id === "S2");
  if (s2?.label.includes("MA100")) return { entryMa: 100, stopMa: 60 };
  if (s2?.label.includes("MA60")) return { entryMa: 60, stopMa: 20 };
  return { entryMa: 20, stopMa: 10 };
}

function buildExitPlan(ctx: RuleContext, signals: readonly SignalHit[]): ExitPlan {
  const { adjBars, ma10, ma20, ma60, params, bars } = ctx;
  const last = adjBars[adjBars.length - 1] as DailyBar;
  const lastFactor = (bars[bars.length - 1] as DailyBar).adjFactor;
  const entry = (bars[bars.length - 1] as DailyBar).close;

  const low123 = detectLow123(adjBars, {
    swingWindow: params.swingWindow,
    lookback: params.low123Lookback,
  });

  // 止损优先级（书 P5 → P4 → P6）：结构低点 → 均线配对 → 固定比例
  if (low123) {
    const stop = toDisplayPrice(low123.l3.price, lastFactor);
    if (stop < entry) {
      return {
        entry,
        stop,
        stopBasis: "low123",
        stopBasisLabel: `123 结构低点 3（书 L689）`,
        stopSpace: (entry - stop) / entry,
        invalidation: `跌破低点 3（${stop.toFixed(2)}）即结构破坏，按书 L707 破 3 减半、破低点 1 清仓`,
        scaleOut: "冲高分批卖出；涨停后冲高注意减仓（书 L1998 / L1521）",
        bookRef: "L689",
      };
    }
  }

  const pair = maPairing(signals);
  const pairingSeries = pair.stopMa === 10 ? ma10 : pair.stopMa === 20 ? ma20 : ma60;
  const pairingValue = pairingSeries[pairingSeries.length - 1] ?? null;
  if (pairingValue !== null) {
    const stop = toDisplayPrice(pairingValue, lastFactor);
    if (stop < entry) {
      return {
        entry,
        stop,
        stopBasis: "ma-pairing",
        stopBasisLabel: `均线配对：MA${pair.entryMa} 入场 / MA${pair.stopMa} 止损（书 L1877）`,
        stopSpace: (entry - stop) / entry,
        invalidation: `收盘跌破 MA${pair.stopMa}（${stop.toFixed(2)}）即离场`,
        scaleOut: "冲高分批卖出；涨停后冲高注意减仓（书 L1998 / L1521）",
        bookRef: "L1877",
      };
    }
  }

  // 兜底：固定比例（书 P6，候选 1%/2%/3%/5%/10%，取中位 2%）
  const stop = entry * (1 - FIXED_STOP_RATIO);
  return {
    entry,
    stop,
    stopBasis: "fixed-ratio",
    stopBasisLabel: `固定比例 ${(FIXED_STOP_RATIO * 100).toFixed(0)}%（书 L1821）`,
    stopSpace: FIXED_STOP_RATIO,
    invalidation: `跌破 ${stop.toFixed(2)}（-${(FIXED_STOP_RATIO * 100).toFixed(0)}%）即离场`,
    scaleOut: "冲高分批卖出；涨停后冲高注意减仓（书 L1998 / L1521）",
    bookRef: "L1821",
  };
}

function findResistance(ctx: RuleContext): ReferenceResistance[] {
  const { adjBars, params, bars } = ctx;
  const lastFactor = (bars[bars.length - 1] as DailyBar).adjFactor;
  const out: ReferenceResistance[] = [];

  const high = priorHigh(adjBars, params.trendlineLookback);
  if (high !== null) {
    const price = toDisplayPrice(high, lastFactor);
    out.push({
      kind: "prior-high",
      price,
      detail: `前 ${params.trendlineLookback} 根高点 ${price.toFixed(2)}（可能受阻的位置，不是涨幅预测）`,
    });
  }

  const bounds = rangeBounds(adjBars, params.rangeWindow);
  if (bounds) {
    const price = toDisplayPrice(bounds.high, lastFactor);
    // 前高与区间上沿常常就是同一个价位（都取近 60 根的最高），重复列出来只会让界面变吵
    const duplicate = out.some((item) => Math.abs(item.price - price) / price < 0.005);
    if (!duplicate) {
      out.push({
        kind: "range-high",
        price,
        detail: `近 ${params.rangeWindow} 根区间上沿 ${price.toFixed(2)}（可能受阻的位置，不是涨幅预测）`,
      });
    }
  }

  return out;
}

/**
 * 均线跟随模式的完整评估：信号 + 离场计划 + 参考压力位。
 *
 * 无信号时 `signals.bestTier` 为 null，由调用方决定是否入选——
 * 信号层不替编排层做"要不要这只票"的决定。
 */
export function evaluateTrendSignals(ctx: RuleContext): TrendSignals {
  const hits = detectSignals(ctx);
  return {
    signals: {
      signals: hits,
      bestTier: hits.length > 0 ? (hits[0] as SignalHit).tier : null,
    },
    exit: buildExitPlan(ctx, hits),
    resistance: findResistance(ctx),
  };
}

/** 事件驱动模式的信号层见后续工单；在此之前它不产出信号，如实返回空集。 */
export function evaluateEventSignals(ctx: RuleContext): TrendSignals {
  void ctx;
  return {
    signals: { signals: [], bestTier: null },
    exit: buildExitPlan(ctx, []),
    resistance: [],
  };
}

export function evaluateSignals(mode: "trend" | "event", ctx: RuleContext): TrendSignals {
  return mode === "trend" ? evaluateTrendSignals(ctx) : evaluateEventSignals(ctx);
}

/** 供事件层复用：把结构位折算到真实成交价。 */
export { toDisplayPrice };
export type { Board };

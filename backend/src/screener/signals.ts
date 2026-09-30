import type { Board } from "../market/qlib.js";
import { toDisplayPrice, type RuleContext } from "./rules.js";
import {
  atrSeries,
  detectLow123,
  detectUpwardGap,
  drawdownInWindow,
  fallingTrendlineAt,
  findDownwardGapUpper,
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

export type TrendSignalId = "S1" | "S2" | "S3" | "S5" | "S13";

/** 均线跟随模式的档序：数字越小越强。调整这里就调整了整个候选名单的顺序。 */
export const TIER_OF: Record<TrendSignalId, number> = {
  S5: 1, // 底背离双突破（三重条件复合）
  S3: 2, // 低位 123 突破高点 2
  S2: 3, // 大参数均线入场（MA60 / MA100）
  S1: 4, // MA20 上穿
  S13: 5, // 阻力突破 / 支撑回踩（最泛化）
};

export type EventSignalId = "S6" | "S7" | "S9" | "S10" | "S12";

/** 事件驱动模式的档序（书 L1545 / L1477 / L1497 / L1286 / L1330 的可靠性排序）。 */
export const EVENT_TIER_OF: Record<EventSignalId, number> = {
  S10: 1, // 涨停 + 低位 123（作者称最强）
  S12: 2, // 涨停 B 形态（作者首选）
  S9: 3, // 突破性涨停
  S6: 4, // 向上突破性缺口
  S7: 5, // 向上持续性缺口
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
  const push = (id: TrendSignalId, label: string, detail: string, bookRef: string) => {
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

/**
 * 涨停日的入场纪律。
 *
 * 书 L1537 禁止的是"在封板价买入"这个**动作**，而不是"把涨停股列为候选"；
 * 事件模式的信号本来就产生在涨停日，所以这条纪律落在离场计划里提示，而不是当作淘汰条件。
 */
function limitUpEntryNote(ctx: RuleContext): string {
  return ctx.limitUp[ctx.limitUp.length - 1] === true
    ? "当日收盘于涨停价：不要在封板价买入（书 L1537），等次日开盘或回踩确认"
    : "";
}

function buildExitPlan(ctx: RuleContext, signals: readonly SignalHit[]): ExitPlan {
  const { adjBars, ma10, ma20, ma60, params, bars } = ctx;
  const limitUpNote = limitUpEntryNote(ctx);
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
        invalidation: `跌破低点 3（${stop.toFixed(2)}）即结构破坏，按书 L707 破 3 减半、破低点 1 清仓${limitUpNote ? `；${limitUpNote}` : ""}`,
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
        invalidation: `收盘跌破 MA${pair.stopMa}（${stop.toFixed(2)}）即离场${limitUpNote ? `；${limitUpNote}` : ""}`,
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
    invalidation: `跌破 ${stop.toFixed(2)}（-${(FIXED_STOP_RATIO * 100).toFixed(0)}%）即离场${limitUpNote ? `；${limitUpNote}` : ""}`,
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

/**
 * 事件驱动模式的信号（书第五、六章：缺口与涨停）。
 *
 * 与均线跟随的区别在**触发器**：那边是持续的结构位置，这边是单日事件。
 * 两者共用同一套基础池、排除条款与离场计划。
 */
function detectEventSignals(ctx: RuleContext): SignalHit[] {
  const { adjBars, ma20, ma60, ma100, limitUp, params } = ctx;
  const last = adjBars[adjBars.length - 1];
  const prev = adjBars[adjBars.length - 2];
  if (!last || !prev) return [];

  const hits: SignalHit[] = [];
  const push = (id: EventSignalId, label: string, detail: string, bookRef: string) => {
    hits.push({ id, label, tier: EVENT_TIER_OF[id], detail, bookRef });
  };

  const closes = adjBars.map((bar) => bar.close);
  const ma100Now = ma100[ma100.length - 1] ?? null;
  const ma100Prev = ma100[ma100.length - 2] ?? null;
  const limitUpToday = limitUp[limitUp.length - 1] === true;
  const low123 = detectLow123(adjBars, {
    swingWindow: params.swingWindow,
    lookback: params.low123Lookback,
  });

  if (limitUpToday) {
    const belowMa100 = ma100Now !== null && last.close <= ma100Now;
    // 收复 MA100：前一根还在下方、当根涨停站上 —— 这正是「涨停 B 形态」的形状
    const reclaimMa100 =
      ma100Now !== null && ma100Prev !== null && last.close > ma100Now && prev.close <= ma100Prev;
    const resistance = priorHigh(adjBars, params.trendlineLookback);
    const brokePriorHigh = resistance !== null && last.close > resistance;
    const crossedMa = crossedUp(closes, ma20) || crossedUp(closes, ma60);

    if (low123?.brokenOut && belowMa100) {
      push(
        "S10",
        "涨停 + 低位 123",
        `低点3 ${low123.l3.price.toFixed(2)} → 突破高点2 ${low123.h2.price.toFixed(2)}，当日涨停且仍在 MA100 之下`,
        "L1545",
      );
    } else if (reclaimMa100) {
      const drawdown = drawdownInWindow(adjBars, params.pullbackWindow);
      const gapUpper = findDownwardGapUpper(
        adjBars,
        adjBars.length - params.pullbackWindow,
        adjBars.length - 1,
      );
      if (drawdown >= params.pullbackMinDrawdown && gapUpper !== null && last.close > gapUpper) {
        push(
          "S12",
          "涨停 B 形态",
          `前期回调 ${(drawdown * 100).toFixed(0)}%，当日涨停收复下跌缺口上沿 ${gapUpper.toFixed(2)} 并站上 MA100`,
          "L1477",
        );
      }
    }

    // S9 与 S10/S12 并列判定：突破性涨停指的是"涨停同时突破某个关键位"
    if (!hits.some((hit) => hit.id === "S10" || hit.id === "S12") && (brokePriorHigh || crossedMa)) {
      push(
        "S9",
        "突破性涨停",
        brokePriorHigh
          ? `涨停并突破前 ${params.trendlineLookback} 根高点 ${resistance?.toFixed(2) ?? "—"}`
          : "涨停并上穿均线",
        "L1497",
      );
    }
  }

  // 缺口：突破性看"有没有越过前面那段区间"，持续性看"是否已在上涨趋势途中"
  const gap = detectUpwardGap(adjBars, {
    lookback: params.trendlineLookback,
    maxAge: params.gapInvalidDays,
    atr: atrSeries(adjBars, 20),
  });
  if (gap && !gap.filled) {
    const wideEnough = gap.atrMultiple === null || gap.atrMultiple >= params.gapWidthAtr;
    // 书 L1298：错过跳空当日不得追高
    const notChased = gap.age === 0 || last.close <= gap.upper;
    if (wideEnough && notChased) {
      const width = gap.atrMultiple === null ? "ATR 不可用" : `${gap.atrMultiple.toFixed(1)}×ATR20`;
      if (gap.breakout) {
        push(
          "S6",
          "向上突破性缺口",
          `跳空 ${gap.size.toFixed(2)}（${width}）越过前 ${params.trendlineLookback} 根高点`,
          "L1286",
        );
      } else if (ma100Now !== null && last.close > ma100Now) {
        push("S7", "向上持续性缺口", `趋势途中跳空 ${gap.size.toFixed(2)}（${width}）`, "L1330");
      }
    }
  }

  return hits.sort((a, b) => a.tier - b.tier);
}

export function evaluateEventSignals(ctx: RuleContext): TrendSignals {
  const hits = detectEventSignals(ctx);
  return {
    signals: { signals: hits, bestTier: hits.length > 0 ? (hits[0] as SignalHit).tier : null },
    exit: buildExitPlan(ctx, hits),
    resistance: findResistance(ctx),
  };
}

export function evaluateSignals(mode: "trend" | "event", ctx: RuleContext): TrendSignals {
  return mode === "trend" ? evaluateTrendSignals(ctx) : evaluateEventSignals(ctx);
}

/** 供事件层复用：把结构位折算到真实成交价。 */
export { toDisplayPrice };
export type { Board };

import { smaSeries } from "./structure.js";

/**
 * 大盘择时门（书第四章 + 表 4-1）。
 *
 * 书的观点很直白：**先看大盘，再谈个股**。
 * - G1（L1091）：上证指数在 MA100 之下运行时不建议大量短线操作
 * - G2（L1071）：上证指数有 3 个月以上上涨趋势，才值得好好操作
 * - G3（L1033–1045）：创业板指在 MA100 上/下，决定能不能买创业板股票
 * - P9（L2040）：空仓时间应长于持仓时间
 *
 * 因此这里给出三档状态与**今日建议总仓位**，而不是一个布尔开关——
 * "能不能做"与"做多重"是两件事，书里也是分开说的。
 */

export type MarketGateState = "offense" | "defense" | "empty";

export type MarketGate = {
  state: MarketGateState;
  /** 指数代码（上证指数） */
  indexCode: string;
  indexClose: number | null;
  indexMa60: number | null;
  indexMa100: number | null;
  /** 三个月趋势：最新收盘相对 60 个交易日前收盘的涨跌幅（比值） */
  threeMonthReturn: number | null;
  /** 书的仓位表（表 4-1）套在指数上给出的仓位 */
  bookPosition: number;
  /** 大盘门档位对应的仓位上限 */
  gatePosition: number;
  /** 最终建议总仓位 = min(大盘门档位, 书的仓位表) */
  positionAdvice: number;
  /** 创业板指是否在 MA100 之上；缺数据为 null（此时不据此剔除） */
  growthIndexAboveMa100: boolean | null;
  /** 人话解释，直接展示给用户 */
  reason: string;
};

export type IndexSeries = {
  code: string;
  closes: number[];
};

const STATE_LABEL: Record<MarketGateState, string> = {
  offense: "进攻",
  defense: "防守",
  empty: "空仓",
};

/** 书的仓位表：站上 MA100 且站上 MA60 → 满仓；仅站上 MA100 → 半仓；跌破 MA100 → 空仓。 */
function bookPositionOf(close: number, ma60: number | null, ma100: number | null): number {
  if (ma100 === null || close <= ma100) return 0;
  if (ma60 !== null && close <= ma60) return 0.5;
  return 1;
}

export type MarketGateInput = {
  /** 上证指数日线收盘（升序） */
  shanghai: IndexSeries | null;
  /** 创业板指日线收盘（升序） */
  growth: IndexSeries | null;
  /** 三个月趋势的回看根数（交易日），书说"3 个月以上" */
  trendLookback?: number;
};

/**
 * 计算大盘门。
 *
 * 缺指数数据时返回 `state: "defense"`（而不是"空仓"）：
 * 「拿不到大盘数据」和「大盘明确走弱」是两回事，把前者当成后者会凭空挡掉所有候选。
 * 界面上会同时标注这是"数据缺失下的保守默认"。
 */
export function evaluateMarketGate(input: MarketGateInput): MarketGate {
  const lookback = input.trendLookback ?? 60;
  const sh = input.shanghai;

  if (!sh || sh.closes.length < 100) {
    return {
      state: "defense",
      indexCode: sh?.code ?? "sh000001",
      indexClose: null,
      indexMa60: null,
      indexMa100: null,
      threeMonthReturn: null,
      bookPosition: 0.5,
      gatePosition: 0.5,
      positionAdvice: 0.5,
      growthIndexAboveMa100: null,
      reason: "缺少指数日线数据，先按「防守」保守处理（这不是对大盘走弱的判断）",
    };
  }

  const closes = sh.closes;
  const last = closes[closes.length - 1] as number;
  const ma60 = smaSeries(closes, 60).at(-1) ?? null;
  const ma100 = smaSeries(closes, 100).at(-1) ?? null;
  const past = closes.length > lookback ? (closes[closes.length - 1 - lookback] as number) : null;
  const threeMonthReturn = past !== null && past > 0 ? last / past - 1 : null;

  const aboveMa100 = ma100 !== null && last > ma100;
  const trendUp = threeMonthReturn !== null && threeMonthReturn > 0;

  const state: MarketGateState = !aboveMa100 ? "empty" : trendUp ? "offense" : "defense";
  const gatePosition = state === "offense" ? 1 : state === "defense" ? 0.5 : 0;
  const bookPosition = bookPositionOf(last, ma60, ma100);
  const positionAdvice = Math.min(gatePosition, bookPosition);

  const detail =
    state === "empty"
      ? `上证指数 ${last.toFixed(2)} 跌破 MA100 ${ma100?.toFixed(2) ?? "—"}`
      : state === "offense"
        ? `上证指数 ${last.toFixed(2)} 站上 MA100 ${ma100?.toFixed(2) ?? "—"}，三个月${threeMonthReturn === null ? "趋势不明" : `上涨 ${(threeMonthReturn * 100).toFixed(1)}%`}`
        : `上证指数 ${last.toFixed(2)} 站上 MA100 ${ma100?.toFixed(2) ?? "—"}，但三个月趋势不成立`;

  // 创业板指只影响创业板个股，缺数据时不据此剔除（不拿"没数据"当"不合格"）
  const growthCloses = input.growth?.closes ?? null;
  const growthMa100 =
    growthCloses && growthCloses.length >= 100 ? (smaSeries(growthCloses, 100).at(-1) ?? null) : null;
  const growthIndexAboveMa100 =
    growthCloses && growthMa100 !== null
      ? (growthCloses[growthCloses.length - 1] as number) > growthMa100
      : null;

  const growthNote =
    growthIndexAboveMa100 === null
      ? "（创业板指数据缺失，未据此剔除创业板股）"
      : growthIndexAboveMa100
        ? ""
        : "；创业板指在 MA100 之下，创业板个股本轮不参与";

  return {
    state,
    indexCode: sh.code,
    indexClose: last,
    indexMa60: ma60,
    indexMa100: ma100,
    threeMonthReturn,
    bookPosition,
    gatePosition,
    positionAdvice,
    growthIndexAboveMa100,
    reason: `【${STATE_LABEL[state]}档】${detail}${growthNote}`,
  };
}

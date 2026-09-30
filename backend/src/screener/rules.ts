import { adjustedPrice, countCrossings, fallingTrendlineAt, findSwingHighs, isOneWordBoard, limitUpFlags, limitUpPrice, macdDifSeries, rangeBounds, smaSeries } from "./structure.js";
import type { ScreenerParams } from "./params.js";
import type { DailyBar, RuleHit, RuleOutcome, RuleSource, ScreenerCriteria, SecurityInput, FunnelStage } from "./types.js";

/**
 * 规则定义：声明式、逐条可溯源。
 *
 * 分层（与漏斗分档一一对应）：
 * - `exclusions` 硬性排除——ST / 退市 / 停牌 / 一字板 / 板块开关。**与书的观点无关**，
 *   全部是可交易性的工程约束，所以标 `offbook`。
 * - `hardFilters` 数据充分性与"不追高"纪律——K 线根数、禁止打板、涨停后第 2–3 日不追高。
 * - `shortlist` 基础池——书的核心选股条件（站上 MA100）以及市值/流动性/结构位置闸门。
 *
 * 每条规则返回阈值与实测值的对照文本，界面直接展示，用户才能验证"它为什么被选中"。
 */

export type RuleContext = {
  security: SecurityInput;
  params: ScreenerParams;
  criteria: ScreenerCriteria;
  /** 不复权序列（事件与显示口径） */
  bars: DailyBar[];
  /** 后复权序列（均线、结构等需要跨除权连续的量） */
  adjBars: DailyBar[];
  /** 后复权均线序列，均与 adjBars 同长度对齐（对齐是刻意的：差一位会让信号静默判错） */
  ma10: Array<number | null>;
  ma20: Array<number | null>;
  ma60: Array<number | null>;
  ma100: Array<number | null>;
  /** 后复权 MACD 快线 DIF 序列，与 adjBars 对齐（底背离要用它） */
  dif: number[];
  /** 逐根涨停标记 */
  limitUp: boolean[];
};

/** 后复权价 → 真实成交价：除以最新一根的因子。结构位、止损位都要落到这个口径上。 */
export function toDisplayPrice(adjPrice: number, lastAdjFactor: number): number {
  return lastAdjFactor === 0 ? adjPrice : adjPrice / lastAdjFactor;
}

/** 从最后一根往前找最近一次「上穿 MA100」距今多少根；从未上穿则为 null。 */
export function barsSinceMa100Cross(
  adjCloses: readonly number[],
  ma100: ReadonlyArray<number | null>,
): number | null {
  for (let i = adjCloses.length - 1; i >= 1; i--) {
    const cur = ma100[i];
    const prev = ma100[i - 1];
    if (cur === null || cur === undefined || prev === null || prev === undefined) continue;
    if ((adjCloses[i] as number) > cur && (adjCloses[i - 1] as number) <= prev) {
      return adjCloses.length - 1 - i;
    }
  }
  return null;
}

export type Rule = {
  id: string;
  label: string;
  stage: FunnelStage;
  source: RuleSource;
  bookRef?: string;
  evaluate: (ctx: RuleContext) => RuleOutcome;
};

const ok = (detail: string): RuleOutcome => ({ ok: true, detail });
const fail = (detail: string): RuleOutcome => ({ ok: false, detail });
/** 数据缺失：不淘汰，但必须在结果里显式暴露（沉默地"通过"会让筛选器悄悄失效）。 */
const unknown = (detail: string): RuleOutcome => ({ ok: true, detail, unknown: true });

const num = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : value.toFixed(digits);

const pct = (value: number | null | undefined, digits = 2): string =>
  value === null || value === undefined || !Number.isFinite(value) ? "—" : `${(value * 100).toFixed(digits)}%`;

const yi = (yuan: number | null | undefined): string =>
  yuan === null || yuan === undefined ? "—" : `${(yuan / 1e8).toFixed(2)}亿`;

const wan = (yuan: number | null | undefined): string =>
  yuan === null || yuan === undefined ? "—" : `${(yuan / 1e4).toFixed(0)}万`;

export const RULES: readonly Rule[] = [
  /* ----------------------------- 硬性排除层 ----------------------------- */
  {
    id: "E-live",
    label: "剔除已退市 / 长期停牌",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ security }) =>
      security.isLive
        ? ok("数据截止于最新交易日")
        : fail("数据截止日早于最新交易日，已不在交易"),
  },
  {
    id: "E-st",
    label: "剔除 ST / 退市整理",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ security }) => {
      const name = security.name;
      if (!name) return unknown("名称为空（待行情快照回填），未判定");
      if (/ST/i.test(name) || name.includes("退")) return fail(`名称「${name}」命中 ST / 退市`);
      return ok(`名称「${name}」未命中`);
    },
  },
  {
    id: "E-suspended",
    label: "剔除停牌",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ bars }) => {
      const last = bars[bars.length - 1];
      if (!last) return fail("无日线数据");
      return last.volume > 0 ? ok(`成交量 ${wan(last.volume)}手`) : fail("最新交易日无成交量");
    },
  },
  {
    id: "E-suspended-today",
    label: "剔除当日停牌（最后一根不在最新交易日）",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ security, bars }) => {
      if (security.tradedOnLatestDay) return ok("最新交易日有成交");
      const last = bars[bars.length - 1];
      return fail(`最新交易日无日线，最近一根为 ${last?.date ?? "无"}`);
    },
  },
  {
    id: "E-oneword",
    label: "剔除一字板",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ bars }) => {
      const last = bars[bars.length - 1];
      if (!last) return fail("无日线数据");
      return isOneWordBoard(last)
        ? fail(`最高=最低=${num(last.high)}，全天一个价位、实际买不到`)
        : ok(`日内振幅 ${num(((last.high - last.low) / last.close) * 100)}%`);
    },
  },
  {
    id: "E-board",
    label: "板块开关（默认剔除北交所）",
    stage: "exclusions",
    source: "offbook",
    evaluate: ({ security, criteria }) =>
      security.board === "bj" && !criteria.includeBeijing
        ? fail("北交所 30% 涨跌幅 + 流动性薄，默认排除")
        : ok(`板块 ${security.board}`),
  },

  /* ------------------------ 数据充分性 / 不追高 ------------------------ */
  {
    id: "H-bars",
    label: "日 K 根数下限",
    stage: "hardFilters",
    source: "book",
    bookRef: "L2386",
    evaluate: ({ bars, params }) =>
      bars.length >= params.minListedBars
        ? ok(`${bars.length} 根 ≥ ${params.minListedBars}`)
        : fail(`${bars.length} 根 < ${params.minListedBars}（MA144 需 144 根 + 缓冲）`),
  },
  {
    id: "H-noChaseLimitUp",
    label: "禁止打板（不在涨停价买入）",
    stage: "hardFilters",
    source: "book",
    bookRef: "L1537",
    evaluate: ({ bars, security }) => {
      if (bars.length < 2) return unknown("不足 2 根日线，无法计算涨停价");
      const last = bars[bars.length - 1] as DailyBar;
      const prev = bars[bars.length - 2] as DailyBar;
      const target = limitUpPrice(prev.close, security.board);
      return last.close >= target - 1e-6
        ? fail(`收盘 ${num(last.close)} 已达涨停价 ${num(target)}，封板价买不到`)
        : ok(`收盘 ${num(last.close)} < 涨停价 ${num(target)}`);
    },
  },
  {
    id: "H-noLimitUpYesterday",
    label: "涨停后第 2–3 日不追高",
    stage: "hardFilters",
    source: "book",
    bookRef: "L1499",
    evaluate: ({ bars, limitUp }) => {
      const n = bars.length;
      const twoAgo = n >= 3 ? limitUp[n - 3] : false;
      const threeAgo = n >= 4 ? limitUp[n - 4] : false;
      // 「第 2–3 日」= 涨停发生在距今 2 或 3 个交易日
      return twoAgo || threeAgo
        ? fail("距今 2–3 个交易日出现过涨停，处于追高窗口")
        : ok("未处于涨停后第 2–3 日");
    },
  },

  /* ------------------------------ 基础池 ------------------------------ */
  {
    id: "U-ma100",
    label: "站上 MA100（书的核心选股条件）",
    stage: "shortlist",
    source: "book",
    bookRef: "L597",
    evaluate: ({ adjBars, ma100 }) => {
      const lastIndex = adjBars.length - 1;
      const ma = ma100[lastIndex];
      const close = adjBars[lastIndex]?.close;
      if (ma === null || ma === undefined || close === undefined) {
        return fail("样本不足，无法计算 MA100");
      }
      const deviation = (close - ma) / ma;
      return close > ma
        ? ok(`后复权收盘 ${num(close)} > MA100 ${num(ma)}（偏离 ${pct(deviation)}）`)
        : fail(`后复权收盘 ${num(close)} ≤ MA100 ${num(ma)}（偏离 ${pct(deviation)}）`);
    },
  },
  {
    id: "U-marketCap",
    label: "流通市值区间",
    stage: "shortlist",
    source: "inferred",
    bookRef: "L1686",
    evaluate: ({ security, params }) => {
      const cap = security.floatMarketCap;
      if (cap === null || cap === undefined) {
        return unknown(
          `流通市值未知（待行情快照），闸门 ${yi(params.floatMarketCapMin)}–${yi(params.floatMarketCapMax)} 未生效`,
        );
      }
      return cap >= params.floatMarketCapMin && cap <= params.floatMarketCapMax
        ? ok(`${yi(cap)} 落在 ${yi(params.floatMarketCapMin)}–${yi(params.floatMarketCapMax)}`)
        : fail(`${yi(cap)} 超出 ${yi(params.floatMarketCapMin)}–${yi(params.floatMarketCapMax)}`);
    },
  },
  {
    id: "U-turnover",
    label: "成交额下限（可买性）",
    stage: "shortlist",
    source: "offbook",
    evaluate: ({ bars, params }) => {
      const last = bars[bars.length - 1];
      if (!last) return fail("无日线数据");
      return last.amount >= params.minTurnoverAmount
        ? ok(`${wan(last.amount)} ≥ ${wan(params.minTurnoverAmount)}`)
        : fail(`${wan(last.amount)} < ${wan(params.minTurnoverAmount)}`);
    },
  },
  {
    id: "X-ma100Whipsaw",
    label: "剔除穿梭 MA100 的震荡",
    stage: "shortlist",
    source: "book",
    bookRef: "L663",
    evaluate: ({ adjBars, ma100, params }) => {
      const closes = adjBars.map((bar) => bar.close);
      const crossings = countCrossings(closes, ma100, 20);
      return crossings < params.ma100CrossMax
        ? ok(`近 20 日穿越 MA100 ${crossings} 次 < ${params.ma100CrossMax}`)
        : fail(`近 20 日穿越 MA100 ${crossings} 次 ≥ ${params.ma100CrossMax}，属震荡`);
    },
  },
  {
    id: "U-aboveTrendline",
    label: "不买在下降趋势线之下",
    stage: "shortlist",
    source: "book",
    bookRef: "L585",
    evaluate: ({ adjBars, params }) => {
      const line = fallingTrendlineAt(adjBars, params.swingWindow, params.trendlineLookback);
      const close = adjBars[adjBars.length - 1]?.close;
      if (line === null || close === undefined) return ok("近期未构成下降趋势线");
      return close >= line
        ? ok(`收盘 ${num(close)} ≥ 下降趋势线 ${num(line)}`)
        : fail(`收盘 ${num(close)} < 下降趋势线 ${num(line)}`);
    },
  },
  {
    id: "U-notRange",
    label: "剔除震荡区间内部",
    stage: "shortlist",
    source: "book",
    bookRef: "L627",
    evaluate: ({ adjBars, params }) => {
      const bounds = rangeBounds(adjBars, params.rangeWindow);
      const close = adjBars[adjBars.length - 1]?.close;
      if (!bounds || close === undefined) return ok("样本不足，未判定区间");
      const inside = close > bounds.low && close < bounds.high;
      const tight = bounds.width <= params.rangeWidthMax;
      const oscillating = bounds.progress <= params.rangeProgressMax;
      if (inside && tight && oscillating) {
        return fail(
          `收盘落在 ${num(bounds.low)}–${num(bounds.high)} 区间内、带宽 ${pct(bounds.width)} ≤ ${pct(params.rangeWidthMax)}，` +
            `且净位移仅占带宽 ${pct(bounds.progress)}（来回震荡）`,
        );
      }
      if (!inside) {
        return ok(`已突破区间（收盘 ${num(close)} vs 区间 ${num(bounds.low)}–${num(bounds.high)}）`);
      }
      return ok(
        tight
          ? `价格在窄区间内但在推进（净位移占带宽 ${pct(bounds.progress)} > ${pct(params.rangeProgressMax)}，属回调而非震荡）`
          : `价格在区间内但带宽 ${pct(bounds.width)} > ${pct(params.rangeWidthMax)}（属回调而非震荡）`,
      );
    },
  },
];

/** 构建规则上下文：把需要预先算好的序列一次算完，避免每条规则各算一遍。 */
export function buildContext(
  security: SecurityInput,
  params: ScreenerParams,
  criteria: ScreenerCriteria,
): RuleContext {
  const bars = security.bars;
  // 后复权序列：跨除权保持连续，均线/结构一律在它上面算
  const adjBars: DailyBar[] = bars.map((bar) => ({
    date: bar.date,
    open: adjustedPrice(bar.open, bar.adjFactor),
    high: adjustedPrice(bar.high, bar.adjFactor),
    low: adjustedPrice(bar.low, bar.adjFactor),
    close: adjustedPrice(bar.close, bar.adjFactor),
    volume: bar.volume,
    amount: bar.amount,
    adjFactor: bar.adjFactor,
  }));

  const adjCloses = adjBars.map((bar) => bar.close);
  return {
    security,
    params,
    criteria,
    bars,
    adjBars,
    ma10: smaSeries(adjCloses, 10),
    ma20: smaSeries(adjCloses, 20),
    ma60: smaSeries(adjCloses, 60),
    ma100: smaSeries(adjCloses, 100),
    dif: macdDifSeries(adjCloses),
    limitUp: limitUpFlags(bars, security.board),
  };
}

/** 评估单只标的：按层依次判定，首次不通过即淘汰（但仍然保留已判定的命中记录）。 */
export function evaluateRules(ctx: RuleContext): {
  passed: boolean;
  rejectedBy: RuleHit | null;
  hits: RuleHit[];
  unknownRules: string[];
} {
  const hits: RuleHit[] = [];
  const unknownRules: string[] = [];
  let rejectedBy: RuleHit | null = null;

  for (const stage of ["exclusions", "hardFilters", "shortlist"] as FunnelStage[]) {
    for (const rule of RULES) {
      if (rule.stage !== stage) continue;
      const outcome = rule.evaluate(ctx);
      const hit: RuleHit = {
        id: rule.id,
        label: rule.label,
        source: rule.source,
        stage: rule.stage,
        ...(rule.bookRef ? { bookRef: rule.bookRef } : {}),
        outcome,
      };
      hits.push(hit);
      if (outcome.unknown) unknownRules.push(rule.id);
      if (!outcome.ok) {
        rejectedBy = hit;
        return { passed: false, rejectedBy, hits, unknownRules };
      }
    }
  }
  return { passed: true, rejectedBy, hits, unknownRules };
}

/** 供后续票使用的结构原语再导出，避免调用方从两个模块各引一次。 */
export { findSwingHighs };

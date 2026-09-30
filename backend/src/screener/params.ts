import type { ScreenerCriteria, Strictness } from "./types.js";

/**
 * 筛选器参数表 —— 「我们对这本书的最终解读」集中在这里，不散落在代码常量里。
 *
 * 每一行的来源分三类，结果界面据此标注，用户才能区分"书挑的"与"我们加的"：
 * - `book`     源书明确写出（带行号）
 * - `inferred` 源书只给定性描述，阈值由我们推断（下游需回测校准）
 * - `offbook`  源书没有、由本项目补的安全或工程约束
 *
 * 源书只给均线参数与结构位置，**不给任何量价阈值**（作者原话「根本就不研究成交量」），
 * 所以这里看不到量比 / 换手率之类的常见短线阈值——那不是遗漏，是这本书的实际内容。
 */

export type ParamProvenance = {
  source: "book" | "inferred" | "offbook";
  /** 书内定位或推断依据 */
  ref?: string;
  note: string;
};

export type ScreenerParams = {
  /** 流通市值下限（元）：安全补丁，剔除易被操纵的微盘 */
  floatMarketCapMin: number;
  /** 流通市值上限（元） */
  floatMarketCapMax: number;
  /** 当日成交额下限（元）：可买性 */
  minTurnoverAmount: number;
  /** 最少日 K 根数（MA144 需 144 根 + 缓冲） */
  minListedBars: number;
  /** U3「刚突破 MA100」的窗口（交易日） */
  ma100BreakoutWindow: number;
  /** X2 穿梭 MA100 的排除阈值：窗口内穿越次数达到即排除 */
  ma100CrossMax: number;
  /** 显著高低点的左右窗口（根） */
  swingWindow: number;
  /** 下降趋势线的回溯根数 */
  trendlineLookback: number;
  /** 震荡区间的回溯根数 */
  rangeWindow: number;
  /** 震荡区间的宽度上限（占收盘价比例）：超过则视为有趋势、不算震荡 */
  rangeWidthMax: number;
  /** 震荡的净位移上限（净位移 / 带宽）：超过则视为在推进、不算来回震荡 */
  rangeProgressMax: number;
  /** X5 连板后回调再涨停的排除阈值：窗口内涨停次数达到即排除 */
  limitUpStreakMax: number;
  /** X5 的统计窗口（交易日） */
  limitUpStreakWindow: number;
  /** 123 结构回溯窗口（交易日） */
  low123Lookback: number;
  /** 向上突破性缺口的宽度门槛（× ATR20） */
  gapWidthAtr: number;
  /** 缺口失效窗口：若干日内回补即撤销信号 */
  gapInvalidDays: number;
  /** 止损空间上限（占入场价比例） */
  stopSpaceMax: number;
  /** 走势流畅度要求（20 日对数价格回归 R²）；null 表示不要求 */
  trendR2Min: number | null;
};

const ALL_TIERS: Record<Strictness, ScreenerParams> = {
  loose: {
    floatMarketCapMin: 20e8,
    floatMarketCapMax: 150e8,
    minTurnoverAmount: 3_000e4,
    minListedBars: 150,
    ma100BreakoutWindow: 20,
    ma100CrossMax: 6,
    swingWindow: 5,
    trendlineLookback: 60,
    rangeWindow: 60,
    rangeWidthMax: 0.25,
    rangeProgressMax: 0.5,
    limitUpStreakMax: 5,
    limitUpStreakWindow: 20,
    low123Lookback: 120,
    gapWidthAtr: 0.5,
    gapInvalidDays: 3,
    stopSpaceMax: 0.1,
    trendR2Min: null,
  },
  standard: {
    floatMarketCapMin: 20e8,
    floatMarketCapMax: 80e8,
    minTurnoverAmount: 5_000e4,
    minListedBars: 150,
    ma100BreakoutWindow: 10,
    ma100CrossMax: 4,
    swingWindow: 5,
    trendlineLookback: 60,
    rangeWindow: 60,
    rangeWidthMax: 0.2,
    rangeProgressMax: 0.5,
    limitUpStreakMax: 3,
    limitUpStreakWindow: 20,
    low123Lookback: 60,
    gapWidthAtr: 1.0,
    gapInvalidDays: 3,
    stopSpaceMax: 0.08,
    trendR2Min: null,
  },
  strict: {
    floatMarketCapMin: 20e8,
    floatMarketCapMax: 50e8,
    minTurnoverAmount: 10_000e4,
    minListedBars: 250,
    ma100BreakoutWindow: 5,
    ma100CrossMax: 3,
    swingWindow: 5,
    trendlineLookback: 60,
    rangeWindow: 60,
    rangeWidthMax: 0.15,
    rangeProgressMax: 0.5,
    limitUpStreakMax: 2,
    limitUpStreakWindow: 20,
    low123Lookback: 30,
    gapWidthAtr: 1.5,
    gapInvalidDays: 3,
    stopSpaceMax: 0.05,
    trendR2Min: 0.7,
  },
};

export function paramsFor(strictness: Strictness): ScreenerParams {
  return ALL_TIERS[strictness];
}

export const DEFAULT_CRITERIA: ScreenerCriteria = {
  mode: "trend",
  strictness: "standard",
  includeBeijing: false,
  ignoreMarketGate: false,
};

/**
 * 参数来源表。界面用它给每条规则标注 `书 L####` / `推断` / `书外`，
 * 因此新增参数时必须同时在这里登记——否则规则会变成无法溯源的魔法数字。
 */
export const PARAM_PROVENANCE: Record<keyof ScreenerParams, ParamProvenance> = {
  floatMarketCapMin: {
    source: "offbook",
    note: "安全补丁：剔除易被操纵的微盘。源书只在小盘优先的排序语境里提过市值",
  },
  floatMarketCapMax: {
    source: "inferred",
    ref: "L1686",
    note: "书中龙头案例剔除 51 亿、保留 17/23 亿；三档阶梯由我们构造",
  },
  minTurnoverAmount: {
    source: "offbook",
    note: "可买性约束，源书完全没有成交额阈值",
  },
  minListedBars: {
    source: "book",
    ref: "L2386",
    note: "MA144 需 144 根 + 缓冲；作者把均线作为唯一核心指标",
  },
  ma100BreakoutWindow: {
    source: "inferred",
    ref: "L545",
    note: "书说「刚刚突破 MA100」，未定义多久算「刚刚」",
  },
  ma100CrossMax: {
    source: "inferred",
    ref: "L663",
    note: "书说「穿梭 MA100 的震荡不宜操作」，次数阈值由我们定",
  },
  swingWindow: {
    source: "inferred",
    ref: "L868",
    note: "书中只画图说明显著高低点，无算法参数",
  },
  trendlineLookback: {
    source: "inferred",
    ref: "L585",
    note: "书只给画法（高点与次高点相连并延长），回溯长度未定义",
  },
  rangeWindow: {
    source: "inferred",
    note: "书只定性地把震荡区间描述为「新低又新高后形成的一块区域」",
  },
  rangeWidthMax: {
    source: "inferred",
    ref: "L627",
    note: "书说「震荡走势中尽量减少操作」，但没给「多窄才算震荡」；不设宽度阈值会误杀上涨途中的回调",
  },
  rangeProgressMax: {
    source: "inferred",
    ref: "L627",
    note: "只看带宽会把稳步上涨的票误判成震荡（涨得慢 ⇒ 带宽自然窄）；用净位移不及带宽一半来区分来回震荡",
  },
  limitUpStreakMax: {
    source: "inferred",
    ref: "L1724",
    note: "书以「六连板」案例说明连板后回调再涨停要剔除，次数阈值由我们定",
  },
  limitUpStreakWindow: {
    source: "inferred",
    ref: "L1724",
    note: "统计窗口由我们定",
  },
  low123Lookback: {
    source: "inferred",
    ref: "L681",
    note: "书中案例跨度 1.5–6 个月，回溯窗口由我们定",
  },
  gapWidthAtr: {
    source: "inferred",
    ref: "L1296",
    note: "书只说「很大的向上跳空」，未给量化门槛",
  },
  gapInvalidDays: {
    source: "inferred",
    ref: "L1316",
    note: "书说「短期内回补」，具体天数由我们定",
  },
  stopSpaceMax: {
    source: "inferred",
    ref: "L1767",
    note: "书说止损空间过大不宜入市，比例上限由我们定",
  },
  trendR2Min: {
    source: "inferred",
    ref: "L408",
    note: "书用「走势流畅 / 凌厉」描述，R² 门槛由我们定；仅严格档要求",
  },
};

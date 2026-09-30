import type { Board } from "../market/qlib.js";

/**
 * 筛选器的领域类型。
 *
 * 价格口径（关键）：`DailyBar` 里的 OHLC 是**不复权**的真实成交价——
 * 涨停判定、缺口、结构位、止损位都必须在这一口径上算，因为它们都是"交易所价格空间"里的概念。
 * 均线这类需要跨除权保持连续的量，则用 `adjustedCloses()` 换成后复权序列再算。
 * 两个口径混用是这类系统最隐蔽的错误来源。
 */

export type DailyBar = {
  /** `YYYYMMDD` */
  date: number;
  open: number;
  high: number;
  low: number;
  /** 不复权收盘（真实成交价） */
  close: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number;
  /** 复权因子：后复权价 = 不复权价 × adjFactor */
  adjFactor: number;
};

export type SecurityInput = {
  code: string;
  /** 名称；bootstrap 阶段为空，由行情增量回填 */
  name: string | null;
  board: Board;
  /** 截止日等于库内最新交易日 → 仍在交易 */
  isLive: boolean;
  /** 流通市值（元）；来自行情快照，缺失时为 null */
  floatMarketCap: number | null;
  /** **不复权**日线序列，按日期升序 */
  bars: DailyBar[];
};

export type Strictness = "loose" | "standard" | "strict";

/** 两种模式：均线跟随 / 事件驱动（缺口与涨停） */
export type ScreenerMode = "trend" | "event";

export type ScreenerCriteria = {
  mode: ScreenerMode;
  strictness: Strictness;
  /** 是否纳入北交所（默认排除：30% 涨跌幅 + 流动性薄） */
  includeBeijing: boolean;
};

/** 规则来源：书内明确 / 书内但阈值为推断 / 项目自加的补丁 */
export type RuleSource = "book" | "inferred" | "offbook";

export type RuleOutcome = {
  /** 通过为 true；未通过即淘汰 */
  ok: boolean;
  /** 阈值与实测值的对照，供界面直接展示（"规则名 + 阈值 + 实际值"三件套） */
  detail: string;
  /** 数据缺失导致无法判定时为 true：此时按"不淘汰"处理，但必须显式暴露 */
  unknown?: boolean;
};

export type RuleHit = {
  id: string;
  label: string;
  source: RuleSource;
  /** 所属层：决定它落在漏斗的哪一档 */
  stage: FunnelStage;
  /** 书内定位，如 `L597` */
  bookRef?: string;
  outcome: RuleOutcome;
};

/** 淘汰发生在哪一层，用于漏斗分档 */
export type FunnelStage = "exclusions" | "hardFilters" | "shortlist";

/** 候选的量化画像：信号层排序与界面展示都用它（不参与淘汰判定）。 */
export type ScreenMetrics = {
  /** 最新**不复权**收盘（用户认得的真实成交价） */
  lastClose: number | null;
  /** 涨跌幅（%）。库内没有官方字段，由相邻两根不复权收盘算出 */
  changePercent: number | null;
  /** 后复权 MA100 */
  ma100: number | null;
  /** 后复权收盘相对 MA100 的偏离（比值，非百分比） */
  ma100Deviation: number | null;
  /** 最近一次上穿 MA100 距今多少根；从未上穿为 null */
  barsSinceMa100Cross: number | null;
  /** 20 日对数价格回归 R²（走势流畅度） */
  trendR2: number | null;
  /** 流通市值（元），缺数据为 null */
  floatMarketCap: number | null;
  /** 最新交易日成交额（元） */
  turnoverAmount: number | null;
};

export type ScreenVerdict = {
  code: string;
  passed: boolean;
  /** 未通过时：第一个淘汰它的规则 */
  rejectedBy: { id: string; label: string; stage: FunnelStage; detail: string } | null;
  /** 全部命中记录（含通过项），供候选明细展示 */
  hits: RuleHit[];
  /** 因数据缺失而未能判定的规则 id */
  unknownRules: string[];
  metrics: ScreenMetrics;
};

export type FunnelCounts = {
  /** 输入总数 */
  universe: number;
  /** 通过硬性排除层（退市 / ST / 停牌 / 一字板 / 板块） */
  afterExclusions: number;
  /** 通过数据充分性与可买性门槛（K 线根数 / 禁止打板 / 涨停后不追高） */
  afterHardFilters: number;
  /** 通过基础池（MA100 位置、市值与流动性、非下跌趋势线之下、非震荡区间） */
  shortlisted: number;
};

export type ScreenOutcome = {
  criteria: ScreenerCriteria;
  funnel: FunnelCounts;
  /** 通过基础池的标的，保持输入顺序（排序属于信号层） */
  shortlisted: ScreenVerdict[];
  /** 因数据缺失而未生效的规则 id 汇总（例如未接快照时的流通市值闸门） */
  inactiveRules: string[];
};

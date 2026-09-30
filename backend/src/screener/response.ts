import { fromDateKey } from "../market/qlib.js";
import type { Board } from "../market/qlib.js";
import type {
  FunnelCounts,
  RuleSource,
  ScreenOutcome,
  ScreenVerdict,
  ScreenerMode,
  Strictness,
} from "./types.js";

/**
 * 引擎输出 → HTTP 契约的映射。
 *
 * 单独成模块的原因：排序与截断是**契约决策**而不是引擎决策——
 * 引擎必须遍历全市场才能给出准确的漏斗，但它没有理由把几千条候选和每条十几项
 * 规则明细都塞进响应体。这里负责挑出前 N 条，并把规则明细压成界面要的形状。
 */

export type ScreenRuleHit = {
  id: string;
  label: string;
  source: RuleSource;
  /** 书内定位，如 `L597` */
  bookRef?: string;
  /** 阈值与实测值的对照（界面直接展示，用户据此验证"为什么是它"） */
  detail: string;
  /** 因缺数据而未判定 */
  unknown: boolean;
};

export type ScreenCandidate = {
  code: string;
  /** bootstrap 不提供名称，待行情快照回填 */
  name: string | null;
  /** 最新不复权收盘 */
  price: number | null;
  /** 涨跌幅（%）：库内无官方字段，由相邻两根不复权收盘算出 */
  changePercent: number | null;
  metrics: ScreenVerdict["metrics"];
  ruleHits: ScreenRuleHit[];
  /** 扣分项：当前为"因缺数据未判定"的说明 */
  deductions: string[];
};

export type ScreenRequestParams = {
  mode: ScreenerMode;
  strictness: Strictness;
  boards: Board[];
  /** 覆盖大盘门的逃生开关；实际生效见大盘门工单 */
  ignoreMarketGate: boolean;
  /** 绕过当日缓存强制重算；实际生效见缓存工单 */
  refresh: boolean;
};

export type ScreenResponse = {
  status: "ok";
  /** 库内最新交易日（`YYYY-MM-DD`） */
  dataDate: string;
  /** 本次响应的生成时间 */
  refreshedAt: string;
  params: ScreenRequestParams;
  funnel: FunnelCounts;
  /** 通过基础池的总数；`candidates` 是它的前 `limit` 个 */
  candidateTotal: number;
  candidates: ScreenCandidate[];
  /** 当前并未真正生效的规则（对所有标的都无法判定，例如缺快照时的市值闸门） */
  inactiveRules: string[];
  /** 降级标记：`true` 表示本次结果**未经**大模型复核（复核接入前恒为 true） */
  degraded: { llmReview: boolean; reason: string | null };
};

const NULL_LAST = Number.MAX_SAFE_INTEGER;

/**
 * 信号层接入前的排序：先按"刚突破 MA100"的时点（书 L545：面临趋势拐点），
 * 再按走势流畅度、流通市值、成交额——都是书里的次级因子。
 * 止损空间这一项要等离场计划（见后续工单），届时插到最前面。
 */
export function rankShortlist(shortlist: readonly ScreenVerdict[]): ScreenVerdict[] {
  return [...shortlist].sort((a, b) => {
    const sinceA = a.metrics.barsSinceMa100Cross ?? NULL_LAST;
    const sinceB = b.metrics.barsSinceMa100Cross ?? NULL_LAST;
    if (sinceA !== sinceB) return sinceA - sinceB;

    const r2A = a.metrics.trendR2 ?? -1;
    const r2B = b.metrics.trendR2 ?? -1;
    if (r2A !== r2B) return r2B - r2A;

    const capA = a.metrics.floatMarketCap ?? NULL_LAST;
    const capB = b.metrics.floatMarketCap ?? NULL_LAST;
    if (capA !== capB) return capA - capB;

    return (b.metrics.turnoverAmount ?? 0) - (a.metrics.turnoverAmount ?? 0);
  });
}

/**
 * 价格为「因子缩放值 ÷ 因子」的浮点结果，尾数会带出噪声（实测形如 27.13000005081679）。
 * A 股报价只到分，响应层统一收口到两位——否则界面会显示一串无意义的尾数。
 */
function round2(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 100) / 100;
}

function toCandidate(
  verdict: ScreenVerdict,
  nameOf: ((code: string) => string | null) | undefined,
): ScreenCandidate {
  return {
    code: verdict.code,
    name: nameOf?.(verdict.code) ?? null,
    price: round2(verdict.metrics.lastClose),
    changePercent: round2(verdict.metrics.changePercent),
    metrics: {
      ...verdict.metrics,
      lastClose: round2(verdict.metrics.lastClose),
      changePercent: round2(verdict.metrics.changePercent),
    },
    ruleHits: verdict.hits.map((hit) => ({
      id: hit.id,
      label: hit.label,
      source: hit.source,
      ...(hit.bookRef ? { bookRef: hit.bookRef } : {}),
      detail: hit.outcome.detail,
      unknown: hit.outcome.unknown === true,
    })),
    deductions: verdict.hits
      .filter((hit) => hit.outcome.unknown === true)
      .map((hit) => `${hit.label}：${hit.outcome.detail}`),
  };
}

export function toScreenResponse(
  outcome: ScreenOutcome,
  options: {
    dataDateKey: number;
    refreshedAt: Date;
    params: ScreenRequestParams;
    limit: number;
    /** 代码 → 名称（bootstrap 阶段为空） */
    nameOf?: (code: string) => string | null;
  },
): ScreenResponse {
  const ranked = rankShortlist(outcome.shortlisted);
  const candidates = ranked
    .slice(0, options.limit)
    .map((verdict) => toCandidate(verdict, options.nameOf));

  return {
    status: "ok",
    dataDate: fromDateKey(options.dataDateKey),
    refreshedAt: options.refreshedAt.toISOString(),
    params: options.params,
    funnel: outcome.funnel,
    candidateTotal: outcome.shortlisted.length,
    candidates,
    inactiveRules: outcome.inactiveRules,
    // 大模型复核尚未接入：显式标为"未经 AI 复核"，而不是让界面以为已经复核过
    degraded: { llmReview: true, reason: "大模型复核尚未接入，当前结果全部来自确定性规则" },
  };
}

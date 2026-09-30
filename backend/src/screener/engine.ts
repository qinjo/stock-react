import { DEFAULT_CRITERIA, paramsFor } from "./params.js";
import { RULES, barsSinceMa100Cross, buildContext, evaluateRules } from "./rules.js";
import { trendR2 } from "./structure.js";
import { evaluateSignals } from "./signals.js";
import type {
  FunnelCounts,
  MarketGateLike,
  ScreenMetrics,
  ScreenOutcome,
  ScreenVerdict,
  ScreenerCriteria,
  SecurityInput,
} from "./types.js";

/**
 * 筛选引擎：在全市场输入上跑规则层，产出通过基础池的标的与漏斗分档。
 *
 * 零 I/O、零网络、零时钟——输入是已经准备好的序列，输出是确定的判定结果。
 * 这是整个功能里唯一"错了不会报错、只会静默给出看似合理垃圾"的部分，
 * 所以它被刻意做成纯函数，并让每条规则都能被单独钉住。
 */

function metricsOf(ctx: ReturnType<typeof buildContext>): ScreenMetrics {
  const lastIndex = ctx.adjBars.length - 1;
  const ma100 = ctx.ma100[lastIndex] ?? null;
  const close = ctx.adjBars[lastIndex]?.close ?? null;
  const lastBar = ctx.bars[ctx.bars.length - 1];
  const prevBar = ctx.bars[ctx.bars.length - 2];

  return {
    lastClose: lastBar?.close ?? null,
    changePercent:
      lastBar && prevBar && prevBar.close > 0
        ? ((lastBar.close - prevBar.close) / prevBar.close) * 100
        : null,
    ma100,
    ma100Deviation: ma100 !== null && close !== null && ma100 !== 0 ? (close - ma100) / ma100 : null,
    barsSinceMa100Cross: barsSinceMa100Cross(
      ctx.adjBars.map((bar) => bar.close),
      ctx.ma100,
    ),
    // H9：指标一律算在后复权序列上
    trendR2: trendR2(ctx.adjBars, 20),
    floatMarketCap: ctx.security.floatMarketCap,
    turnoverAmount: lastBar?.amount ?? null,
  };
}

/**
 * 在全市场输入上跑规则层，产出通过基础池的标的与漏斗分档。
 *
 * 零 I/O、零网络、零时钟——输入是已经准备好的序列，输出是确定的判定结果。
 * 这是整个功能里唯一"错了不会报错、只会静默给出看似合理垃圾"的部分，
 * 所以它被刻意做成纯函数，并让每条规则都能被单独钉住。
 *
 * 参数是 `Iterable` 而不是数组：全市场六千只 × 上千根日线一次性驻留会有 GB 级占用，
 * 用生成器逐只喂进来，内存只与单只标的有关，而漏斗本来就只需要计数。
 */
export function screenUniverse(
  inputs: Iterable<SecurityInput>,
  criteria: ScreenerCriteria = DEFAULT_CRITERIA,
  options: { marketGate?: MarketGateLike | null } = {},
): ScreenOutcome {
  const params = paramsFor(criteria.strictness);
  const funnel: FunnelCounts = {
    universe: 0,
    afterExclusions: 0,
    afterHardFilters: 0,
    shortlisted: 0,
    signalEligible: 0,
  };

  const shortlisted: ScreenVerdict[] = [];
  /** 每条规则：有多少标的走到了它、其中多少因缺数据而无法判定 */
  const reach = new Map<string, { reached: number; unknown: number }>();

  const marketGate = options.marketGate ?? null;
  // 空仓档默认不出票（书 P9：空仓时间应长于持仓时间）；逃生开关可覆盖。
  // 注意这里只是标记，候选仍然照常算出来——漏斗计数要如实，
  // "有多少符合个股条件"与"要不要给出来"是两件事。
  const suppressed = marketGate?.state === "empty" && !criteria.ignoreMarketGate;

  for (const security of inputs) {
    funnel.universe++;
    const ctx = buildContext(security, params, criteria, marketGate);
    const { passed, rejectedBy, hits, unknownRules } = evaluateRules(ctx);

    // 记录到达情况：用于识别"因为一直缺数据而实际没生效"的规则
    for (const hit of hits) {
      const entry = reach.get(hit.id) ?? { reached: 0, unknown: 0 };
      entry.reached++;
      if (hit.outcome.unknown) entry.unknown++;
      reach.set(hit.id, entry);
    }

    const stage = rejectedBy?.stage;
    if (stage === "exclusions") continue;
    funnel.afterExclusions++;
    if (stage === "hardFilters") continue;
    funnel.afterHardFilters++;
    if (!passed) continue; // stage === "shortlist"
    funnel.shortlisted++;

    // 信号层：基础池回答"能不能买"，这里回答"现在是不是买点"
    const signalSet = evaluateSignals(criteria.mode, ctx);
    if (signalSet.signals.bestTier === null) continue;
    // 止损空间过大的不入市（书 L1767）：买点再好，错了要走太远也不值得做
    if (signalSet.exit.stopSpace > params.stopSpaceMax) continue;
    funnel.signalEligible++;

    shortlisted.push({
      code: security.code,
      passed: true,
      rejectedBy: null,
      hits,
      unknownRules,
      metrics: metricsOf(ctx),
      signals: signalSet.signals,
      exit: signalSet.exit,
      resistance: signalSet.resistance,
    });
  }

  // 一条规则若对所有走到它的标的都无法判定，说明它当前并未真正生效——
  // 必须显式暴露（例如还没接行情快照时的流通市值闸门），否则用户会以为它开着。
  const inactiveRules = RULES.filter((rule) => {
    const entry = reach.get(rule.id);
    return entry !== undefined && entry.reached > 0 && entry.unknown === entry.reached;
  }).map((rule) => rule.id);

  return { criteria, funnel, shortlisted, inactiveRules, marketGate, suppressed };
}

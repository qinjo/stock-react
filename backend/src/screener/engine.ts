import { DEFAULT_CRITERIA, paramsFor } from "./params.js";
import { RULES, barsSinceMa100Cross, buildContext, evaluateRules } from "./rules.js";
import type {
  FunnelCounts,
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

  return {
    ma100,
    ma100Deviation: ma100 !== null && close !== null && ma100 !== 0 ? (close - ma100) / ma100 : null,
    barsSinceMa100Cross: barsSinceMa100Cross(
      ctx.adjBars.map((bar) => bar.close),
      ctx.ma100,
    ),
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
): ScreenOutcome {
  const params = paramsFor(criteria.strictness);
  const funnel: FunnelCounts = {
    universe: 0,
    afterExclusions: 0,
    afterHardFilters: 0,
    shortlisted: 0,
  };

  const shortlisted: ScreenVerdict[] = [];
  /** 每条规则：有多少标的走到了它、其中多少因缺数据而无法判定 */
  const reach = new Map<string, { reached: number; unknown: number }>();

  for (const security of inputs) {
    funnel.universe++;
    const ctx = buildContext(security, params, criteria);
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

    shortlisted.push({
      code: security.code,
      passed: true,
      rejectedBy: null,
      hits,
      unknownRules,
      metrics: metricsOf(ctx),
    });
  }

  // 一条规则若对所有走到它的标的都无法判定，说明它当前并未真正生效——
  // 必须显式暴露（例如还没接行情快照时的流通市值闸门），否则用户会以为它开着。
  const inactiveRules = RULES.filter((rule) => {
    const entry = reach.get(rule.id);
    return entry !== undefined && entry.reached > 0 && entry.unknown === entry.reached;
  }).map((rule) => rule.id);

  return { criteria, funnel, shortlisted, inactiveRules };
}

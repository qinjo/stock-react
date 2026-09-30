import { describe, expect, it } from "vitest";
import { DEFAULT_CRITERIA, paramsFor } from "../src/screener/params.js";
import { RULES, barsSinceMa100Cross, buildContext } from "../src/screener/rules.js";
import { countCrossings, countLimitUp, limitUpPrice, officialChangePercent, trendR2 } from "../src/screener/structure.js";
import { screenUniverse } from "../src/screener/engine.js";
import type { RuleContext } from "../src/screener/rules.js";
import { goodSecurity } from "./helpers/screener-fixtures.js";

/**
 * 「说明里报出的数 == 实际参与比较的数」。
 *
 * 界面把 `detail` 当作"为什么选它"的证据给用户看，所以它报的数字必须是真被比较的那个——
 * 报了 5.56% 而实际比较的是别的数，"可溯源"就是假的。
 *
 * 这一组验的是**报告与比较一致**，不是"算法本身正确"（后者由结构层与阈值边界测试覆盖）。
 * 因此这里允许调用同一个计算辅助函数复算——要找的是"报的值与比的值分叉"，不是"算错了"。
 */

function rule(id: string) {
  const found = RULES.find((r) => r.id === id);
  expect(found, `未找到规则 ${id}`).toBeDefined();
  return found as (typeof RULES)[number];
}

function contextOf(strictness: "loose" | "standard" | "strict" = "standard"): RuleContext {
  return buildContext(
    goodSecurity(),
    paramsFor(strictness),
    { ...DEFAULT_CRITERIA, strictness },
  );
}

/**
 * 从说明里按顺序取出前 n 个数字。
 *
 * 先剥掉均线标签：`MA100` 里的 "100" 会被数字正则当成一个数字，
 * 而它是名称的一部分，不是被比较的值。
 */
function numbersIn(text: string, n: number): number[] {
  const cleaned = text.replace(/MA\d+/g, "MA");
  const found = cleaned.match(/-?\d+(?:\.\d+)?/g) ?? [];
  expect(found.length, `说明里的数字不足 ${n} 个：${text}`).toBeGreaterThanOrEqual(n);
  return found.slice(0, n).map(Number);
}

describe("H-bars：报出的根数与下限就是比较的那两个数", () => {
  it("说明里的根数等于上下文的日 K 根数", () => {
    const ctx = contextOf();
    const outcome = rule("H-bars").evaluate(ctx);
    const [reported, limit] = numbersIn(outcome.detail, 2);
    expect(reported).toBe(ctx.bars.length);
    expect(limit).toBe(paramsFor("standard").minListedBars);
  });
});

describe("U-ma100：报出的收盘、MA100 与偏离度三者自洽", () => {
  it("三个数都能由上下文独立复算出来", () => {
    const ctx = contextOf();
    const outcome = rule("U-ma100").evaluate(ctx);

    const lastBar = ctx.adjBars[ctx.adjBars.length - 1]!;
    const ma = ctx.ma100[ctx.ma100.length - 1]!;
    const adjClose = lastBar.close * lastBar.adjFactor;
    const deviation = ((adjClose - ma) / ma) * 100;

    const [reportedClose, reportedMa, reportedDeviation] = numbersIn(outcome.detail, 3);
    expect(reportedClose).toBeCloseTo(adjClose, 1);
    expect(reportedMa).toBeCloseTo(ma, 1);
    expect(reportedDeviation).toBeCloseTo(deviation, 1);

    // 报出的偏离度必须与"比的那两个数"一致，而不是另算的一个值
    expect(reportedDeviation).toBeCloseTo(((reportedClose - reportedMa) / reportedMa) * 100, 0);
  });
});

describe("X-ma100Whipsaw：报出的穿越次数就是比较的那个数", () => {
  it("次数与独立复算一致，且阈值取自本档参数", () => {
    const ctx = contextOf();
    const outcome = rule("X-ma100Whipsaw").evaluate(ctx);
    const crossings = countCrossings(
      ctx.adjBars.map((bar) => bar.close),
      ctx.ma100,
      20,
    );
    const [window, reported, limit] = numbersIn(outcome.detail, 3);
    expect(window).toBe(20);
    expect(reported).toBe(crossings);
    expect(limit).toBe(paramsFor("standard").ma100CrossMax);
  });
});

describe("X-limitUpStreak：报出的涨停次数与窗口就是比较的那两个数", () => {
  it("次数与独立复算一致", () => {
    // 该规则在"当日未涨停"时会提前返回，所以夹具末根必须是涨停
    const base = goodSecurity();
    const bars = base.bars.map((b) => ({ ...b }));
    const n = bars.length;
    (bars[n - 1] as { close: number }).close = limitUpPrice((bars[n - 2] as { close: number }).close, "main");
    const ctx = buildContext(
      { ...base, bars: bars as never },
      paramsFor("standard"),
      { ...DEFAULT_CRITERIA, strictness: "standard" },
    );
    const outcome = rule("X-limitUpStreak").evaluate(ctx);
    const [window, reported, limit] = numbersIn(outcome.detail, 3);
    expect(window).toBe(paramsFor("standard").limitUpStreakWindow);
    expect(reported).toBe(countLimitUp(ctx.limitUp, paramsFor("standard").limitUpStreakWindow));
    expect(limit).toBe(paramsFor("standard").limitUpStreakMax);
  });
});

describe("U-trendR2：报出的 R² 与阈值就是比较的那两个数", () => {
  it("严格档下 R² 与独立复算一致（三位小数）", () => {
    const ctx = contextOf("strict");
    const outcome = rule("U-trendR2").evaluate(ctx);
    const value = trendR2(ctx.adjBars, 20)!;
    const [reported, limit] = numbersIn(outcome.detail, 2);
    expect(reported).toBeCloseTo(value, 3);
    expect(limit).toBe(paramsFor("strict").trendR2Min);
  });

  it("宽松/标准档下说明里写明本档不要求（而不是报一个没参与比较的阈值）", () => {
    for (const tier of ["loose", "standard"] as const) {
      const outcome = rule("U-trendR2").evaluate(contextOf(tier));
      expect(outcome.ok, tier).toBe(true);
      expect(outcome.detail).toContain("本档不要求");
    }
  });
});

describe("U-marketCap / U-turnover：报出的值与门槛都来自本档参数", () => {
  it("市值说明里的区间与参数表一致", () => {
    const ctx = contextOf();
    const outcome = rule("U-marketCap").evaluate(ctx);
    const standard = paramsFor("standard");
    const values = numbersIn(outcome.detail, 1); // 首个数字是实际市值
    expect(values[0]).toBeCloseTo((ctx.security.floatMarketCap ?? 0) / 1e8, 2);
    // 区间上沿必须等于本档参数（说明里报的是 20.00亿–80.00亿）
    expect(outcome.detail).toContain((standard.floatMarketCapMax / 1e8).toFixed(2));
  });

  it("成交额说明里的下限与参数表一致", () => {
    const ctx = contextOf();
    const outcome = rule("U-turnover").evaluate(ctx);
    const standard = paramsFor("standard");
    const lastAmount = ctx.bars[ctx.bars.length - 1]!.amount;
    const [reported] = numbersIn(outcome.detail, 1);
    // 说明以"万"为单位报出实际成交额
    expect(reported).toBeCloseTo(lastAmount / 1e4, 0);
    expect(outcome.detail).toContain((standard.minTurnoverAmount / 1e4).toFixed(0));
  });
});

/* ------------- 规则名描述的判据 == 代码实际判的判据 ------------- */

/**
 * "名字说的"与"代码判的"最容易被后续改动悄悄拆开。
 * 这三条是其中最容易混淆的——位置 vs 事件、第几日的窗口、以及一处刻意细化。
 */
describe("U-ma100「站上 MA100」判的是位置，不是上穿", () => {
  const evalMa100 = (security: Parameters<typeof buildContext>[0]) =>
    rule("U-ma100").evaluate(
      buildContext(security, paramsFor("standard"), { ...DEFAULT_CRITERIA, strictness: "standard" }),
    );

  it("一路上涨、早已在 MA100 之上（今天没有任何上穿）仍然通过", () => {
    // 单调上涨的序列最后一根不可能"上穿"MA100——它早就在上面了。
    // 若把条件写成"上穿"，这里会失败，而书的原意是**位置**（书 L597）。
    const outcome = evalMa100(goodSecurity());
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain(">");
  });

  it("跌破 MA100 时被拦下", () => {
    const base = goodSecurity();
    const bars = base.bars.map((b) => ({ ...b }));
    const n = bars.length;
    // 末根砍到远低于 MA100
    (bars[n - 1] as { close: number; high: number; low: number }).close = 1;
    const outcome = evalMa100({ ...base, bars: bars as never });
    expect(outcome.ok).toBe(false);
  });
});

describe("H-noLimitUpYesterday「涨停后第 2–3 日不追高」判的是那个窗口", () => {
  const evalYesterday = (security: Parameters<typeof buildContext>[0]) =>
    rule("H-noLimitUpYesterday").evaluate(
      buildContext(security, paramsFor("standard"), { ...DEFAULT_CRITERIA, strictness: "standard" }),
    );

  const withLimitUpAt = (daysAgo: number) => {
    const base = goodSecurity();
    const bars = base.bars.map((b) => ({ ...b }));
    const n = bars.length;
    const idx = n - 1 - daysAgo;
    (bars[idx] as { close: number }).close = limitUpPrice(
      (bars[idx - 1] as { close: number }).close,
      "main",
    );
    return { ...base, bars: bars as never };
  };

  it("2 天前涨停 → 拦下（属「第 2–3 日」）", () => {
    expect(evalYesterday(withLimitUpAt(2)).ok).toBe(false);
  });

  it("3 天前涨停 → 拦下", () => {
    expect(evalYesterday(withLimitUpAt(3)).ok).toBe(false);
  });

  it("4 天前涨停 → 通过（窗口之外）", () => {
    expect(evalYesterday(withLimitUpAt(4)).ok).toBe(true);
  });
});

describe("X-highLimitUp 的「高位」是刻意细化过的：前一根也在 MA100 之上", () => {
  const evalHigh = (security: Parameters<typeof buildContext>[0]) =>
    rule("X-highLimitUp").evaluate(
      buildContext(security, paramsFor("standard"), { ...DEFAULT_CRITERIA, strictness: "standard" }),
    );

  const withLimitUp = (closes: (bars: { close: number }[]) => void) => {
    const base = goodSecurity();
    const bars = base.bars.map((b) => ({ ...b })) as { close: number }[];
    const n = bars.length;
    bars[n - 1]!.close = limitUpPrice(bars[n - 2]!.close, "main");
    closes(bars);
    return { ...base, bars: bars as never };
  };

  it("涨停且前一根也在 MA100 之上 → 高位涨停，拦下", () => {
    expect(evalHigh(withLimitUp(() => {})).ok).toBe(false);
  });

  it("从下方涨停收复 MA100 → 不算高位（那正是 S12 的形状）", () => {
    // 末两根一起压到远低于 MA100，再让末根跳到前一根的涨停价
    const outcome = evalHigh(
      withLimitUp((bars) => {
        const n = bars.length;
        bars[n - 2]!.close = 1;
        bars[n - 1]!.close = limitUpPrice(1, "main");
      }),
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.detail).toContain("收复");
  });
});

/* --------- 候选卡片上的 metrics == 规则层实际用于判断的值 --------- */

/**
 * `metrics` 由 `metricsOf` 组装、判据由 `rules` 各自计算——**两处算同一个量**。
 * 它们目前共用同一个 `RuleContext`（结构上一致），但一次"顺手在这里重算一下"的改动
 * 就会让界面上的画像与筛选依据不符，而且不会报错。
 *
 * 两者都在同一个 verdict 上（`metrics` 与 `hits`），所以可以直接对起来。
 */
describe("metrics 与规则层用于判断的值一致", () => {
  function verdictOf() {
    const outcome = screenUniverse([goodSecurity()], { ...DEFAULT_CRITERIA, strictness: "loose" });
    expect(outcome.shortlisted).toHaveLength(1);
    return outcome.shortlisted[0]!;
  }

  const hitOf = (verdict: ReturnType<typeof verdictOf>, id: string) => {
    const hit = verdict.hits.find((h) => h.id === id);
    expect(hit, `未找到规则 ${id}`).toBeDefined();
    return hit!;
  };

  it("MA100：metrics 里的值与 U-ma100 报出、比较的是同一个", () => {
    const verdict = verdictOf();
    const hit = hitOf(verdict, "U-ma100");
    const [reportedClose, reportedMa, reportedDeviation] = numbersIn(hit.outcome.detail, 3);

    expect(verdict.metrics.ma100).toBeCloseTo(reportedMa, 2);
    expect(verdict.metrics.ma100Deviation).not.toBeNull();
    expect(verdict.metrics.ma100Deviation! * 100).toBeCloseTo(reportedDeviation, 1);
    // 报出的偏离度必须与报出的收盘/MA100 自洽
    expect(reportedDeviation).toBeCloseTo(((reportedClose - reportedMa) / reportedMa) * 100, 0);
  });

  it("成交额：metrics 里的值与 U-turnover 报出、比较的是同一个", () => {
    const verdict = verdictOf();
    const hit = hitOf(verdict, "U-turnover");
    const [reportedWan] = numbersIn(hit.outcome.detail, 1);
    expect(verdict.metrics.turnoverAmount).not.toBeNull();
    // 规则以"万"为单位报出
    expect(verdict.metrics.turnoverAmount! / 1e4).toBeCloseTo(reportedWan, 0);
  });

  it("流通市值：metrics 里的值与 U-marketCap 报出、比较的是同一个", () => {
    const verdict = verdictOf();
    const hit = hitOf(verdict, "U-marketCap");
    const [reportedYi] = numbersIn(hit.outcome.detail, 1);
    expect(verdict.metrics.floatMarketCap).not.toBeNull();
    expect(verdict.metrics.floatMarketCap! / 1e8).toBeCloseTo(reportedYi, 2);
  });

  it("涨跌幅：metrics 里的值等于按交易所口径昨收独立复算的结果", () => {
    const verdict = verdictOf();
    const base = goodSecurity();
    const bars = base.bars;
    const expected = officialChangePercent(
      bars[bars.length - 1],
      bars[bars.length - 2],
    );
    expect(verdict.metrics.changePercent).toBeCloseTo(expected!, 6);
  });

  it("上穿时点：metrics 里的值与 U-ma100 所依据的是同一段均线序列", () => {
    const outcome = screenUniverse([goodSecurity()], { ...DEFAULT_CRITERIA, strictness: "loose" });
    const verdict = outcome.shortlisted[0]!;
    const ctx = buildContext(goodSecurity(), paramsFor("loose"), {
      ...DEFAULT_CRITERIA,
      strictness: "loose",
    });
    const expected = barsSinceMa100Cross(
      ctx.adjBars.map((b) => b.close),
      ctx.ma100,
    );
    expect(verdict.metrics.barsSinceMa100Cross).toBe(expected);
  });
});

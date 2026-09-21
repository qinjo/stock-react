import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  computeValuationPercentiles,
  extractIndustry,
  normalizeFinancialPeriods,
  normalizeValuationHistory,
  percentileInWindow,
  toSecucode,
  type ValuationPoint,
} from "../src/fundamentals.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const load = (name: string) => JSON.parse(readFileSync(join(fixtures, name), "utf8"));

const financeRaw = load("fundamentals-600519.raw.json");
const valuationRaw = load("valuation-history-600519.raw.json");

describe("normalizeFinancialPeriods（财报主指标）", () => {
  const periods = normalizeFinancialPeriods(financeRaw);

  it("解析 8 个报告期，最新在前", () => {
    expect(periods).toHaveLength(8);
    expect(periods[0]!.reportName).toBe("2026中报");
    expect(periods[0]!.reportDate).toBe("2026-06-30");
  });

  it("营收/净利单位为元且不缩放（922.78 亿中报）", () => {
    const p = periods[0]!;
    expect(p.revenue).toBeCloseTo(92278072083.21, 0);
    expect(p.netProfit).toBeCloseTo(44516880421.86, 0);
    // 亿为单位复核：约 922.78 亿
    expect(p.revenue! / 1e8).toBeCloseTo(922.78, 1);
  });

  it("毛利率取自 XSMLL（不是 MLR 毛利额）", () => {
    // 89.56% 是毛利率；若误用 MLR 会得到 812 亿这种量级
    expect(periods[0]!.grossMargin).toBeCloseTo(89.56, 1);
    expect(periods[0]!.grossMargin!).toBeLessThan(100);
  });

  it("同比为百分数原值（不再缩放）", () => {
    expect(periods[0]!.revenueYoy).toBeCloseTo(1.3, 2);
  });

  it("ROE/净利率/负债率/EPS/BPS/每股现金流均解析", () => {
    const p = periods[0]!;
    expect(p.roe).toBeCloseTo(16.75, 2);
    expect(p.netMargin).toBeCloseTo(50.75, 1);
    expect(p.debtRatio).toBeCloseTo(15.19, 1);
    expect(p.eps).toBeCloseTo(35.57, 2);
    expect(p.bps).toBeCloseTo(200.99, 2);
    expect(p.ocfPerShare).toBeGreaterThan(0);
  });

  it("扣非净利与同比解析", () => {
    expect(periods[0]!.deductedNetProfit).not.toBeNull();
    expect(periods[0]!.deductedNetProfitYoy).not.toBeNull();
  });

  it("结构异常返回空数组", () => {
    expect(normalizeFinancialPeriods({})).toEqual([]);
    expect(normalizeFinancialPeriods(null)).toEqual([]);
  });
});

describe("normalizeValuationHistory（日度估值）", () => {
  const history = normalizeValuationHistory(valuationRaw);

  it("解析 1600 个交易日并按日期升序", () => {
    expect(history.length).toBe(1600);
    expect(history[0]!.date < history[history.length - 1]!.date).toBe(true);
  });

  it("覆盖 6 年以上（足够算近 3 年与近 5 年分位）", () => {
    expect(history[0]!.date.slice(0, 4)).toBe("2020");
    expect(history[history.length - 1]!.date).toBe("2026-09-18");
  });

  it("最新一条含 PE/PB", () => {
    const last = history[history.length - 1]!;
    expect(last.pe).toBeCloseTo(19.3, 1);
    expect(last.pb).toBeCloseTo(6.25, 2);
  });

  it("行业名可从原始响应提取（白酒Ⅱ）", () => {
    expect(extractIndustry(valuationRaw)).toBe("白酒Ⅱ");
  });
});

describe("percentileInWindow（分位计算）", () => {
  const history = normalizeValuationHistory(valuationRaw);
  const asOf = history[history.length - 1]!.date;

  it("与调研笔记独立算出的分位一致（茅台 PE 近 3 年约 5.6%）", () => {
    const stats = percentileInWindow(history, "pe", 19.3, asOf, 3);
    expect(stats).not.toBeNull();
    // 笔记用 8.6 年全量独立计算得 5.6%；本 fixture 为 6.6 年，近 3 年窗口相同 → 应接近
    expect(stats!.percentile).toBeGreaterThan(2);
    expect(stats!.percentile).toBeLessThan(12);
    expect(stats!.samples).toBeGreaterThan(600); // 近 3 年约 730 个交易日
  });

  it("近 5 年分位同样处于低位（笔记值 3.4%）", () => {
    const stats = percentileInWindow(history, "pe", 19.3, asOf, 5);
    expect(stats).not.toBeNull();
    expect(stats!.percentile).toBeLessThan(12);
    expect(stats!.samples).toBeGreaterThan(1100);
  });

  it("PB 分位（笔记值近 3 年 6.3%）", () => {
    const stats = percentileInWindow(history, "pb", 6.25, asOf, 3);
    expect(stats!.percentile).toBeGreaterThan(2);
    expect(stats!.percentile).toBeLessThan(15);
  });

  it("窗口内极低值得到极低分位，极高值得到高分位（单调性）", () => {
    const low = percentileInWindow(history, "pe", 8, asOf, 3);
    const high = percentileInWindow(history, "pe", 60, asOf, 3);
    expect(low!.percentile).toBeLessThan(5);
    expect(high!.percentile).toBeGreaterThan(95);
  });

  it("非正 PE（亏损期）不参与统计，也不作为当前值", () => {
    const withNegative: ValuationPoint[] = [
      ...history,
      { date: "2026-09-17", pe: -5, pb: 2 },
    ];
    const stats = percentileInWindow(withNegative, "pe", 19.3, asOf, 3);
    expect(stats!.min).toBeGreaterThan(0);
    expect(percentileInWindow(history, "pe", -3, asOf, 3)).toBeNull();
    expect(percentileInWindow(history, "pe", 0, asOf, 3)).toBeNull();
  });

  it("样本不足 30 个交易日时返回 null（不足以支撑分位结论）", () => {
    const few: ValuationPoint[] = Array.from({ length: 10 }, (_, i) => ({
      date: `2026-09-${String(i + 1).padStart(2, "0")}`,
      pe: 20,
      pb: 5,
    }));
    expect(percentileInWindow(few, "pe", 20, "2026-09-10", 3)).toBeNull();
  });

  it("统计值含 min/median/max 便于模型理解分布位置", () => {
    const stats = percentileInWindow(history, "pe", 19.3, asOf, 3)!;
    expect(stats.min).toBeLessThan(stats.median);
    expect(stats.median).toBeLessThan(stats.max);
    expect(stats.min).toBeGreaterThan(0);
  });
});

describe("computeValuationPercentiles（组装）", () => {
  const history = normalizeValuationHistory(valuationRaw);

  it("同时给出近 3 年与近 5 年分位", () => {
    const v = computeValuationPercentiles(history, 19.3, 6.25);
    expect(v.asOf).toBe("2026-09-18");
    expect(v.pe.current).toBe(19.3);
    expect(v.pe.y3?.percentile).toBeDefined();
    expect(v.pe.y5?.percentile).toBeDefined();
    expect(v.pb.y3?.percentile).toBeDefined();
  });

  it("空历史时优雅降级（不崩溃、不编造）", () => {
    const v = computeValuationPercentiles([], 19.3, 6.25);
    expect(v.asOf).toBeNull();
    expect(v.pe.y3).toBeNull();
    expect(v.pe.current).toBe(19.3);
  });
});

describe("toSecucode", () => {
  it("沪市加 .SH，深市加 .SZ", () => {
    expect(toSecucode("600519")).toBe("600519.SH");
    expect(toSecucode("000001")).toBe("000001.SZ");
    expect(toSecucode("300750")).toBe("300750.SZ");
  });

  it("容忍带前缀/后缀的输入", () => {
    expect(toSecucode("sh600519")).toBe("600519.SH");
    expect(toSecucode("600519.SH")).toBe("600519.SH");
  });
});

describe("fetchValuationHistory 的分页合并（回归：曾因二次归一化丢空数据）", () => {
  it("多页结果合并后不丢数据且保持日期升序", async () => {
    // 该 bug 的成因：把已归一化的结果再次送进 normalizeValuationHistory（读原始字段名）
    // → 全部被过滤为空。此处用 mock fetch 覆盖分页合并路径。
    const pageOf = (rows: Array<{ d: string; pe: number; pb: number }>) =>
      JSON.stringify({
        result: {
          data: rows.map((r) => ({
            TRADE_DATE: `${r.d} 00:00:00`,
            PE_TTM: r.pe,
            PB_MRQ: r.pb,
            BOARD_NAME: "白酒Ⅱ",
          })),
        },
      });

    const pages = [
      pageOf([{ d: "2026-09-18", pe: 19.3, pb: 6.25 }, { d: "2026-09-17", pe: 19.4, pb: 6.3 }]),
      pageOf([{ d: "2026-09-16", pe: 19.1, pb: 6.2 }, { d: "2026-09-15", pe: 19.0, pb: 6.1 }]),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve(JSON.parse(pages[call++]!)),
        } as Response),
      ),
    );
    try {
      const { fetchValuationHistory } = await import("../src/fundamentals.js");
      const { history, industry } = await fetchValuationHistory("600519", 2);

      expect(history).toHaveLength(4); // 曾被清空为 0
      expect(history[0]!.date).toBe("2026-09-15"); // 升序
      expect(history[3]!.date).toBe("2026-09-18");
      expect(history[3]!.pe).toBeCloseTo(19.3, 2);
      expect(industry).toBe("白酒Ⅱ");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

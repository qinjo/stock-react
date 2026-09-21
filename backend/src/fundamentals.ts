/**
 * 基本面数据适配器（东方财富数据中心）。
 *
 * 数据源：`datacenter-web.eastmoney.com/api/data/v1/get`
 * —— 免 key、CORS `*`、实测零限流，且与 push2 的反爬**按域名隔离**
 * （push2 封禁窗口内 datacenter-web 照常 200）。
 *
 * 覆盖两块此前完全缺失的维度（正是 LLM 反复点名的"最大盲区"）：
 * 1. 财务报表主指标（营收/净利/同比/ROE/毛利率/净利率/负债率/EPS/BPS）
 * 2. 日度历史估值（PE_TTM / PB_MRQ）→ 算出**估值分位**，回答"估值是高是低"
 *
 * 字段陷阱（调研实测，务必遵守）：
 * - `MLR` 是**毛利额（元）**不是毛利率，真毛利率是 `XSMLL` —— 本模块不取 MLR。
 * - `JYXJLYYSR` 是小数比例且分母非总营收 —— 本模块不取，避免歧义。
 * - 财报是**年内累计（YTD）**口径，非单季。
 * - filter 语法为括号并置隐式 AND；`SECUCODE`（带后缀）与 `SECURITY_CODE`（6 位）混用。
 */

const DATACENTER = "https://datacenter-web.eastmoney.com/api/data/v1/get";

/** 单个报告期的财务主指标。 */
export type FinancialPeriod = {
  /** 报告期，如 2026-06-30 */
  reportDate: string;
  /** 报告期名称，如「2026中报」 */
  reportName: string;
  /** 营业总收入（元） */
  revenue: number | null;
  /** 营业总收入同比（%） */
  revenueYoy: number | null;
  /** 归母净利润（元） */
  netProfit: number | null;
  /** 归母净利润同比（%） */
  netProfitYoy: number | null;
  /** 扣非净利润（元） */
  deductedNetProfit: number | null;
  /** 扣非净利润同比（%） */
  deductedNetProfitYoy: number | null;
  /** 加权 ROE（%） */
  roe: number | null;
  /** 销售毛利率（%），来自 XSMLL（**不是** MLR 毛利额） */
  grossMargin: number | null;
  /** 销售净利率（%） */
  netMargin: number | null;
  /** 资产负债率（%） */
  debtRatio: number | null;
  /** 每股净资产（元） */
  bps: number | null;
  /** 基本每股收益（元） */
  eps: number | null;
  /** 每股经营性现金流（元） */
  ocfPerShare: number | null;
};

/** 某指标在给定时间窗口内的分位统计。 */
export type PercentileStats = {
  /** 当前值在窗口内的百分位（0-100，越低越便宜） */
  percentile: number;
  min: number;
  median: number;
  max: number;
  /** 参与统计的交易日数 */
  samples: number;
};

export type MetricPercentiles = {
  current: number | null;
  /** 近 3 年分位 */
  y3: PercentileStats | null;
  /** 近 5 年分位 */
  y5: PercentileStats | null;
};

export type ValuationPercentiles = {
  /** 数据截止交易日 */
  asOf: string | null;
  pe: MetricPercentiles;
  pb: MetricPercentiles;
};

export type Fundamentals = {
  /** 最近若干报告期（最新在前） */
  periods: FinancialPeriod[];
  /** 估值分位（PE/PB 近 3 年、近 5 年） */
  valuation: ValuationPercentiles;
  /** 所属行业（如「白酒Ⅱ」） */
  industry: string | null;
};

export type ValuationPoint = {
  date: string;
  pe: number | null;
  pb: number | null;
};

/* ------------------------------ 纯函数层 ------------------------------ */

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "-" || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

/** 归一化报告期财务数据（按报告期倒序）。 */
export function normalizeFinancialPeriods(raw: unknown): FinancialPeriod[] {
  const data = (raw as { result?: { data?: unknown } } | null)?.result?.data;
  if (!Array.isArray(data)) return [];

  return data.map((row) => {
    const r = row as Record<string, unknown>;
    return {
      reportDate: str(r.REPORT_DATE).slice(0, 10),
      reportName: str(r.REPORT_DATE_NAME),
      revenue: num(r.TOTALOPERATEREVE),
      revenueYoy: num(r.TOTALOPERATEREVETZ),
      netProfit: num(r.PARENTNETPROFIT),
      netProfitYoy: num(r.PARENTNETPROFITTZ),
      deductedNetProfit: num(r.KCFJCXSYJLR),
      deductedNetProfitYoy: num(r.KCFJCXSYJLRTZ),
      roe: num(r.ROEJQ),
      grossMargin: num(r.XSMLL),
      netMargin: num(r.XSJLL),
      debtRatio: num(r.ZCFZL),
      bps: num(r.BPS),
      eps: num(r.EPSJB),
      ocfPerShare: num(r.MGJYXJJE),
    };
  });
}

/** 归一化日度估值历史（升序，便于分位计算）。 */
export function normalizeValuationHistory(raw: unknown): ValuationPoint[] {
  const data = (raw as { result?: { data?: unknown } } | null)?.result?.data;
  if (!Array.isArray(data)) return [];

  return data
    .map((row) => {
      const r = row as Record<string, unknown>;
      return {
        date: str(r.TRADE_DATE).slice(0, 10),
        pe: num(r.PE_TTM),
        pb: num(r.PB_MRQ),
      };
    })
    .filter((p) => p.date !== "")
    .sort((a, b) => a.date.localeCompare(b.date));
}

/** 从历史序列提取最新一条的行业名（BOARD_NAME）。 */
export function extractIndustry(raw: unknown): string | null {
  const data = (raw as { result?: { data?: unknown } } | null)?.result?.data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const name = str((data[0] as Record<string, unknown>).BOARD_NAME);
  return name === "" ? null : name;
}

/** 窗口起点：asOf 往前 years 年（按日期字符串计算，避免时区问题）。 */
function windowStart(asOf: string, years: number): string {
  const y = Number(asOf.slice(0, 4)) - years;
  return `${String(y).padStart(4, "0")}${asOf.slice(4)}`;
}

/**
 * 计算当前值在窗口内的分位。
 *
 * 规则：
 * - 只统计**正数**值（PE/PB 为负或 0 无估值意义，如亏损期）
 * - 分位 = 窗口内 ≤ 当前值的样本占比 × 100（越低越便宜）
 * - 样本不足 30 个交易日则返回 null（不足以支撑分位结论）
 */
export function percentileInWindow(
  history: ValuationPoint[],
  field: "pe" | "pb",
  current: number | null,
  asOf: string,
  years: number,
): PercentileStats | null {
  if (current === null || current <= 0) return null;

  const start = windowStart(asOf, years);
  const values = history
    .filter((p) => p.date >= start && p.date <= asOf)
    .map((p) => p[field])
    .filter((v): v is number => v !== null && v > 0);

  if (values.length < 30) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const below = sorted.filter((v) => v <= current).length;
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  return {
    percentile: Number(((below / sorted.length) * 100).toFixed(1)),
    min: Number(sorted[0]!.toFixed(2)),
    median: Number(median.toFixed(2)),
    max: Number(sorted[sorted.length - 1]!.toFixed(2)),
    samples: sorted.length,
  };
}

/** 组装估值分位（近 3 年 + 近 5 年）。 */
export function computeValuationPercentiles(
  history: ValuationPoint[],
  currentPe: number | null,
  currentPb: number | null,
): ValuationPercentiles {
  const asOf = history.length > 0 ? history[history.length - 1]!.date : null;
  if (!asOf) {
    return {
      asOf: null,
      pe: { current: currentPe, y3: null, y5: null },
      pb: { current: currentPb, y3: null, y5: null },
    };
  }

  return {
    asOf,
    pe: {
      current: currentPe,
      y3: percentileInWindow(history, "pe", currentPe, asOf, 3),
      y5: percentileInWindow(history, "pe", currentPe, asOf, 5),
    },
    pb: {
      current: currentPb,
      y3: percentileInWindow(history, "pb", currentPb, asOf, 3),
      y5: percentileInWindow(history, "pb", currentPb, asOf, 5),
    },
  };
}

/* ------------------------------ 网络层 ------------------------------ */

/** 6 位代码 → 带交易所后缀（600519 → 600519.SH）。 */
export function toSecucode(code: string): string {
  const digits = code.replace(/\D/g, "").slice(-6);
  const suffix = digits.startsWith("6") || digits.startsWith("9") ? "SH" : "SZ";
  return `${digits}.${suffix}`;
}

const FINANCE_COLUMNS = [
  "REPORT_DATE",
  "REPORT_DATE_NAME",
  "TOTALOPERATEREVE",
  "TOTALOPERATEREVETZ",
  "PARENTNETPROFIT",
  "PARENTNETPROFITTZ",
  "KCFJCXSYJLR",
  "KCFJCXSYJLRTZ",
  "ROEJQ",
  "XSMLL",
  "XSJLL",
  "ZCFZL",
  "BPS",
  "EPSJB",
  "MGJYXJJE",
].join(",");

const VALUATION_COLUMNS = "SECURITY_CODE,TRADE_DATE,CLOSE_PRICE,PE_TTM,PB_MRQ,PS_TTM,BOARD_NAME";

async function getDatacenter(params: Record<string, string>): Promise<unknown> {
  const url = new URL(DATACENTER);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "Mozilla/5.0 (compatible; stock-react/0.1)" },
  });
  if (!res.ok) throw new Error(`数据中心请求失败：HTTP ${res.status}`);
  return res.json();
}

/** 拉取最近 8 个报告期的财务主指标。 */
export async function fetchFinancialPeriods(code: string): Promise<FinancialPeriod[]> {
  const raw = await getDatacenter({
    reportName: "RPT_F10_FINANCE_MAINFINADATA",
    columns: FINANCE_COLUMNS,
    filter: `(SECUCODE="${toSecucode(code)}")`,
    pageNumber: "1",
    pageSize: "8",
    sortColumns: "REPORT_DATE",
    sortTypes: "-1",
    source: "WEB",
    client: "WEB",
  });
  return normalizeFinancialPeriods(raw);
}

/** 分页拉取日度估值历史（默认 2 页 × 800 ≈ 6.4 年，覆盖 3/5 年窗口）。 */
export async function fetchValuationHistory(
  code: string,
  pages = 2,
): Promise<{ history: ValuationPoint[]; industry: string | null }> {
  const digits = code.replace(/\D/g, "").slice(-6);
  const points: ValuationPoint[] = [];
  let industry: string | null = null;

  for (let page = 1; page <= pages; page++) {
    const raw = await getDatacenter({
      reportName: "RPT_VALUEANALYSIS_DET",
      columns: VALUATION_COLUMNS,
      // 注意：该接口用 6 位 SECURITY_CODE（与财报接口的 SECUCODE 不同）
      filter: `(SECURITY_CODE="${digits}")`,
      pageNumber: String(page),
      pageSize: "800",
      sortColumns: "TRADE_DATE",
      sortTypes: "-1",
      source: "WEB",
      client: "WEB",
    });
    if (page === 1) industry = extractIndustry(raw);
    points.push(...normalizeValuationHistory(raw));
  }

  // 注意：points 已是归一化后的结构，**不可**再走 normalizeValuationHistory
  // （它读的是原始字段名 TRADE_DATE，二次归一化会把数据全部过滤为空）
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { history: points, industry };
}

/** 一次性拉齐基本面（财报 + 估值分位），供分析输入使用。 */
export async function fetchFundamentals(
  code: string,
  currentPe: number | null,
  currentPb: number | null,
): Promise<Fundamentals> {
  const [periods, valuation] = await Promise.all([
    fetchFinancialPeriods(code),
    fetchValuationHistory(code),
  ]);

  return {
    periods,
    valuation: computeValuationPercentiles(valuation.history, currentPe, currentPb),
    industry: valuation.industry,
  };
}

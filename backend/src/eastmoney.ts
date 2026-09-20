import type { Kline, Quote } from "./domain.js";

/**
 * 东方财富数据适配器。
 *
 * 分层约定：
 * - 纯函数（resolveSecid / normalize*）不触网，用录制 fixture 单测（次 seam）；
 * - fetch* 函数负责网络，仅做取数与 JSON 解析，归一化全部委托纯函数。
 *
 * 字段缩放陷阱（实测）：价格、涨跌幅、PE、PB、换手率均为 ×100 整数；
 * 成交量（手）、成交额（元）、市值（元）不缩放。
 *
 * 搜索与备源（腾讯）见 `tencent.ts`；主备降级编排见 `datasource.ts`。
 */

const PUSH2 = "https://push2.eastmoney.com";
const PUSH2HIS = "https://push2his.eastmoney.com";

/** 东财原始响应中缺失值常为 "-" 或 null；统一转为 null。 */
function num(v: unknown, scale = 1): number | null {
  if (v === null || v === undefined || v === "-" || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return scale === 1 ? n : n / scale;
}

/**
 * 把用户输入解析为东财 secid（`<市场>.<代码>`）。
 *
 * 支持：6 位代码、sh/sz/bj 前缀、.SH/.SZ/.BJ 后缀、已带市场前缀的 secid。
 * 市场判定：6/9→沪(1)，0/2/3/4/8→深或北(0)。
 */
export function resolveSecid(input: string): string {
  const raw = input.trim().toUpperCase().replace(/\s+/g, "");
  if (!raw) throw new Error("股票代码不能为空");

  // 已经是 secid 形式（1.600519 / 0.000001）
  if (/^[0-9]\.[0-9A-Z]+$/.test(raw)) return raw;

  // 后缀形式：600519.SH
  const suffix = raw.match(/^([0-9]{5,6}[0-9A-Z]*)\.(SH|SZ|BJ)$/);
  if (suffix) {
    const [, code, mk] = suffix;
    return `${mk === "SH" ? "1" : "0"}.${code}`;
  }

  // 前缀形式：SH600519
  const prefix = raw.match(/^(SH|SZ|BJ)([0-9]{5,6})$/);
  if (prefix) {
    const [, mk, code] = prefix;
    return `${mk === "SH" ? "1" : "0"}.${code}`;
  }

  // 纯代码
  const code = raw.match(/^([0-9]{6})$/);
  if (!code) throw new Error(`无法识别的股票代码：${input}`);
  const digits = code[1]!;
  const market = digits.startsWith("6") || digits.startsWith("9") ? "1" : "0";
  return `${market}.${digits}`;
}

/** 归一化实时快照（push2 stock/get 响应）。 */
export function normalizeQuote(raw: unknown): Quote {
  const data = (raw as { data?: Record<string, unknown> } | null)?.data;
  if (!data) throw new Error("行情响应缺少 data 字段");

  return {
    code: String(data.f57 ?? ""),
    name: String(data.f58 ?? ""),
    price: num(data.f43, 100),
    high: num(data.f44, 100),
    low: num(data.f45, 100),
    open: num(data.f46, 100),
    volume: num(data.f47),
    amount: num(data.f48),
    limitUp: num(data.f51, 100),
    limitDown: num(data.f52, 100),
    prevClose: num(data.f60, 100),
    marketCap: num(data.f116),
    floatMarketCap: num(data.f117),
    pe: num(data.f162, 100),
    pb: num(data.f167, 100),
    turnoverRate: num(data.f168, 100),
    changePercent: num(data.f170, 100),
  };
}

/**
 * 归一化日 K 线（push2his kline/get 响应）。
 *
 * 实测列序陷阱：date, open, close, high, low, volume, amount, 振幅, 涨跌幅, 涨跌额, 换手率
 * —— close 在第 3 列而非标准 OHLC 的第 5 列。
 *
 * @param limit 截取最近 N 根（东财 `lmt` 参数实测不可靠，必须在此截尾）
 */
export function normalizeKline(raw: unknown, limit?: number): Kline[] {
  const rows = (raw as { data?: { klines?: unknown } } | null)?.data?.klines;
  if (!Array.isArray(rows)) throw new Error("K线响应缺少 klines 数组");

  const parsed: Kline[] = rows.map((line) => {
    const c = String(line).split(",");
    if (c.length < 6) throw new Error(`K线行格式异常：${line}`);
    return {
      date: c[0]!,
      open: Number(c[1]),
      close: Number(c[2]),
      high: Number(c[3]),
      low: Number(c[4]),
      volume: Number(c[5]),
      amount: num(c[6]),
      amplitude: num(c[7]),
      changePercent: num(c[8]),
      changeAmount: num(c[9]),
      turnoverRate: num(c[10]),
    };
  });

  if (limit && limit > 0 && parsed.length > limit) {
    return parsed.slice(-limit);
  }
  return parsed;
}

/* ------------------------------- 网络层 ------------------------------- */

/**
 * 解析响应体：兼容纯 JSON 与 JSONP 包装。
 *
 * 实测坑：东财 suggest 接口对浏览器 UA 返回 JSONP（`jQuery351...({...})`），
 * 对 curl UA 返回纯 JSON —— 直接 res.json() 会在浏览器 UA 下解析失败。
 */
export function parseMaybeJsonp(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("数据源返回空响应");

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return JSON.parse(trimmed);
  }

  // JSONP：identifier({...}); —— 贪婪匹配到最后一个右括号
  const jsonp = trimmed.match(/^[A-Za-z_$][\w$]*\s*\(([\s\S]*)\)\s*;?$/);
  if (jsonp?.[1]) return JSON.parse(jsonp[1]);

  throw new Error("无法解析数据源响应格式");
}

/** 浏览器 UA：用于 push2 行情接口。 */
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36";

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
    headers,
  });
  if (!res.ok) throw new Error(`数据源请求失败：HTTP ${res.status}`);
  return parseMaybeJsonp(await res.text());
}

const QUOTE_HEADERS: Record<string, string> = { "User-Agent": BROWSER_UA };

const QUOTE_FIELDS =
  "f43,f44,f45,f46,f47,f48,f51,f52,f57,f58,f60,f116,f117,f162,f167,f168,f170";
const KLINE_FIELDS1 = "f1,f2,f3,f4,f5,f6";
const KLINE_FIELDS2 = "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";

export async function fetchEastmoneyQuote(input: string): Promise<Quote> {
  const secid = resolveSecid(input);
  const url = `${PUSH2}/api/qt/stock/get?secid=${secid}&fields=${QUOTE_FIELDS}`;
  return normalizeQuote(await getJson(url, QUOTE_HEADERS));
}

export async function fetchEastmoneyKline(input: string, limit = 60): Promise<Kline[]> {
  const secid = resolveSecid(input);
  const url =
    `${PUSH2HIS}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1` +
    `&fields1=${KLINE_FIELDS1}&fields2=${KLINE_FIELDS2}` +
    `&beg=0&end=20500101`;
  return normalizeKline(await getJson(url, QUOTE_HEADERS), limit);
}

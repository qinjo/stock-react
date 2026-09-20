import type { Kline, Quote, SearchCandidate } from "./domain.js";
import { resolveSecid } from "./eastmoney.js";

/**
 * 腾讯财经适配器（A 股备源）。
 *
 * 用途：东财 push2 有 IP 级反爬（密集请求后断连，实测 Empty reply），
 * 本模块作为降级源，保证端到端可用。实测两源行情数据一致。
 *
 * 编码坑：`qt.gtimg.cn` 实时接口返回 **GBK**（需 TextDecoder("gbk")），
 * K 线接口为 UTF-8 JSON，smartbox 搜索为 unicode 转义的 ASCII 文本。
 */

const QT = "https://qt.gtimg.cn";
const FQKLINE = "https://web.ifzq.gtimg.cn/appstock/app/fqkline/get";
const SMARTBOX = "https://smartbox.gtimg.cn/s3/";

/** 东财 secid → 腾讯 symbol（`1.600519` → `sh600519`）。 */
export function secidToTencentSymbol(secid: string): string {
  const [market, code] = secid.split(".");
  return `${market === "1" ? "sh" : "sz"}${code}`;
}

/** 腾讯字段缺失值为 ""；统一转为 null。 */
function num(v: unknown, scale = 1): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return scale === 1 ? n : n * scale;
}

/**
 * 归一化腾讯实时行情（qt.gtimg.cn `v_<symbol>="…~…"` 格式）。
 *
 * 字段索引经与东财 fixture 逐值对照确认（实测）：
 * 1名称 2代码 3现价 4昨收 5今开 6成交量(手) 32涨跌幅% 33最高 34最低
 * 37成交额(万元) 38换手率% 44流通市值(亿) 45总市值(亿) 46市净率
 * 47涨停价 48跌停价 52市盈率(动)
 */
export function normalizeTencentQuote(text: string): Quote {
  const match = text.match(/="([\s\S]*?)";?\s*$/);
  const f = (match?.[1] ?? "").split("~");
  if (f.length < 53) throw new Error("腾讯行情响应字段不足");

  return {
    code: f[2] ?? "",
    name: f[1] ?? "",
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    volume: num(f[6]),
    changePercent: num(f[32]),
    high: num(f[33]),
    low: num(f[34]),
    // 腾讯成交额单位为万元、市值为亿元，统一换算为元
    amount: num(f[37], 1e4),
    turnoverRate: num(f[38]),
    floatMarketCap: num(f[44], 1e8),
    marketCap: num(f[45], 1e8),
    pb: num(f[46]),
    limitUp: num(f[47]),
    limitDown: num(f[48]),
    pe: num(f[52]),
  };
}

/**
 * 归一化腾讯日 K 线（fqkline 响应）。
 *
 * 行格式：`[date, open, close, high, low, volume]` —— 与东财同为
 * open→close→high→low 的非标准列序（close 在第 3 位）。
 * 腾讯不返回成交额/振幅/换手率，置 null。
 */
export function normalizeTencentKline(raw: unknown, limit?: number): Kline[] {
  const data = (raw as { data?: Record<string, { qfqday?: unknown; day?: unknown }> } | null)?.data;
  if (!data) throw new Error("腾讯K线响应缺少 data");

  const entry = Object.values(data)[0];
  const rows = entry?.qfqday ?? entry?.day;
  if (!Array.isArray(rows)) throw new Error("腾讯K线响应缺少日线数组");

  const parsed: Kline[] = rows.map((line) => {
    const c = line as unknown[];
    if (c.length < 6) throw new Error(`腾讯K线行格式异常：${JSON.stringify(line)}`);
    return {
      date: String(c[0]),
      open: Number(c[1]),
      close: Number(c[2]),
      high: Number(c[3]),
      low: Number(c[4]),
      volume: Number(c[5]),
      amount: null,
      amplitude: null,
      changePercent: null,
      changeAmount: null,
      turnoverRate: null,
    };
  });

  return limit && limit > 0 && parsed.length > limit ? parsed.slice(-limit) : parsed;
}

/**
 * 归一化搜索建议（smartbox `v_hint="…"` 格式）。
 *
 * 字段序：市场~代码~名称(unicode 转义)~拼音~类型；多条以 `^` 分隔。
 * 类型以 `GP-A` 开头者为 A 股（另有 FJ/LOF/ZS 等非股票类型，需过滤）。
 */
export function normalizeTencentSuggest(text: string): SearchCandidate[] {
  const match = text.match(/v_hint\s*=\s*"([\s\S]*?)"\s*;?\s*$/);
  const body = match?.[1] ?? "";
  if (!body) return [];

  return body
    .split("^")
    .map((entry) => entry.split("~"))
    .filter((parts) => parts.length >= 5 && parts[4]!.startsWith("GP-A"))
    .map((parts) => {
      const [market = "", code = "", rawName = "", pinyin = ""] = parts;
      const isSh = market.toLowerCase() === "sh";
      return {
        code,
        name: decodeUnicodeEscapes(rawName),
        secid: `${isSh ? "1" : "0"}.${code}`,
        market: isSh ? "沪A" : "深A",
        pinyin: pinyin.toUpperCase(),
      };
    })
    .filter((c) => c.code !== "");
}

/** 解码 `\uXXXX` 转义（smartbox 对中文名的编码方式）。 */
function decodeUnicodeEscapes(s: string): string {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

/* ------------------------------- 网络层 ------------------------------- */

export async function fetchTencentQuote(input: string): Promise<Quote> {
  const symbol = secidToTencentSymbol(resolveSecid(input));
  const res = await fetch(`${QT}/q=${symbol}`, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`腾讯行情请求失败：HTTP ${res.status}`);
  // 实时接口是 GBK 编码，必须显式解码
  const text = new TextDecoder("gbk").decode(await res.arrayBuffer());
  return normalizeTencentQuote(text);
}

export async function fetchTencentKline(input: string, limit = 60): Promise<Kline[]> {
  const symbol = secidToTencentSymbol(resolveSecid(input));
  const url = `${FQKLINE}?param=${symbol},day,,,${limit},qfq`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`腾讯K线请求失败：HTTP ${res.status}`);
  return normalizeTencentKline(await res.json(), limit);
}

export async function fetchSuggest(query: string, count = 10): Promise<SearchCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${SMARTBOX}?q=${encodeURIComponent(q)}&t=all`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new Error(`数据源请求失败：HTTP ${res.status}`);
  return normalizeTencentSuggest(await res.text()).slice(0, count);
}

import { SourceUnavailableError, type Kline, type Quote, type SearchCandidate } from "./domain.js";
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
 * 成交量单位归一化：**科创板（688/689）返回的是「股」，其余板块是「手」**。
 *
 * 这是实测出来的坑，不是文档约定：对 4 只科创板标的做
 * `成交额 ÷ (成交量 × 100 × 现价)` 全部得到 ≈0.01（其余板块 ≈1.0），
 * 说明科创板那一列比"手"大 100 倍。领域模型统一用「手」，所以在这里收口。
 * 不换算的后果很隐蔽：成交额与价格都对，只有成交量差两个数量级。
 */
export function volumeToLots(rawVolume: number | null, symbol: string): number | null {
  if (rawVolume === null) return null;
  return /^(sh|SH)(688|689)/.test(symbol) ? rawVolume / 100 : rawVolume;
}

/** 从 `v_<symbol>=` 前缀取标的代码；取不到则返回空串。 */
export function symbolFromLine(text: string): string {
  return text.match(/^v_([a-z0-9]+)\s*=/i)?.[1]?.toLowerCase() ?? "";
}

/**
 * 归一化腾讯实时行情（qt.gtimg.cn `v_<symbol>="…~…"` 格式）。
 *
 * 字段索引经与东财 fixture 逐值对照确认（实测）：
 * 1名称 2代码 3现价 4昨收 5今开 6成交量 30时间戳 32涨跌幅% 33最高 34最低
 * 37成交额(万元) 38换手率% 44流通市值(亿) 45总市值(亿) 46市净率
 * 47涨停价 48跌停价 52市盈率(动)
 *
 * 字段个数不固定（实测北交所标的少一个），因此只按索引取用、不校验总长。
 */
export function normalizeTencentQuote(text: string): Quote {
  const match = text.match(/="([\s\S]*?)";?\s*$/);
  const f = (match?.[1] ?? "").split("~");
  if (f.length < 53) throw new Error("腾讯行情响应字段不足");

  const symbol = symbolFromLine(text);

  return {
    code: f[2] ?? "",
    name: f[1] ?? "",
    price: num(f[3]),
    prevClose: num(f[4]),
    open: num(f[5]),
    volume: volumeToLots(num(f[6]), symbol),
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

/** 批量快照中的一行：行情 + 该行的标的符号与时间戳。 */
export type TencentSnapshot = {
  /** `sh600519` 形式的小写符号 */
  symbol: string;
  quote: Quote;
  /** 字段 30：`YYYYMMDDHHMMSS`；解析不出为 null */
  timestamp: string | null;
  /** 时间戳里的交易日 `YYYYMMDD` 整数；解析不出为 null */
  tradeDate: number | null;
};

/**
 * 归一化批量快照响应（一次请求可携带数百个代码）。
 *
 * 单行解析失败不影响其余标的——批量接口里个别标的停牌或字段异常是常态，
 * 让整批失败会白白浪费一次请求额度。
 */
export function normalizeTencentBatch(text: string): TencentSnapshot[] {
  const out: TencentSnapshot[] = [];
  for (const line of text.split("\n")) {
    const symbol = symbolFromLine(line);
    if (!symbol) continue;
    try {
      const quote = normalizeTencentQuote(line);
      const raw = line.match(/="([\s\S]*?)";?\s*$/)?.[1] ?? "";
      const timestamp = (raw.split("~")[30] ?? "").trim();
      const valid = /^\d{14}$/.test(timestamp);
      out.push({
        symbol,
        quote,
        timestamp: valid ? timestamp : null,
        tradeDate: valid ? Number(timestamp.slice(0, 8)) : null,
      });
    } catch {
      // 跳过该行：下面按"缺失"处理，不阻塞其余标的
    }
  }
  return out;
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
  if (!res.ok) throw new SourceUnavailableError(`腾讯行情请求失败：HTTP ${res.status}`);
  // 实时接口是 GBK 编码，必须显式解码
  const text = new TextDecoder("gbk").decode(await res.arrayBuffer());
  return normalizeTencentQuote(text);
}

export async function fetchTencentKline(input: string, limit = 60): Promise<Kline[]> {
  const symbol = secidToTencentSymbol(resolveSecid(input));
  const url = `${FQKLINE}?param=${symbol},day,,,${limit},qfq`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new SourceUnavailableError(`腾讯K线请求失败：HTTP ${res.status}`);
  return normalizeTencentKline(await res.json(), limit);
}

/**
 * 批量快照：一次请求携带多个代码。
 *
 * 分块大小取 400 而不是实测上限（请求 600 个只回 513 条）——留出余量，
 * 避免"静默少拿"这种最难发现的失败：全市场约六千只，宁可用十余个请求换确定性。
 * 请求之间串行且有间隔，不并发。
 */
export const SNAPSHOT_CHUNK_SIZE = 400;
const SNAPSHOT_CHUNK_DELAY_MS = 300;

export async function fetchTencentBatchSnapshot(
  symbols: readonly string[],
  options: { chunkSize?: number; delayMs?: number; signal?: AbortSignal } = {},
): Promise<TencentSnapshot[]> {
  const chunkSize = options.chunkSize ?? SNAPSHOT_CHUNK_SIZE;
  const delayMs = options.delayMs ?? SNAPSHOT_CHUNK_DELAY_MS;
  const out: TencentSnapshot[] = [];

  for (let i = 0; i < symbols.length; i += chunkSize) {
    const chunk = symbols.slice(i, i + chunkSize);
    const res = await fetch(`${QT}/q=${chunk.join(",")}`, {
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new SourceUnavailableError(`腾讯批量快照请求失败：HTTP ${res.status}`);
    out.push(...normalizeTencentBatch(new TextDecoder("gbk").decode(await res.arrayBuffer())));

    // 串行 + 间隔：这是全市场唯一实测无限流的通道，没有理由去压它
    if (i + chunkSize < symbols.length && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return out;
}

export async function fetchSuggest(query: string, count = 10): Promise<SearchCandidate[]> {
  const q = query.trim();
  if (!q) return [];
  const url = `${SMARTBOX}?q=${encodeURIComponent(q)}&t=all`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw new SourceUnavailableError(`数据源请求失败：HTTP ${res.status}`);
  return normalizeTencentSuggest(await res.text()).slice(0, count);
}

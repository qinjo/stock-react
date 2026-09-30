/**
 * Qlib 数据格式解析（纯函数，零 I/O）。
 *
 * 格式结论来自**对真实归档的字节级核对**，不是照抄文档——文档与实现有两处不一致：
 *
 * 1. `calendars/day.txt`：一行一个交易日，升序。
 * 2. `instruments/all.txt`：`SYMBOL\tSTART\tEND`，其中 **SYMBOL 是大写**，
 *    而 `features/` 下的目录名是**小写**。这处不一致会直接导致找不到文件。
 * 3. 特征文件是**纯 float32 数组**：元素 0 是日历起始索引，其余是数值。
 *    **没有数量字段**——元素个数 = 文件字节数 / 4 - 1。
 *    核对依据：sz000001 的 close 文件 25,928 B = (6481 + 1) × 4。
 * 4. 价格字段是**因子缩放**过的：不复权价 = 缩放价 / factor。
 *
 * 一切换算都在这里集中，上层只见「不复权价 + 手 + 元 + 因子」的领域口径。
 */

/** 需要的行情字段。归档里每只标的有 10 个字段，我们只用其中 7 个。 */
export const QLIB_QUOTE_FIELDS = [
  "open",
  "high",
  "low",
  "close",
  "volume",
  "amount",
  "factor",
] as const;

export type QlibQuoteField = (typeof QLIB_QUOTE_FIELDS)[number];

export type QlibInstrument = {
  /** 原始符号，大写，如 `SH600519` */
  symbol: string;
  /** 数据起始交易日 `YYYY-MM-DD` */
  start: string;
  /** 数据截止交易日 `YYYY-MM-DD`；等于最新交易日说明仍在交易 */
  end: string;
};

/** 解析交易日历：`YYYY-MM-DD` 升序数组。 */
export function parseCalendar(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** 解析标的清单。格式 `SYMBOL\tSTART\tEND`，符号为大写。 */
export function parseInstruments(text: string): QlibInstrument[] {
  const out: QlibInstrument[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const [symbol, start, end] = line.split("\t");
    if (!symbol) continue;
    out.push({ symbol, start: start ?? "", end: end ?? "" });
  }
  return out;
}

export type FeatureSeries = {
  /** 该序列在交易日历中的起始下标 */
  startIndex: number;
  /** 数值本身（已去掉头部那个索引元素） */
  values: Float32Array;
};

/**
 * 解析一个特征文件。
 *
 * 字节布局：`float32[]`，元素 0 = 日历起始索引，元素 1..n = 数值，**没有数量字段**。
 * 逐元素 `readFloatLE` 而不是把 Buffer 直接当 Float32Array 看：tar 里切出来的
 * Buffer 是视图，byteOffset 不一定 4 字节对齐，而 Float32Array 要求对齐。
 */
export function parseFeatureBin(buf: Buffer): FeatureSeries {
  if (buf.length === 0) throw new Error("特征文件为空");
  if (buf.length % 4 !== 0) throw new Error(`特征文件长度不是 4 的倍数：${buf.length}`);

  const total = buf.length / 4;
  const all = new Float32Array(total);
  for (let i = 0; i < total; i++) all[i] = buf.readFloatLE(i * 4);

  const startIndex = all[0] as number;
  if (!Number.isInteger(startIndex) || startIndex < 0) {
    throw new Error(`特征文件头部不是合法的日历起始索引：${startIndex}`);
  }
  return { startIndex, values: all.subarray(1) };
}

export type Market = "sh" | "sz" | "bj";

/** 板块归属。指数单列，避免混进个股股票池。 */
export type Board = "main" | "growth" | "star" | "bj" | "index";

export type ParsedSymbol = {
  market: Market;
  /** 6 位数字代码 */
  code: string;
  board: Board;
  /** `features/` 下的目录名（小写符号） */
  dirName: string;
};

/**
 * 把 Qlib 符号（大写，如 `SH600519`）解析为项目领域口径。
 *
 * 板块判定只看前缀，不查表：沪深两市的 `000001` 同时是上证指数与平安银行，
 * 所以必须先看市场再看代码。
 */
export function parseQlibSymbol(symbol: string): ParsedSymbol {
  const upper = symbol.trim().toUpperCase();
  const market = upper.slice(0, 2).toLowerCase();
  const code = upper.slice(2);
  if (market !== "sh" && market !== "sz" && market !== "bj") {
    throw new Error(`无法识别的 Qlib 符号：${symbol}`);
  }
  if (!/^\d{6}$/.test(code)) {
    throw new Error(`无法识别的 Qlib 符号：${symbol}`);
  }
  return {
    market: market as Market,
    code,
    board: classifyBoard(market as Market, code),
    dirName: upper.toLowerCase(),
  };
}

function classifyBoard(market: Market, code: string): Board {
  if (market === "sh" && /^(000|950|880)/.test(code)) return "index";
  if (market === "sz" && /^399/.test(code)) return "index";
  if (market === "bj") return "bj";
  if (market === "sh") return /^688/.test(code) ? "star" : "main";
  return /^(300|301)/.test(code) ? "growth" : "main";
}

/** 成交额字段以**千元**存储、成交量字段是因子缩放过的（见文件头注释）。 */
export const AMOUNT_UNIT_YUAN = 1000;

/** 不复权价 = 缩放价 / 因子。因子为 0 或非有限值时视为不可用。 */
export function toRawPrice(scaled: number, factor: number): number | null {
  if (!Number.isFinite(scaled) || !Number.isFinite(factor) || factor === 0) return null;
  const raw = scaled / factor;
  return Number.isFinite(raw) ? raw : null;
}

/** 不复权成交量（手）= 缩放成交量 × 因子。 */
export function toRawVolume(scaledVolume: number, factor: number): number | null {
  if (!Number.isFinite(scaledVolume) || !Number.isFinite(factor)) return null;
  const raw = scaledVolume * factor;
  return Number.isFinite(raw) ? raw : null;
}

/** 成交额（元）= 缩放成交额 × 1000。 */
export function toRawAmount(scaledAmount: number): number | null {
  if (!Number.isFinite(scaledAmount)) return null;
  return scaledAmount * AMOUNT_UNIT_YUAN;
}

/** `YYYY-MM-DD` → `YYYYMMDD` 整数（库内日期键）。 */
export function toDateKey(date: string): number {
  const key = Number(date.replace(/-/g, ""));
  if (!Number.isInteger(key) || key <= 0) throw new Error(`无法识别的交易日：${date}`);
  return key;
}

/** `YYYYMMDD` 整数 → `YYYY-MM-DD`。 */
export function fromDateKey(key: number): string {
  const text = String(key);
  if (text.length !== 8) throw new Error(`无法识别的日期键：${key}`);
  return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
}

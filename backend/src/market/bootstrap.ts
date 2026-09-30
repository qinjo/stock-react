/**
 * 从 Qlib 归档灌库的流水线。
 *
 * 与 `qlib.ts` / `untar.ts` 的分工：那两个是纯函数，这里是**面向文件的编排**——
 * 它触碰磁盘（读归档、写库），但不触网。下载与 sha256 校验留在 CLI 脚本里，
 * 于是这条流水线可以用合成的最小归档端到端测试（见 `test/bootstrap.test.ts`）。
 *
 * 读归档分两趟：`calendars/` 与 `instruments/` 是解析特征的前提，而 tar 成员的
 * 先后顺序不是我们能保证的约定。归档已在磁盘上，多解压一趟换掉一个隐含假设。
 */
import { createReadStream } from "node:fs";
import { createGunzip } from "node:zlib";
import {
  QLIB_QUOTE_FIELDS,
  parseCalendar,
  parseFeatureBin,
  parseInstruments,
  parseQlibSymbol,
  toDateKey,
  toRawAmount,
  toRawPrice,
  toRawVolume,
  type QlibQuoteField,
} from "./qlib.js";
import type { BarRow, IndexBarRow, InstrumentRow, MarketStore } from "./store.js";
import { readTar, stripTopLevelDir, type TarEntry } from "./untar.js";

/** 每写多少只标的一次事务提交（太长会把回滚日志撑大）。 */
const COMMIT_EVERY = 300;

export type BootstrapStats = {
  calendarFirst: string;
  latestDate: string;
  tradingDays: number;
  /** 清单里的标的数 */
  instruments: number;
  /** 截止日等于最新交易日 → 仍在交易 */
  liveInstruments: number;
  /** 真正写了日线的标的数 */
  instrumentsWritten: number;
  /** 因价格/成交量不可用而跳过的 bar 数 */
  barsSkipped: number;
  /** 归档里出现但清单中没有的目录数 */
  unknownDirs: number;
  /** 字段不齐、因此从未写库的标的数（静默丢数据比报错更危险，所以显式统计） */
  incompleteInstruments: number;
  barCount: number;
};

export type PreparedArchive = {
  calendar: string[];
  instruments: ReturnType<typeof parseInstruments>;
  sinceKey: number;
  latestDate: string;
};

async function* entriesOf(tarPath: string): AsyncGenerator<TarEntry> {
  yield* readTar(createReadStream(tarPath).pipe(createGunzip()));
}

/**
 * 从 GitHub 的 302 跳转地址里取出 release tag。
 *
 * 必须用**未跟随跳转**的那一次响应：一旦跟随，最终地址会变成带签名的
 * release-assets.githubusercontent.com 链接，tag 就不在里面了。
 */
export function parseReleaseTag(location: string): string {
  const match = location.match(/\/releases\/download\/([^/]+)\//);
  if (!match) throw new Error(`无法从跳转地址解析 tag：${location}`);
  return match[1] as string;
}

/** 归档成员名的形状：`features/<小写符号>/<字段>.day.bin`。 */export function parseFeaturePath(rest: string): { dirName: string; field: QlibQuoteField } | null {
  const match = rest.match(/^features\/([a-z0-9]+)\/([a-z_]+)\.day\.bin$/);
  if (!match) return null;
  const field = match[2] as QlibQuoteField;
  if (!QLIB_QUOTE_FIELDS.includes(field)) return null;
  return { dirName: match[1] as string, field };
}

/** 第一趟：只取日历与标的清单，拿到就提前结束，不必读完整个归档。 */
export async function readCalendarAndInstruments(
  tarPath: string,
  years: number,
): Promise<PreparedArchive> {
  let calendar: string[] | null = null;
  let instruments: ReturnType<typeof parseInstruments> | null = null;

  for await (const entry of entriesOf(tarPath)) {
    const rest = stripTopLevelDir(entry.name);
    if (!rest) continue;
    if (rest === "calendars/day.txt") calendar = parseCalendar(entry.data.toString("utf8"));
    else if (rest === "instruments/all.txt") {
      instruments = parseInstruments(entry.data.toString("utf8"));
    }
    if (calendar && instruments) break;
  }

  if (!calendar || calendar.length === 0) throw new Error("归档里没有可用的交易日历");
  if (!instruments || instruments.length === 0) throw new Error("归档里没有标的清单");

  const latestDate = calendar[calendar.length - 1] as string;
  const since = `${Number(latestDate.slice(0, 4)) - years}${latestDate.slice(4)}`;
  return { calendar, instruments, sinceKey: toDateKey(since), latestDate };
}

/** 清单 → 标的行（同代码只保留一条：归档中有重复符号时以先到者为准）。 */
export function buildInstrumentRows(
  instruments: ReturnType<typeof parseInstruments>,
  latestDate: string,
): Map<string, InstrumentRow> {
  const meta = new Map<string, InstrumentRow>();
  for (const item of instruments) {
    const parsed = parseQlibSymbol(item.symbol);
    const row: InstrumentRow = {
      code: parsed.code,
      market: parsed.market,
      board: parsed.board,
      name: null,
      listedStart: toDateKey(item.start),
      listedEnd: toDateKey(item.end),
      isLive: item.end === latestDate,
    };
    meta.set(parsed.dirName, row);
  }
  return meta;
}

/**
 * 把一只标的的 7 条序列拼成 bar 行。
 * 各序列必须共享同一段日历——不一致说明归档有问题，直接抛错而不是猜。
 */
export function buildBars(
  dirName: string,
  fields: Map<QlibQuoteField, Buffer>,
  calendar: string[],
  sinceKey: number,
): { bars: BarRow[]; skipped: number } {
  const parsed = new Map<QlibQuoteField, ReturnType<typeof parseFeatureBin>>();
  for (const field of QLIB_QUOTE_FIELDS) {
    const buf = fields.get(field);
    if (!buf) throw new Error(`${dirName} 缺少字段 ${field}`);
    parsed.set(field, parseFeatureBin(buf));
  }

  const close = parsed.get("close") as ReturnType<typeof parseFeatureBin>;
  const { startIndex, values } = close;
  const length = values.length;
  for (const [field, series] of parsed) {
    if (series.startIndex !== startIndex || series.values.length !== length) {
      throw new Error(
        `${dirName} 的 ${field} 与 close 不同步：` +
          `start ${series.startIndex}/${startIndex}，length ${series.values.length}/${length}`,
      );
    }
  }

  const value = (field: QlibQuoteField, i: number): number =>
    (parsed.get(field) as ReturnType<typeof parseFeatureBin>).values[i] as number;

  const bars: BarRow[] = [];
  let skipped = 0;
  for (let i = 0; i < length; i++) {
    const date = calendar[startIndex + i];
    if (date === undefined) {
      skipped++;
      continue;
    }
    const dateKey = toDateKey(date);
    if (dateKey < sinceKey) continue;

    const factor = value("factor", i);
    const open = toRawPrice(value("open", i), factor);
    const high = toRawPrice(value("high", i), factor);
    const low = toRawPrice(value("low", i), factor);
    const rawClose = toRawPrice(values[i] as number, factor);
    const volume = toRawVolume(value("volume", i), factor);
    const amount = toRawAmount(value("amount", i));

    if (
      open === null ||
      high === null ||
      low === null ||
      rawClose === null ||
      volume === null ||
      amount === null
    ) {
      skipped++;
      continue;
    }
    bars.push({
      date: dateKey,
      open,
      high,
      low,
      close: rawClose,
      volume,
      amount,
      adjFactor: factor,
    });
  }
  return { bars, skipped };
}

/** 第二趟：把特征流式写进已经建好表的库。 */
export async function ingestFeatures(
  store: MarketStore,
  tarPath: string,
  prepared: PreparedArchive,
  meta: Map<string, InstrumentRow>,
): Promise<
  Pick<
    BootstrapStats,
    "instrumentsWritten" | "barsSkipped" | "unknownDirs" | "incompleteInstruments"
  >
> {
  const { calendar, sinceKey } = prepared;
  const stats = {
    instrumentsWritten: 0,
    barsSkipped: 0,
    unknownDirs: 0,
    incompleteInstruments: 0,
  };
  // 排序正常时这里只驻留 1 只标的；若归档按字段而非按标的排序，最坏会涨到清单规模（约几百 MB），可接受
  const inFlight = new Map<string, Map<QlibQuoteField, Buffer>>();
  let open = false;
  let sinceCommit = 0;
  let lastLog = Date.now();

  const openIfNeeded = (): void => {
    if (!open) {
      store.begin();
      open = true;
    }
  };
  const commitIfNeeded = (force = false): void => {
    if (open && (force || sinceCommit >= COMMIT_EVERY)) {
      store.commit();
      open = false;
      sinceCommit = 0;
    }
  };

  try {
    for await (const entry of entriesOf(tarPath)) {
      const rest = stripTopLevelDir(entry.name);
      if (!rest) continue;
      const located = parseFeaturePath(rest);
      if (!located) continue;

      const row = meta.get(located.dirName);
      if (!row) {
        stats.unknownDirs++;
        continue;
      }

      let fields = inFlight.get(located.dirName);
      if (!fields) {
        fields = new Map();
        inFlight.set(located.dirName, fields);
      }
      // entry.data 是动态缓冲区上的视图，下一轮迭代就可能被复用 → 复制一份再持有
      fields.set(located.field, Buffer.from(entry.data));
      if (fields.size < QLIB_QUOTE_FIELDS.length) continue;
      inFlight.delete(located.dirName);

      const { bars, skipped } = buildBars(located.dirName, fields, calendar, sinceKey);
      stats.barsSkipped += skipped;
      if (bars.length > 0) {
        openIfNeeded();
        if (row.board === "index") {
          store.insertIndexBars(
            located.dirName,
            bars.map<IndexBarRow>((b) => ({
              date: b.date,
              open: b.open,
              high: b.high,
              low: b.low,
              close: b.close,
              volume: b.volume,
            })),
          );
        } else {
          store.insertBars(row.code, bars);
        }
        stats.instrumentsWritten++;
        sinceCommit++;
      }
      commitIfNeeded();

      if (Date.now() - lastLog > 5000) {
        lastLog = Date.now();
        console.log(`  … 已写入 ${stats.instrumentsWritten} 只`);
      }
    }
    commitIfNeeded(true);
  } catch (err) {
    if (open) store.rollback();
    throw err;
  }
  if (open) store.commit();
  // 收尾时仍留在手上的，就是字段不齐、永远凑不齐 7 条的标的
  stats.incompleteInstruments = inFlight.size;
  return stats;
}

/**
 * 端到端灌库：库必须已经 `migrate()`（是否 `optimizeForBulkLoad()` 由调用方决定，
 * 因为那会牺牲耐久性）。
 */
export async function ingestArchive(
  store: MarketStore,
  tarPath: string,
  years: number,
): Promise<BootstrapStats> {
  const prepared = await readCalendarAndInstruments(tarPath, years);
  const meta = buildInstrumentRows(prepared.instruments, prepared.latestDate);

  const byCode = new Map<string, InstrumentRow>();
  for (const row of meta.values()) if (!byCode.has(row.code)) byCode.set(row.code, row);
  const allRows = [...byCode.values()];
  for (let i = 0; i < allRows.length; i += COMMIT_EVERY) {
    const chunk = allRows.slice(i, i + COMMIT_EVERY);
    store.transaction(() => store.upsertInstruments(chunk));
  }

  const featureStats = await ingestFeatures(store, tarPath, prepared, meta);

  return {
    calendarFirst: prepared.calendar[0] as string,
    latestDate: prepared.latestDate,
    tradingDays: prepared.calendar.length,
    instruments: allRows.length,
    liveInstruments: allRows.filter((r) => r.isLive).length,
    ...featureStats,
    barCount: store.countBars(),
  };
}

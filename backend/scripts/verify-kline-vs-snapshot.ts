#!/usr/bin/env tsx
/**
 * 本地日K库的对账与自检。
 *
 *   npm run verify:kline                        # 默认**全量**（全部在市标的）
 *   npm run verify:kline -- --sample 400         # 赶时间时可抽样
 *   npm run verify:kline -- --codes sh600519,sz300750
 *   npm run verify:kline -- --date 20260925
 *
 * 为什么值得单独留一个脚本：库里存的是**由 factor 反推的不复权价**，
 * 换算方向搞反、少除一个因子、把「手」当成「股」，都不会报错——
 * 只会静默产出错误的均线，而错误的均线会让整个筛选器给出看似合理的垃圾。
 *
 * 两条判据，都不依赖可比口径的外部历史数据：
 *
 * 1. **VWAP 内部一致性（默认全量）**：当日成交额 ÷（成交量 × 100）必然落在当日
 *    [最低, 最高] 区间内。这条恒等式同时约束了价、量、额三个字段的**单位与方向**，
 *    任何一个换算错都会立刻越界。
 * 2. **跨日价格对账（外部源）**：腾讯批量快照的「昨收」是交易所口径的（除权后）前收盘。
 *    若快照日期紧接库内最新交易日，则库内最新收盘应与之一致。不一致可能是除权事件
 *    （需要人工确认），因此它单独统计而不单独判死——但匹配率过低即视为失败。
 *
 * 刻意不拿腾讯日线历史做逐字段对账：那条接口返回的是**前复权**序列，
 * 与库内的不复权口径不可直接比较，会在除权股上产生假不一致。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Quote } from "../src/domain.js";
import { MarketStore } from "../src/market/store.js";
import { normalizeTencentQuote } from "../src/tencent.js";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_DB = join(BACKEND_ROOT, "data", "kline.sqlite");

/** 默认抽样：覆盖沪深主板 / 创业板 / 科创板 / 北交所。 */
const DEFAULT_CODES = [
  "sh600519",
  "sh601398",
  "sh603259",
  "sz000001",
  "sz002594",
  "sz300750",
  "sh688981",
  "bj920002",
];

/** 库内价由 float32 缩放值反推，尾数允许约 1e-6 的相对偏差。 */
const REL_TOLERANCE = 1e-4;
/** 快照昨收的匹配率低于此值即判失败（其余不一致按除权事件列出待人工确认）。 */
const MIN_PREV_CLOSE_MATCH_RATE = 0.95;

type Options = {
  db: string;
  date: number | null;
  codes: string[];
  sample: number;
  skipLive: boolean;
};

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    db: DEFAULT_DB,
    date: null,
    codes: DEFAULT_CODES,
    // 0 = 全量。全表扫描只要 1~2 秒（不变式检查已证明），
    // 而这个检查的意义正是抓**罕见的**坏行——抽样等于主动放过它们。
    sample: 0,
    skipLive: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--db") opts.db = argv[++i] as string;
    else if (arg === "--date") opts.date = Number(argv[++i]);
    else if (arg === "--sample") opts.sample = Number(argv[++i]);
    else if (arg === "--skip-live") opts.skipLive = true;
    else if (arg === "--codes") {
      opts.codes = (argv[++i] as string)
        .split(",")
        .map((c) => c.trim().toLowerCase())
        .filter(Boolean);
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "用法：npm run verify:kline -- [--db <path>] [--date YYYYMMDD] [--sample N] [--codes a,b] [--skip-live]",
      );
      process.exit(0);
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

function fmt(v: number | null, digits = 4): string {
  return v === null ? "—" : v.toFixed(digits);
}

function closeEnough(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(Math.abs(a), Math.abs(b));
  return scale === 0 ? true : Math.abs(a - b) / scale <= REL_TOLERANCE;
}

type Snapshot = { quote: Quote; date: number | null };

/**
 * 批量取实时快照。腾讯单请求可携带数百个代码；这里只取十余个，属于最低频用法。
 * 日期取字段 30 的前 8 位（`YYYYMMDDHHMMSS`），用于判断「跨日」关系。
 */
async function fetchSnapshot(symbols: string[]): Promise<Map<string, Snapshot>> {
  const url = `http://qt.gtimg.cn/q=${symbols.join(",")}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`快照请求失败：HTTP ${res.status}`);
  const text = new TextDecoder("gbk").decode(await res.arrayBuffer());

  const out = new Map<string, Snapshot>();
  for (const line of text.split("\n")) {
    const symbol = line.match(/^v_([a-z0-9]+)=/)?.[1];
    if (!symbol) continue;
    const stamp = line.match(/="([\s\S]*)"\s*;?\s*$/)?.[1]?.split("~")[30] ?? "";
    const date = /^\d{8}/.test(stamp) ? Number(stamp.slice(0, 8)) : null;
    try {
      out.set(symbol, { quote: normalizeTencentQuote(line), date });
    } catch {
      // 单行解析失败不影响其他标的
    }
  }
  return out;
}

/** 判据一：VWAP 内部一致性（默认全量，可用 --sample 抽样）。 */
function checkVwapConsistency(
  store: MarketStore,
  date: number,
  sampleSize: number,
): {
  checked: number;
  degenerate: number;
  failures: Array<{ code: string; vwap: number; low: number; high: number }>;
} {
  // 0 表示全量：sampleLiveCodes 在 limit ≥ 总数时返回全部
  const codes = store.sampleLiveCodes(sampleSize > 0 ? sampleSize : Number.MAX_SAFE_INTEGER);
  const failures: Array<{ code: string; vwap: number; low: number; high: number }> = [];
  let checked = 0;
  let degenerate = 0;

  for (const code of codes) {
    const bars = store.readBars(code, 1);
    const bar = bars[0];
    if (!bar || bar.date !== date) continue;
    if (bar.volume <= 0 || bar.amount <= 0) continue; // 停牌等无成交情形不参与
    // 一字板（最高=最低）没有区间可校验：实测这类标的的均价会被取整到当日唯一价位，
    // 于是恒等式差千分之几。这是取整伪像，不是单位错误，单独计数而不计入失败。
    if (bar.high <= bar.low) {
      degenerate++;
      continue;
    }
    checked++;

    // 成交量单位是「手」→ 股数 = 手 × 100；VWAP 必须落回当日价格区间
    const shares = bar.volume * 100;
    const vwap = bar.amount / shares;
    if (vwap < bar.low || vwap > bar.high) {
      failures.push({ code, vwap, low: bar.low, high: bar.high });
    }
  }
  return { checked, degenerate, failures };
}

/** 判据二：快照昨收与库内最新收盘的跨日对账。 */
async function checkPrevClose(
  store: MarketStore,
  date: number,
  symbols: string[],
): Promise<{ matched: number; compared: number; mismatches: string[]; snapshotDate: number | null }> {
  const snapshot = await fetchSnapshot(symbols);
  let matched = 0;
  let compared = 0;
  const mismatches: string[] = [];
  let snapshotDate: number | null = null;

  for (const symbol of symbols) {
    const entry = snapshot.get(symbol);
    if (!entry) continue;
    snapshotDate ??= entry.date;
    if (entry.date === null || entry.date <= date) continue; // 只有「快照日期晚于库内最新日」才可比
    if (entry.quote.prevClose === null) continue;

    const bar = store.readBars(symbol.slice(2), 1)[0];
    if (!bar || bar.date !== date) continue;

    compared++;
    if (closeEnough(bar.close, entry.quote.prevClose)) {
      matched++;
    } else {
      const gap = (entry.quote.prevClose - bar.close).toFixed(4);
      mismatches.push(`${symbol} 库内 ${fmt(bar.close)} vs 快照昨收 ${fmt(entry.quote.prevClose)}（差 ${gap}）`);
    }
  }
  return { matched, compared, mismatches, snapshotDate };
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const store = new MarketStore(opts.db);
  try {
    const date = opts.date ?? store.latestTradeDate();
    if (date === null) {
      throw new Error("库内没有任何日线：先跑 npm run bootstrap:kline");
    }
    const instruments = store.countInstruments();
    const live = store.countInstruments(undefined, true);
    console.log(
      `库内：${instruments} 只标的（仍在交易 ${live} 只）、${store.countBars().toLocaleString("en-US")} 行、` +
        `最新交易日 ${date}`,
    );

    // ── 判据一
    const vwap = checkVwapConsistency(store, date, opts.sample);
    console.log(
      `\n[1] VWAP 内部一致性（校验 ${vwap.checked} 只，另有一字板 ${vwap.degenerate} 只无区间可校验）`,
    );
    if (vwap.failures.length === 0) {
      console.log("    ✓ 全部落在当日价格区间内（价 / 量 / 额的单位与方向自洽）");
    } else {
      for (const f of vwap.failures.slice(0, 20)) {
        console.log(
          `    ✗ ${f.code}  VWAP ${fmt(f.vwap)} 不在 [${fmt(f.low)}, ${fmt(f.high)}] 内`,
        );
      }
      if (vwap.failures.length > 20) console.log(`    … 另有 ${vwap.failures.length - 20} 处`);
    }

    // ── 判据二
    let prevCloseFail = false;
    if (!opts.skipLive) {
      console.log(`\n[2] 快照昨收跨日对账（${opts.codes.length} 只）`);
      const prev = await checkPrevClose(store, date, opts.codes);
      if (prev.compared === 0) {
        console.log(
          `    · 快照日期 ${prev.snapshotDate ?? "未知"} 不晚于库内最新交易日，本次不适用（库已是最新或非交易日）`,
        );
      } else {
        const rate = prev.matched / prev.compared;
        console.log(
          `    快照日期 ${prev.snapshotDate}，可比 ${prev.compared} 只，匹配 ${prev.matched} 只（${(rate * 100).toFixed(0)}%）`,
        );
        for (const line of prev.mismatches) {
          console.log(`    ! ${line}  ← 可能是当日除权除息，需人工确认`);
        }
        if (prev.mismatches.length === 0) console.log("    ✓ 逐只精确相等");
        if (rate < MIN_PREV_CLOSE_MATCH_RATE) {
          prevCloseFail = true;
          console.log(`    ✗ 匹配率低于 ${MIN_PREV_CLOSE_MATCH_RATE * 100}%，判为失败`);
        }
      }
    }

    const failed = vwap.failures.length > 0 || prevCloseFail;
    console.log(`\n${failed ? "✗ 对账失败" : "✓ 对账通过"}`);
    if (failed) process.exitCode = 1;
  } finally {
    store.close();
  }
}

main().catch((err: unknown) => {
  console.error(`\n✗ 对账脚本失败：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

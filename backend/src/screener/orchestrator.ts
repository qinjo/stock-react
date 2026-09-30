import type { MarketStore } from "../market/store.js";
import type { IncrementStats } from "../market/increment.js";
import { PromptCache } from "../cache.js";
import { screenUniverse } from "./engine.js";
import { loadUniverseFromStore } from "./load.js";
import { toScreenResponse, type ScreenRequestParams, type ScreenResponse } from "./response.js";
import type { ScreenerCriteria } from "./types.js";

/**
 * 筛选编排：惰性刷新 + 当日缓存 + 全市场遍历。
 *
 * 两件事在这里接上，它们各自单独存在时都没什么用：
 * 1. **惰性刷新**——增量已经能跑，但在本票之前没有任何东西会调用它。
 *    筛选前先比对"库内最新交易日"与"今天的交易日"，落后就先补当日行情再筛。
 * 2. **当日缓存**——全市场遍历约 5 秒且每次重读七百万行，
 *    同一天同一组参数的重复点击没有理由再算一遍。
 *
 * 增量失败**不阻断筛选**：本地已有数据，外部源临时不可用不该让整个功能变砖，
 * 但必须在响应里如实标注，否则用户会以为看到的是最新数据。
 */

export type IncrementSummary = {
  /** 是否真的尝试了增量 */
  ran: boolean;
  /** 增量是否失败（失败时沿用库内既有数据继续筛选） */
  failed: boolean;
  error: string | null;
  snapshotDate: number | null;
  barsWritten: number;
  barsRefreshed: number;
  exDividends: number;
  namesUpdated: number;
  marketCapsUpdated: number;
  skippedTotal: number;
  durationMs: number;
};

export type ScreenRunOptions = {
  criteria: ScreenerCriteria;
  params: ScreenRequestParams;
  limit: number;
  /** 强制刷新：绕过结果缓存，并忽略增量的节流 */
  refresh: boolean;
};

export type ScreenRunDeps = {
  openStore: () => MarketStore;
  /**
   * 增量入口。**刻意必填**：给它一个"真实网络"的默认值，
   * 会让任何忘记注入的调用（尤其测试）在无声中打出去十几个请求。
   */
  runIncrement: (store: MarketStore) => Promise<IncrementStats>;
  now?: () => Date;
  /** 结果缓存（跨请求共享） */
  cache?: PromptCache<{ response: ScreenResponse }>;
  /**
   * 距上次增量尝试不足该毫秒数就不再尝试。
   * 没有它的话，休市/节假日里每次点击都会白打十几个请求——数据源不会因此更新。
   */
  incrementThrottleMs?: number;
};

export type ScreenRunResult =
  | { kind: "ok"; response: ScreenResponse; fromCache: boolean; increment: IncrementSummary }
  /** 库存在但没有日线：这是"你还没初始化"，由路由映射成 DATA_NOT_READY 而不是造一条空结果 */
  | { kind: "empty" };

const DEFAULT_THROTTLE_MS = 15 * 60 * 1000;

/** 按上海时区取"今天"的日期键；用 UTC 取会在北京时间凌晨/清晨错一天。 */
export function shanghaiDateKey(now: Date): number {
  const text = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  return Number(text.replace(/-/g, ""));
}

/**
 * 数据指纹：用 O(1) 的元数据而不是 `COUNT(*)` 去汇总七百万行。
 * `last_increment_at` 每次增量都会刷新，因此任何一次数据变化都会改变指纹。
 */
export function cacheFingerprint(store: MarketStore): string {
  return [
    store.latestTradeDate() ?? "none",
    store.getMeta("last_increment_at") ?? "never",
    store.countInstruments(),
  ].join("|");
}

function summarize(
  stats: IncrementStats | null,
  failed: boolean,
  error: string | null,
  durationMs: number,
): IncrementSummary {
  return {
    ran: stats !== null,
    failed,
    error,
    snapshotDate: stats?.snapshotDate ?? null,
    barsWritten: stats?.barsWritten ?? 0,
    barsRefreshed: stats?.barsRefreshed ?? 0,
    exDividends: stats?.exDividends ?? 0,
    namesUpdated: stats?.namesUpdated ?? 0,
    marketCapsUpdated: stats?.marketCapsUpdated ?? 0,
    skippedTotal: stats ? Object.values(stats.skipped).reduce((a, b) => a + b, 0) : 0,
    durationMs,
  };
}

export async function runScreen(
  options: ScreenRunOptions,
  deps: ScreenRunDeps,
): Promise<ScreenRunResult> {
  const now = deps.now ?? (() => new Date());
  const doIncrement = deps.runIncrement;
  const throttleMs = deps.incrementThrottleMs ?? DEFAULT_THROTTLE_MS;

  const store = deps.openStore();
  try {
    const before = store.latestTradeDate();
    if (before === null) return { kind: "empty" };

    // ---- 惰性刷新：库落后于今天就先补当日行情 ----
    const today = shanghaiDateKey(now());
    const lastAttempt = Number(store.getMeta("last_increment_attempt_at") ?? 0);
    const throttled = !options.refresh && now().getTime() - lastAttempt < throttleMs;
    const shouldRefresh = options.refresh || (before < today && !throttled);

    let stats: IncrementStats | null = null;
    let incrementFailed = false;
    let incrementError: string | null = null;
    const incrementStarted = now().getTime();

    if (shouldRefresh) {
      store.setMeta("last_increment_attempt_at", String(now().getTime()));
      try {
        stats = await doIncrement(store);
      } catch (err) {
        // 外部源临时不可用不该让整个功能变砖：本地数据还在，照常出结果但如实标注
        incrementFailed = true;
        incrementError = err instanceof Error ? err.message : String(err);
      }
    }

    const dataDateKey = store.latestTradeDate() ?? before;
    const fingerprint = cacheFingerprint(store);
    const cacheKey = PromptCache.keyFor(
      "screen",
      [
        dataDateKey,
        options.criteria.mode,
        options.criteria.strictness,
        options.params.boards.join(","),
        options.criteria.includeBeijing,
        options.params.ignoreMarketGate,
        fingerprint,
      ].join("|"),
    );

    // 强制刷新要真的重算：先清掉这一条，避免命中上一次的结果
    if (options.refresh) deps.cache?.delete(cacheKey);
    const cached = options.refresh ? undefined : deps.cache?.get(cacheKey);
    if (cached && !stats) {
      return {
        kind: "ok",
        response: cached.response,
        fromCache: true,
        increment: summarize(null, false, null, 0),
      };
    }

    const allowed = new Set(options.params.boards);
    const outcome = screenUniverse(
      loadUniverseFromStore(store, { codeFilter: (row) => allowed.has(row.board) }),
      options.criteria,
    );

    const names = new Map(store.listInstruments().map((row) => [row.code, row.name] as const));
    const response = toScreenResponse(outcome, {
      dataDateKey,
      refreshedAt: now(),
      params: options.params,
      limit: options.limit,
      nameOf: (code) => names.get(code) ?? null,
    });

    deps.cache?.set(cacheKey, { response });

    return {
      kind: "ok",
      response,
      fromCache: false,
      increment: summarize(stats, incrementFailed, incrementError, now().getTime() - incrementStarted),
    };
  } finally {
    store.close();
  }
}


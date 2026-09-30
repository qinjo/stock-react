import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import type { Board } from "../market/qlib.js";
import type { ChatFn } from "../analysis/llm.js";
import type { IncrementStats } from "../market/increment.js";
import { MarketDataNotReadyError, openMarketStore } from "../market/open.js";
import type { MarketStore } from "../market/store.js";
import type { PromptCache } from "../cache.js";
import { runScreen, type IncrementSummary } from "../screener/orchestrator.js";
import type { ScreenRequestParams, ScreenResponse } from "../screener/response.js";
import type { ScreenerCriteria, ScreenerMode, Strictness } from "../screener/types.js";

/**
 * 筛选路由：`GET /api/screen`。
 *
 * 错误契约：
 * - 参数非法 → `INVALID_INPUT`(400)
 * - 本地库不存在或为空 → `DATA_NOT_READY`(503)，**刻意不同于** `SOURCE_UNAVAILABLE`：
 *   后者是"外部数据源挂了"，前者是"你还没做初始化"，用户要采取的动作完全不同
 * - 增量失败**不**报错：本地数据还在，照常出结果，但响应里如实标注 `increment.failed`
 */

const MODES: readonly ScreenerMode[] = ["trend", "event"];
const STRICTNESS_LEVELS: readonly Strictness[] = ["loose", "standard", "strict"];
const ALL_BOARDS: readonly Board[] = ["main", "growth", "star", "bj"];
const DEFAULT_BOARDS: readonly Board[] = ["main", "growth", "star"];
// 产品承诺是「筛出至多 10 只供选择」，默认值必须与之一致
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 100;

export type ScreenerRouteDeps = {
  /** 打开日K库；默认从默认路径打开，测试注入临时库 */
  openStore?: () => MarketStore;
  /** 增量入口；刻意必填，避免"忘记注入就悄悄打网络"（见编排层注释） */
  runIncrement: (store: MarketStore) => Promise<IncrementStats>;
  now?: () => Date;
  /** 结果缓存（跨请求共享） */
  cache?: PromptCache<{ response: ScreenResponse }>;
  /** 大模型复核入口；为 null 表示未配置密钥（自动降级，不阻断筛选） */
  chat?: ChatFn | null;
  incrementThrottleMs?: number;
};

type ScreenQuery = {
  mode?: string;
  strictness?: string;
  boards?: string;
  limit?: string;
  ignoreMarketGate?: string;
  refresh?: string;
};

function oneOf<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  label: string,
): T {
  if (raw === undefined || raw === "") return fallback;
  if (!allowed.includes(raw as T)) {
    throw new ApiError("INVALID_INPUT", `${label} 只能是 ${allowed.join(" / ")}，收到「${raw}」`, 400);
  }
  return raw as T;
}

function parseBoolean(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined || raw === "") return fallback;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError("INVALID_INPUT", `布尔参数只能是 true / false，收到「${raw}」`, 400);
}

export function parseScreenQuery(query: ScreenQuery): {
  params: ScreenRequestParams;
  criteria: ScreenerCriteria;
  limit: number;
} {
  const mode = oneOf(query.mode, MODES, "trend", "mode");
  const strictness = oneOf(query.strictness, STRICTNESS_LEVELS, "standard", "strictness");

  let boards: Board[] = [...DEFAULT_BOARDS];
  if (query.boards !== undefined && query.boards !== "") {
    const requested = query.boards
      .split(",")
      .map((b) => b.trim().toLowerCase())
      .filter((b) => b.length > 0);
    for (const board of requested) {
      if (!ALL_BOARDS.includes(board as Board)) {
        throw new ApiError(
          "INVALID_INPUT",
          `boards 只能取 ${ALL_BOARDS.join(" / ")}，收到「${board}」`,
          400,
        );
      }
    }
    if (requested.length === 0) {
      throw new ApiError("INVALID_INPUT", "boards 不能为空", 400);
    }
    boards = requested as Board[];
  }

  const rawLimit = query.limit === undefined || query.limit === "" ? DEFAULT_LIMIT : Number(query.limit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    throw new ApiError("INVALID_INPUT", `limit 必须是正整数，收到「${query.limit}」`, 400);
  }

  const params: ScreenRequestParams = {
    mode,
    strictness,
    boards,
    ignoreMarketGate: parseBoolean(query.ignoreMarketGate),
    refresh: parseBoolean(query.refresh),
  };

  return {
    params,
    criteria: {
      mode,
      strictness,
      includeBeijing: boards.includes("bj"),
      ignoreMarketGate: params.ignoreMarketGate,
    },
    limit: Math.min(rawLimit, MAX_LIMIT),
  };
}

export type ScreenRouteResponse = ScreenResponse & {
  fromCache: boolean;
  increment: IncrementSummary;
};

export async function screenerRoutes(app: FastifyInstance, deps: ScreenerRouteDeps): Promise<void> {
  const openStore = deps.openStore ?? (() => openMarketStore());
  const now = deps.now ?? (() => new Date());

  app.get<{ Querystring: ScreenQuery }>("/api/screen", async (req) => {
    const { params, criteria, limit } = parseScreenQuery(req.query);

    let result: Awaited<ReturnType<typeof runScreen>>;
    try {
      result = await runScreen(
        { criteria, params, limit, refresh: params.refresh },
        {
          openStore,
          runIncrement: deps.runIncrement,
          ...(deps.chat !== undefined ? { chat: deps.chat } : {}),
          now,
          ...(deps.cache ? { cache: deps.cache } : {}),
          ...(deps.incrementThrottleMs !== undefined
            ? { incrementThrottleMs: deps.incrementThrottleMs }
            : {}),
        },
      );
    } catch (err) {
      if (err instanceof MarketDataNotReadyError) {
        throw new ApiError(
          "DATA_NOT_READY",
          `${err.message}。请先运行 npm run bootstrap:kline`,
          503,
        );
      }
      throw err;
    }

    if (result.kind === "empty") {
      throw new ApiError("DATA_NOT_READY", "本地日K库是空的。请先运行 npm run bootstrap:kline", 503);
    }

    const body: ScreenRouteResponse = {
      ...result.response,
      fromCache: result.fromCache,
      increment: result.increment,
    };
    return body;
  });
}

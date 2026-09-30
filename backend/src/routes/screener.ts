import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import type { Board } from "../market/qlib.js";
import { MarketDataNotReadyError, openMarketStore } from "../market/open.js";
import type { MarketStore } from "../market/store.js";
import { screenUniverse } from "../screener/engine.js";
import { loadUniverseFromStore } from "../screener/load.js";
import { toScreenResponse, type ScreenRequestParams } from "../screener/response.js";
import type { ScreenerCriteria, ScreenerMode, Strictness } from "../screener/types.js";

/**
 * 筛选路由：`GET /api/screen`。
 *
 * 错误契约：
 * - 参数非法 → `INVALID_INPUT`(400)
 * - 本地库不存在或为空 → `DATA_NOT_READY`(503)，**刻意不同于** `SOURCE_UNAVAILABLE`：
 *   后者是"外部数据源挂了"，前者是"你还没做初始化"，用户要采取的动作完全不同
 * - 其他内部错误 → 由全局错误处理器兜底
 *
 * 全市场遍历是同步且 CPU 密集的（约数秒）；本期不做缓存，缓存见后续工单。
 */

const MODES: readonly ScreenerMode[] = ["trend", "event"];
const STRICTNESS_LEVELS: readonly Strictness[] = ["loose", "standard", "strict"];
const ALL_BOARDS: readonly Board[] = ["main", "growth", "star", "bj"];
const DEFAULT_BOARDS: readonly Board[] = ["main", "growth", "star"];
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export type ScreenerRouteDeps = {
  /** 打开日K库；默认从默认路径打开，测试注入临时库 */
  openStore?: () => MarketStore;
  now?: () => Date;
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

  return {
    params: {
      mode,
      strictness,
      boards,
      // 这两个参数本期只做透传与校验：大盘门覆盖见大盘门工单，强制刷新见缓存工单
      ignoreMarketGate: parseBoolean(query.ignoreMarketGate),
      refresh: parseBoolean(query.refresh),
    },
    limit: Math.min(rawLimit, MAX_LIMIT),
  };
}

export async function screenerRoutes(
  app: FastifyInstance,
  deps: ScreenerRouteDeps = {},
): Promise<void> {
  const openStore = deps.openStore ?? (() => openMarketStore());
  const now = deps.now ?? (() => new Date());

  app.get<{ Querystring: ScreenQuery }>("/api/screen", async (req) => {
    const { params, limit } = parseScreenQuery(req.query);

    let store: MarketStore;
    try {
      store = openStore();
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

    try {
      const dataDateKey = store.latestTradeDate();
      if (dataDateKey === null) {
        throw new ApiError(
          "DATA_NOT_READY",
          "本地日K库是空的。请先运行 npm run bootstrap:kline",
          503,
        );
      }

      const allowed = new Set(params.boards);
      const criteria: ScreenerCriteria = {
        mode: params.mode,
        strictness: params.strictness,
        includeBeijing: allowed.has("bj"),
      };

      const outcome = screenUniverse(
        loadUniverseFromStore(store, { codeFilter: (row) => allowed.has(row.board) }),
        criteria,
      );

      const names = new Map(store.listInstruments().map((row) => [row.code, row.name] as const));

      return toScreenResponse(outcome, {
        dataDateKey,
        refreshedAt: now(),
        params,
        limit,
        nameOf: (code) => names.get(code) ?? null,
      });
    } finally {
      store.close();
    }
  });
}

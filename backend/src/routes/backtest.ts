import type { FastifyInstance } from "fastify";
import { ApiError } from "../errors.js";
import type { PromptCache } from "../cache.js";
import { DEFAULT_BACKTEST_PARAMS } from "../backtest/params.js";
import { runBacktestAsync } from "../backtest/service.js";
import { toBacktestResponse, type BacktestResponse } from "../backtest/response.js";
import type { BacktestParams } from "../backtest/types.js";
import type { Board } from "../market/qlib.js";
import { toDateKey } from "../market/qlib.js";
import { MarketDataIncompleteError, MarketDataNotReadyError, openMarketStore } from "../market/open.js";
import type { MarketStore } from "../market/store.js";

/**
 * 回测路由：`GET /api/backtest`。
 *
 * 与 CLI 共用同一套纯函数与编排层（`backtest/service.ts`），差别只有两点：
 * 1. **分片执行**：全市场一次约 40–60 秒，这里每 200 只让出一次事件循环，
 *    避免把同进程的健康检查与行情请求一起卡死；
 * 2. **结果缓存**：键含「数据截止日 + 全部参数」，同一天同参数重复点不再重算。
 *
 * 错误契约沿用仓库惯例：
 * - 参数非法 → `INVALID_INPUT`(400)
 * - 本地库不存在/为空 → `DATA_NOT_READY`(503)，刻意区别于 `SOURCE_UNAVAILABLE`
 */

export type BacktestRouteDeps = {
  /** 打开日K库；默认从默认路径打开，测试注入临时库 */
  openStore?: () => MarketStore;
  /** 结果缓存（跨请求共享） */
  cache?: PromptCache<BacktestResponse>;
  now?: () => Date;
};

type BacktestQuery = {
  from?: string;
  to?: string;
  hotTop?: string;
  window?: string;
  sample?: string;
  boards?: string;
  refresh?: string;
};

const ALL_BOARDS: readonly Board[] = ["main", "growth", "star", "bj"];
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_FROM = "2021-01-01";
const HOT_TOP_RANGE = { min: 10, max: 3000 } as const;
const WINDOW_RANGE = { min: 5, max: 120 } as const;
const SAMPLE_RANGE = { min: 100, max: 6000 } as const;

function parseDate(raw: string, label: string): number {
  if (!DATE_PATTERN.test(raw)) {
    throw new ApiError("INVALID_INPUT", `${label} 必须是 YYYY-MM-DD，收到「${raw}」`, 400);
  }
  try {
    return toDateKey(raw);
  } catch {
    throw new ApiError("INVALID_INPUT", `${label} 无法解析为交易日：${raw}`, 400);
  }
}

function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  range: { min: number; max: number },
  label: string,
): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new ApiError(
      "INVALID_INPUT",
      `${label} 必须是 ${range.min}–${range.max} 的整数，收到「${raw}」`,
      400,
    );
  }
  return value;
}

function parseBoolean(raw: string | undefined): boolean {
  if (raw === undefined || raw === "") return false;
  if (raw === "true" || raw === "1") return true;
  if (raw === "false" || raw === "0") return false;
  throw new ApiError("INVALID_INPUT", `布尔参数只能是 true / false，收到「${raw}」`, 400);
}

export type ParsedBacktestQuery = {
  fromDate: number;
  /** null 表示"库内最新交易日" */
  toDate: number | null;
  params: BacktestParams;
  boards: readonly Board[];
  sample: number | null;
  refresh: boolean;
};

export function parseBacktestQuery(query: BacktestQuery): ParsedBacktestQuery {
  const fromDate = parseDate(query.from ?? DEFAULT_FROM, "from");
  const toDate = query.to === undefined || query.to === "" ? null : parseDate(query.to, "to");
  if (toDate !== null && toDate <= fromDate) {
    throw new ApiError("INVALID_INPUT", `to 必须晚于 from（${query.from ?? DEFAULT_FROM}）`, 400);
  }

  const boards =
    query.boards === undefined || query.boards === ""
      ? ALL_BOARDS
      : (query.boards
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean) as Board[]);
  for (const board of boards) {
    if (!ALL_BOARDS.includes(board)) {
      throw new ApiError(
        "INVALID_INPUT",
        `boards 只能包含 ${ALL_BOARDS.join(" / ")}，收到「${board}」`,
        400,
      );
    }
  }
  if (boards.length === 0) throw new ApiError("INVALID_INPUT", "boards 不能为空", 400);

  const sample =
    query.sample === undefined || query.sample === "" || query.sample === "0"
      ? null
      : parseIntInRange(query.sample, SAMPLE_RANGE.min, SAMPLE_RANGE, "sample");

  const params: BacktestParams = {
    ...DEFAULT_BACKTEST_PARAMS,
    hotTopN: parseIntInRange(query.hotTop, DEFAULT_BACKTEST_PARAMS.hotTopN, HOT_TOP_RANGE, "hotTop"),
    hotWindow: parseIntInRange(
      query.window,
      DEFAULT_BACKTEST_PARAMS.hotWindow,
      WINDOW_RANGE,
      "window",
    ),
  };

  return { fromDate, toDate, params, boards, sample, refresh: parseBoolean(query.refresh) };
}

function cacheKey(parsed: ParsedBacktestQuery, dataDate: number): string {
  return [
    parsed.fromDate,
    parsed.toDate ?? "latest",
    dataDate,
    parsed.params.hotTopN,
    parsed.params.hotWindow,
    parsed.params.kdjPeriod,
    parsed.params.kdjKSmooth,
    parsed.params.kdjDSmooth,
    parsed.sample ?? "all",
    parsed.boards.join(","),
  ].join("|");
}

export async function backtestRoutes(app: FastifyInstance, deps: BacktestRouteDeps): Promise<void> {
  const openStore = deps.openStore ?? (() => openMarketStore());

  app.get<{ Querystring: BacktestQuery }>("/api/backtest", async (req) => {
    const parsed = parseBacktestQuery(req.query);

    let store: MarketStore;
    try {
      store = openStore();
    } catch (err) {
      if (err instanceof MarketDataNotReadyError || err instanceof MarketDataIncompleteError) {
        throw new ApiError(
          "DATA_NOT_READY",
          `${err.message}。请先运行 npm run bootstrap:kline`,
          503,
        );
      }
      throw err;
    }

    try {
      const dataDate = store.latestTradeDate();
      if (dataDate === null) {
        throw new ApiError("DATA_NOT_READY", "本地日K库是空的。请先运行 npm run bootstrap:kline", 503);
      }

      const toDate = parsed.toDate ?? dataDate;
      if (toDate <= parsed.fromDate) {
        throw new ApiError(
          "INVALID_INPUT",
          `回测区间为空：from 必须早于库内最新交易日 ${dataDate}`,
          400,
        );
      }

      const key = cacheKey(parsed, dataDate);
      if (!parsed.refresh) {
        const hit = deps.cache?.get(key);
        if (hit) return { ...hit, fromCache: true };
      }

      const run = await runBacktestAsync(store, {
        fromDate: parsed.fromDate,
        toDate,
        params: parsed.params,
        boards: parsed.boards,
        maxStocks: parsed.sample,
      });

      const response = toBacktestResponse(run, {
        fromDate: parsed.fromDate,
        toDate,
        params: parsed.params,
        sample: parsed.sample,
        fromCache: false,
      });
      deps.cache?.set(key, response);
      return response;
    } finally {
      store.close();
    }
  });
}

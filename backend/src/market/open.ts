import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MarketStore } from "./store.js";

/**
 * 本地日K库的打开入口。
 *
 * 刻意与 `MarketStore` 的构造函数分开：SQLite 的构造函数对不存在的路径会**直接建一个空库**，
 * 于是"库还没 bootstrap"会被伪装成"库是空的"——两者的用户动作完全不同，
 * 必须在打开这一层就分辨出来。
 */

export class MarketDataNotReadyError extends Error {
  constructor(readonly path: string) {
    super(`本地日K库尚未初始化：${path}`);
    this.name = "MarketDataNotReadyError";
  }
}

/** 默认库路径：`backend/data/kline.sqlite`，可用 MARKET_DB_PATH 覆盖。 */
export function defaultMarketDbPath(): string {
  return (
    process.env.MARKET_DB_PATH ??
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "kline.sqlite")
  );
}

/** 打开已存在的库；不存在则抛 `MarketDataNotReadyError`（路由映射为 DATA_NOT_READY）。 */
export function openMarketStore(path = defaultMarketDbPath()): MarketStore {
  if (!existsSync(path)) throw new MarketDataNotReadyError(path);
  return new MarketStore(path);
}

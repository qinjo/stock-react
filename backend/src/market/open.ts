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

/** 库文件存在、但 bootstrap 没跑完（半成品库）。 */
export class MarketDataIncompleteError extends Error {
  constructor(readonly path: string) {
    super(
      `本地日K库看起来不完整（缺少 bootstrap 完成标记）：${path}\n` +
        `重新执行 npm run bootstrap:kline。`,
    );
    this.name = "MarketDataIncompleteError";
  }
}

/** 打开已存在的库；不存在则抛 `MarketDataNotReadyError`（路由映射为 DATA_NOT_READY）。 */
export function openMarketStore(path = defaultMarketDbPath()): MarketStore {
  if (!existsSync(path)) throw new MarketDataNotReadyError(path);
  const store = new MarketStore(path);
  // 幂等建表 + 补列：库是上一次 bootstrap 留下的产物，可能比当前 schema 旧
  store.migrate();

  /*
   * 半成品守卫。
   *
   * bootstrap 的顺序是「下载 → 校验 sha256 → 删旧库 → 重建」——
   * 前两步在删库之前，所以下载失败不会毁掉旧库（这一点是对的）。
   * 但**删库之后、重建完成之前**若进程中断（Ctrl-C、磁盘满、解析报错），
   * 会留下一个"文件存在、建表成功、数据却只写了一半"的库。
   * 那种库**用起来毫无异常**：筛选照跑、结果照出，只是基于一份残缺的语料。
   *
   * `bootstrap_at` 只在 bootstrap 全部成功后才写，所以它是判定完整性的可靠标记。
   * 增量只更新数据、不动这个键，因此正常运行不会误报。
   */
  if (store.getMeta("bootstrap_at") === null && store.countInstruments() > 0) {
    store.close();
    throw new MarketDataIncompleteError(path);
  }
  return store;
}

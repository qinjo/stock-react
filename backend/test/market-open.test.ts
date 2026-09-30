import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MarketDataIncompleteError,
  MarketDataNotReadyError,
  openMarketStore,
} from "../src/market/open.js";
import { MarketStore } from "../src/market/store.js";

/**
 * 打开本地库时的三种状态必须分得清，因为**用户要做的动作完全不同**：
 *
 * 1. 文件不存在 → 还没 bootstrap（`npm run bootstrap:kline`）
 * 2. 文件存在但没有完成标记 → bootstrap 中途断了（**重跑 bootstrap**）
 * 3. 正常 → 直接用
 *
 * 第 2 种最危险：它**用起来毫无异常**——筛选照跑、结果照出，
 * 只是基于一份只写了一半的语料。所以必须有守卫把它拦下来。
 */

let dir: string;
let dbPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "open-"));
  dbPath = join(dir, "kline.sqlite");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("openMarketStore 的三种状态", () => {
  it("文件不存在 → MarketDataNotReadyError（而不是当成空库）", () => {
    expect(() => openMarketStore(dbPath)).toThrow(MarketDataNotReadyError);
  });

  it("文件存在但没有 bootstrap 完成标记 → MarketDataIncompleteError", () => {
    // 模拟"删库之后、重建完成之前"中断：建表成功、写了一半数据、没写 bootstrap_at
    const store = new MarketStore(dbPath);
    store.migrate();
    store.upsertInstruments([
      { code: "600519", market: "sh", board: "main", name: null, listedStart: 20200101, listedEnd: 20260929, isLive: true },
    ]);
    store.close();

    expect(() => openMarketStore(dbPath)).toThrow(MarketDataIncompleteError);
  });

  it("有完成标记 → 正常打开", () => {
    const store = new MarketStore(dbPath);
    store.migrate();
    store.upsertInstruments([
      { code: "600519", market: "sh", board: "main", name: null, listedStart: 20200101, listedEnd: 20260929, isLive: true },
    ]);
    store.setMeta("bootstrap_at", new Date().toISOString());
    store.close();

    const opened = openMarketStore(dbPath);
    expect(opened.countInstruments()).toBe(1);
    opened.close();
  });

  it("空库（建了表但一只标的都没有）不报「不完整」——那和「还没数据」是一回事", () => {
    const store = new MarketStore(dbPath);
    store.migrate();
    store.close();
    // 没有标的 → 更像"还没 bootstrap"，由调用方按空结果处理即可，不该说成半成品
    const opened = openMarketStore(dbPath);
    expect(opened.countInstruments()).toBe(0);
    opened.close();
  });

  it("错误信息里给出可执行的下一步（重跑 bootstrap）", () => {
    const store = new MarketStore(dbPath);
    store.migrate();
    store.upsertInstruments([
      { code: "600519", market: "sh", board: "main", name: null, listedStart: 20200101, listedEnd: 20260929, isLive: true },
    ]);
    store.close();
    try {
      openMarketStore(dbPath);
      expect.unreachable("应当抛错");
    } catch (err) {
      expect((err as Error).message).toContain("bootstrap:kline");
    }
  });
});

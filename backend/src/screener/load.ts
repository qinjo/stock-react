import type { MarketStore } from "../market/store.js";
import type { SecurityInput } from "./types.js";

/**
 * 把本地日K库适配成筛选引擎的输入流。
 *
 * 这一层只做「取数 → 领域对象」的搬运，不含任何判据。
 * 刻意做成生成器：全市场六千只标的的日线一次性载入会有 GB 级内存占用，
 * 逐只读、逐只判，内存只与单只标的规模有关。
 *
 * 流通市值来自行情快照（每日增量通道），当前先给 null；
 * 引擎会因此把市值闸门标为"未生效"并显式暴露，不会假装它开着。
 */
export function* loadUniverseFromStore(
  store: MarketStore,
  options: { barsLimit?: number; codeFilter?: (row: ReturnType<MarketStore["listInstruments"]>[number]) => boolean } = {},
): Generator<SecurityInput> {
  const barsLimit = options.barsLimit ?? 260;

  for (const row of store.listInstruments()) {
    if (options.codeFilter && !options.codeFilter(row)) continue;
    const bars = store.readBars(row.code, barsLimit);
    if (bars.length === 0) continue;
    yield {
      code: row.code,
      name: row.name,
      board: row.board,
      isLive: row.isLive,
      floatMarketCap: null,
      bars,
    };
  }
}

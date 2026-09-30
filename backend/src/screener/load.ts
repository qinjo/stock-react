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
  options: {
    barsLimit?: number;
    codeFilter?: (row: ReturnType<MarketStore["listInstruments"]>[number]) => boolean;
    /** 历史回放：只喂截至该日的日线，绝不让未来数据漏进来 */
    asOfDate?: number;
  } = {},
): Generator<SecurityInput> {
  const barsLimit = options.barsLimit ?? 260;
  const asOf = options.asOfDate;
  const latestTradeDate = asOf === undefined ? store.latestTradeDate() : store.latestTradeDateUpTo(asOf);

  for (const row of store.listInstruments()) {
    if (options.codeFilter && !options.codeFilter(row)) continue;
    const bars = asOf === undefined ? store.readBars(row.code, barsLimit) : store.readBarsUpTo(row.code, asOf, barsLimit);
    if (bars.length === 0) continue;
    const lastBarDate = (bars[bars.length - 1] as { date: number }).date;
    yield {
      code: row.code,
      name: row.name,
      board: row.board,
      isLive: row.isLive,
      // 市值来自行情快照（每日增量刷新）；未接过快照时为 null，
      // 引擎会把市值闸门标为"未生效"并如实上报，而不是假装它开着
      floatMarketCap: row.floatMarketCap ?? null,
      tradedOnLatestDay: latestTradeDate !== null && lastBarDate === latestTradeDate,
      bars,
    };
  }
}

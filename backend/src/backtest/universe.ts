import type { MarketStore } from "../market/store.js";
import type { DailyBar } from "../screener/types.js";
import { detectLimits } from "./limits.js";
import type { HotIndex } from "./types.js";

/**
 * 宇宙（候选池）构造。
 *
 * 用户的原话是「近一个月内出现在热门列表、且有过涨停」的票。仓库里没有真实人气榜历史
 * （见 `docs/research-hot-list-data.md`），所以回测的默认宇宙是一个**可重建的代理**：
 *
 *   热门代理 = 当日**成交额**横截面排名前 N
 *   涨停条件 = 同一窗口内至少一根**收盘封涨停**
 *
 * 两者都只依赖本地日线，因此可以回测 6 年。代理不是"热门"本身——报告必须标注这一点，
 * 并且宇宙 A（真实人气榜，约 12 个月）在数据层落地后会作为独立宇宙对照（issue #32）。
 *
 * 选成交额而不是换手率：换手率需要历史流通股本，库内只有当前市值，无法回溯。
 */

/**
 * 逐日建立"热门代理"索引：`date → 成交额排名前 topN 的代码集合`。
 *
 * 一次回测要问约 1500 个交易日，每次一条走 `idx_bars_date` 的查询（见 `store.readDayAmounts`）。
 * 返回的集合只占 1500×N 个字符串，内存可忽略。
 */
export function buildAmountRankIndex(
  store: MarketStore,
  dates: readonly number[],
  topN: number,
): Map<number, Set<string>> {
  if (topN <= 0) throw new Error(`热门 Top-N 必须为正：${topN}`);
  const index = new Map<number, Set<string>>();
  for (const date of dates) {
    // 排序与截断交给 SQLite（走 `(date, amount)` 复合索引），不要在这里把全市场读出来排
    const rows = store.readDayTopAmounts(date, topN);
    if (rows.length === 0) continue;
    index.set(date, new Set(rows.map((row) => row.code)));
  }
  return index;
}

/**
 * 逐根 K 线计算「该日是否满足宇宙条件」。
 *
 * 条件 = 以该日为终点、长度 `window` 的**该股自身交易日**窗口内：
 *   ① 至少一天在热门代理集合里；② 至少一天收盘涨停。
 *
 * 窗口按"该股有成交的交易日"计，停牌日不计——这与"近一个月"的日常理解一致，
 * 也避免停牌股因为日历空洞被误判为不活跃。窗口不足 `window` 根时一律 false：
 * 早期样本宁可不出，也不要拿三天数据冒充"近一个月"。
 */
export function eligibilityFlags(
  bars: readonly DailyBar[],
  code: string,
  hotIndex: HotIndex,
  limitUpClose: readonly boolean[],
  window: number,
): boolean[] {
  if (window <= 0) throw new Error(`热门窗口必须为正：${window}`);
  const n = bars.length;
  if (limitUpClose.length !== n) throw new Error("涨停标记与日线长度不一致");

  const hotPrefix = new Array<number>(n + 1).fill(0);
  const limitPrefix = new Array<number>(n + 1).fill(0);
  for (let i = 0; i < n; i++) {
    const date = (bars[i] as DailyBar).date;
    const isHot = hotIndex.get(date)?.has(code) ?? false;
    hotPrefix[i + 1] = (hotPrefix[i] as number) + (isHot ? 1 : 0);
    limitPrefix[i + 1] = (limitPrefix[i] as number) + (limitUpClose[i] ? 1 : 0);
  }

  const eligible: boolean[] = new Array(n).fill(false);
  for (let i = window - 1; i < n; i++) {
    const from = i + 1 - window;
    const hotCount = (hotPrefix[i + 1] as number) - (hotPrefix[from] as number);
    const limitCount = (limitPrefix[i + 1] as number) - (limitPrefix[from] as number);
    eligible[i] = hotCount > 0 && limitCount > 0;
  }
  return eligible;
}

/** 便捷组合：从日线一次算出宇宙标记（内部会重算涨停标记）。 */
export function eligibilityForBars(
  bars: readonly DailyBar[],
  code: string,
  hotIndex: HotIndex,
  window: number,
  ratios?: readonly number[],
): boolean[] {
  const limits = detectLimits(bars, ratios ? { ratios } : {});
  return eligibilityFlags(bars, code, hotIndex, limits.upClose, window);
}

import type { Board } from "../market/qlib.js";
import type { DailyBar } from "../screener/types.js";

/**
 * 涨跌停判定。
 *
 * 为什么复用不了 `screener/structure.ts` 的 `limitUpRatio(board)`：
 * 1. 那里只有涨停、没有跌停，而回测的卖出侧（死叉遇跌停卖不出）必须要跌停；
 * 2. 库里没有**历史 ST 标记**，ST 的 5% 板无法按日期判定；
 * 3. 新股上市初期、特殊处理个股的幅度规则无法只靠板块表覆盖。
 *
 * 本模块的取舍（**一个必须写进报告的近似**）：用「前收盘 × (1 ± 比例) 四舍五入到分」
 * 反推交易所的涨跌停价，再与**不复权**实际价格精确比对。比例候选由板块与**当前名称**决定：
 *
 * - 主板非 ST → 10%
 * - 主板 ST/*ST/退 → 5%
 * - 创业板/科创板 → 20%（含 ST，2020 改革后如此）
 * - 北交所 → 30%
 *
 * 为什么不把所有比例都试一遍：主板普通股某天恰好收在 +5% 会被误判成 ST 涨停，
 * 那是成规模的假阳性（也会让"开盘 +5% 视为不可买入"错误地吞掉大量正常信号）。
 * 代价是：**当前不是 ST、但历史上曾经是 ST 的票**，其历史 5% 板会被按 10% 漏判——
 * 这一点没有数据可以修正，只能在报告里如实披露。
 */

/** 与交易所一致：价格四舍五入到分。浮点乘法的尾差用 epsilon 抵消。 */
export function roundToCent(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** 涨跌停价。 */
export function limitPrice(prevClose: number, ratio: number, direction: "up" | "down"): number {
  return roundToCent(prevClose * (1 + (direction === "up" ? ratio : -ratio)));
}

/** 名称里带 ST（含 *ST）或退市标记 → 按 ST 口径处理。 */
export function isStName(name: string | null | undefined): boolean {
  if (!name) return false;
  return /ST/i.test(name) || /退/.test(name);
}

/** 某个板块在给定 ST 状态下的涨跌停幅度候选。 */
export function limitRatiosFor(board: Board | null | undefined, isSt: boolean): readonly number[] {
  if (board === "growth" || board === "star") return [0.2];
  if (board === "bj") return [0.3];
  if (board === "main") return isSt ? [0.05] : [0.1];
  // 未知板块：宁可漏判，也不要臆测 5%——5% 的假阳性代价比漏判大得多
  return [0.3, 0.2, 0.1];
}

export type DetectLimitOptions = {
  /** 候选幅度；不传则按未知板块处理（30/20/10，不含 5%） */
  ratios?: readonly number[];
};

const PRICE_EPSILON = 1e-6;

function priceEquals(a: number, b: number): boolean {
  return Math.abs(a - b) < PRICE_EPSILON;
}

export type LimitFlags = {
  /** 收盘封涨停（收盘价 = 涨停价） */
  upClose: boolean[];
  /** 收盘封跌停 */
  downClose: boolean[];
  /** 开盘即涨停：无法以开盘价买入 */
  upOpen: boolean[];
  /** 开盘即跌停：无法以开盘价卖出 */
  downOpen: boolean[];
  /** 当日涨停幅度（0.05/0.10/0.20/0.30）；未涨停为 null */
  upRatio: Array<number | null>;
};

/**
 * 逐根标记涨跌停。
 *
 * 首根 K 线没有前收盘，一律标记为 false（新股上市首日不参与）。
 * 用**不复权**价：涨跌停是交易所价格空间里的概念，拿后复权价去比涨停价会得出错误的百分比。
 * 收盘涨停与开盘涨停**独立判定**：存在"开盘封板、盘中打开、收盘不在涨停价"的日子，
 * 那种日子不能买入，但也不该算作收盘涨停（宇宙条件用的是收盘封板）。
 */
export function detectLimits(
  bars: readonly DailyBar[],
  options: DetectLimitOptions = {},
): LimitFlags {
  const ratios = options.ratios ?? [0.3, 0.2, 0.1];
  const n = bars.length;
  const upClose: boolean[] = new Array(n).fill(false);
  const downClose: boolean[] = new Array(n).fill(false);
  const upOpen: boolean[] = new Array(n).fill(false);
  const downOpen: boolean[] = new Array(n).fill(false);
  const upRatio: Array<number | null> = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const prevClose = (bars[i - 1] as DailyBar).close;
    if (!(prevClose > 0)) continue;
    const bar = bars[i] as DailyBar;

    for (const ratio of ratios) {
      const upTarget = limitPrice(prevClose, ratio, "up");
      const downTarget = limitPrice(prevClose, ratio, "down");
      if (priceEquals(bar.close, upTarget)) {
        upClose[i] = true;
        upRatio[i] = ratio;
      }
      if (priceEquals(bar.open, upTarget)) upOpen[i] = true;
      if (priceEquals(bar.close, downTarget)) downClose[i] = true;
      if (priceEquals(bar.open, downTarget)) downOpen[i] = true;
    }
  }

  return { upClose, downClose, upOpen, downOpen, upRatio };
}

/** 窗口内是否出现过收盘涨停（供宇宙判定使用）。 */
export function hasLimitUpInWindow(
  flags: readonly boolean[],
  endIndex: number,
  window: number,
): boolean {
  const start = Math.max(0, endIndex - window + 1);
  for (let i = start; i <= endIndex; i++) if (flags[i]) return true;
  return false;
}

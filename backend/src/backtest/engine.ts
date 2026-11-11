import type { Board } from "../market/qlib.js";
import type { DailyBar } from "../screener/types.js";
import { crossFlags, kdjSeries } from "./kdj.js";
import { detectLimits, isStName, limitRatiosFor } from "./limits.js";
import type { BacktestOptions, BacktestParams, EquityPoint, StockResult, Trade } from "./types.js";

/**
 * 逐票独立回测引擎（纯函数）。
 *
 * 规则（来自用户策略 + 已确认的成交假设）：
 * - 入场：金叉当日收盘产生信号，**次日开盘**买入；次日开盘涨停则顺延到第一个能成交的交易日。
 * - 出场：死叉当日收盘产生信号，**次日开盘**卖出；次日开盘跌停则顺延。
 * - 宇宙：信号日必须满足宇宙条件（`eligible[i]`），由 `universe.ts` 预先算好。
 * - 仓位：单票单笔，满仓进出；资金按整手（100 股）取整，费用按 `params` 扣。
 * - 期末仍有持仓：按最后一根收盘价计值，标记 `openAtEnd`，**不计卖出费用**（并未真的卖出）。
 *
 * 未来函数防线：引擎只按输入数组顺序推进，任何决策只看 `≤ i` 的数据；
 * 信号从 `i` 收盘产生、最早在 `i+1` 开盘执行，因此不存在"用当天收盘价买入"的隐性漏未来。
 */

export type StockBacktestInput = {
  code: string;
  name: string | null;
  board: Board;
  /** 升序日线；需包含回测区间起点之前至少若干根用于指标预热 */
  bars: DailyBar[];
  /** 与 `bars` 等长：该日收盘时是否满足宇宙条件（窗口含当日） */
  eligible: boolean[];
};

type Position = {
  entryIndex: number;
  /** 产生买入信号的金叉日下标（用于报告"信号→成交"的延迟） */
  entrySignalIndex: number;
  entryDate: number;
  entryPrice: number;
  /** 买入日的复权因子：成交价是真实价，收益必须换算到后复权空间，否则除权日会凭空亏一半 */
  entryAdj: number;
  shares: number;
  /** 买入总成本（含费用） */
  cost: number;
  /** 买入已付费用 */
  fees: number;
};

/** 买入费用：佣金（有最低收费）+ 过户费。 */
export function buyFees(amount: number, params: BacktestParams): number {
  return Math.max(amount * params.commissionRate, params.commissionMin) + amount * params.transferFeeRate;
}

/** 卖出费用：买入侧两项 + 印花税。 */
export function sellFees(amount: number, params: BacktestParams): number {
  return buyFees(amount, params) + amount * params.stampTaxRate;
}

/** 现金能买的最大整手数（含费用约束）；不足一手返回 0。 */
export function maxBuyableShares(cash: number, price: number, params: BacktestParams): number {
  if (!(price > 0)) return 0;
  const lot = params.lotSize;
  let shares = Math.floor(cash / (price * lot)) * lot;
  while (shares > 0) {
    const amount = shares * price;
    if (amount + buyFees(amount, params) <= cash + 1e-9) return shares;
    shares -= lot;
  }
  return 0;
}

export function backtestStock(
  input: StockBacktestInput,
  options: BacktestOptions,
): StockResult | null {
  const { bars, eligible } = input;
  const params = options.params;
  const n = bars.length;
  if (n === 0 || eligible.length !== n) return null;

  let startIdx = -1;
  for (let i = 0; i < n; i++) {
    if ((bars[i] as DailyBar).date >= options.fromDate) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = -1;
  for (let i = n - 1; i >= 0; i--) {
    if ((bars[i] as DailyBar).date <= options.toDate) {
      endIdx = i;
      break;
    }
  }
  if (endIdx < startIdx) return null;
  // 样本太短不参与统计：否则一只刚上市十天的票也会贡献一个"收益率"
  if (endIdx - startIdx + 1 < params.minBars) return null;

  const kdj = kdjSeries(bars, {
    period: params.kdjPeriod,
    kSmooth: params.kdjKSmooth,
    dSmooth: params.kdjDSmooth,
  });
  const crosses = crossFlags(kdj.k, kdj.d);
  // 涨跌停幅度由板块 + 当前名称（是否 ST）决定；名称里的 ST 是当前状态，不是历史状态，
  // 这个近似在报告里披露。
  const limits = detectLimits(bars, { ratios: limitRatiosFor(input.board, isStName(input.name)) });

  const keepCurve = options.keepEquityCurve === true;
  const equityCurve: EquityPoint[] = [];

  let cash = params.capital;
  let peak = params.capital;
  let maxDrawdown = 0;
  let eligibleSignals = 0;
  let unfilledSignals = 0;
  const trades: Trade[] = [];

  let position: Position | null = null;
  let pendingBuy: { signalIndex: number } | null = null;
  let pendingSell: { signalIndex: number } | null = null;

  /**
   * 卖出价值的**后复权换算**。
   *
   * 买入价与卖出价都是真实成交价，但持有期内若发生送转/拆股，真实价会跳空，
   * 直接相减会把"10 送 10"记成 −50%。正确做法是把卖出侧按复权因子比例换算：
   * 真实持仓价值 = 股数 × 真实价 × (卖出日因子 / 买入日因子)。
   * 分红同理被近似为再投资（后复权口径），这一点在报告里披露。
   */
  const adjustedProceeds = (shares: number, exitPrice: number, exitAdj: number, entryAdj: number): number =>
    shares * exitPrice * (exitAdj / entryAdj);

  const buildTrade = (
    pos: Position,
    exitIndex: number,
    exitPrice: number,
    closeFees: number,
    openAtEnd: boolean,
  ): Trade => {
    const exitAdj = (bars[exitIndex] as DailyBar).adjFactor;
    const proceeds = adjustedProceeds(pos.shares, exitPrice, exitAdj, pos.entryAdj) - closeFees;
    const grossReturn = (exitPrice * exitAdj) / (pos.entryPrice * pos.entryAdj) - 1;
    return {
      code: input.code,
      signalDate: (bars[pos.entrySignalIndex] as DailyBar).date,
      entryDate: pos.entryDate,
      entryPrice: pos.entryPrice,
      exitDate: (bars[exitIndex] as DailyBar).date,
      exitPrice,
      shares: pos.shares,
      entryDelay: pos.entryIndex - (pos.entrySignalIndex + 1),
      holdingDays: exitIndex - pos.entryIndex,
      cost: pos.cost,
      proceeds,
      fees: pos.fees + closeFees,
      grossReturn,
      netReturn: (proceeds - pos.cost) / pos.cost,
      openAtEnd,
    };
  };

  for (let i = startIdx; i <= endIdx; i++) {
    const bar = bars[i] as DailyBar;

    // ① 开盘执行上一交易日收盘产生的指令（持仓互斥，同日不可能既买又卖）
    if (pendingSell !== null && position !== null && !limits.downOpen[i]) {
      // 费用按真实成交额收（换算后的价值口径一致），再过一遍复权换算
      const rawAmount = position.shares * bar.open;
      const ratio = bar.adjFactor / position.entryAdj;
      const fees = sellFees(rawAmount * ratio, params);
      cash += rawAmount * ratio - fees;
      trades.push(buildTrade(position, i, bar.open, fees, false));
      position = null;
      pendingSell = null;
    }

    if (pendingBuy !== null && position === null && !limits.upOpen[i]) {
      const shares = maxBuyableShares(cash, bar.open, params);
      if (shares === 0) {
        // 顺延到这天时价格可能已经涨到买不起整手；如实计为"信号没成交"
        unfilledSignals++;
        pendingBuy = null;
      } else {
        const amount = shares * bar.open;
        const fees = buyFees(amount, params);
        cash -= amount + fees;
        position = {
          entryIndex: i,
          entrySignalIndex: pendingBuy.signalIndex,
          entryDate: bar.date,
          entryPrice: bar.open,
          entryAdj: bar.adjFactor,
          shares,
          cost: amount + fees,
          fees,
        };
        pendingBuy = null;
      }
    }

    // ② 收盘评估信号：只影响下一交易日，绝不用当天收盘价成交
    if (position !== null) {
      if (crosses.death[i]) pendingSell = { signalIndex: i };
    } else {
      if (crosses.death[i] && pendingBuy !== null) {
        // 顺延期间先出现死叉：买入信号作废（"金叉买、死叉清"不允许死叉后再补买）
        unfilledSignals++;
        pendingBuy = null;
      }
      if (crosses.golden[i] && eligible[i]) {
        eligibleSignals++;
        if (pendingBuy === null) pendingBuy = { signalIndex: i };
      }
    }

    // ③ 逐日盯市（持仓价值同样换算到后复权空间）
    const equity =
      cash +
      (position !== null
        ? position.shares * bar.close * (bar.adjFactor / position.entryAdj)
        : 0);
    if (equity > peak) peak = equity;
    const drawdown = peak > 0 ? (peak - equity) / peak : 0;
    if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    if (keepCurve) equityCurve.push({ date: bar.date, equity });
  }

  // 期末仍挂着未成交的买单：如实计入"信号未能成交"
  if (pendingBuy !== null && position === null) {
    unfilledSignals++;
    pendingBuy = null;
  }

  const lastBar = bars[endIdx] as DailyBar;
  const finalEquity =
    cash +
    (position !== null
      ? position.shares * lastBar.close * (lastBar.adjFactor / position.entryAdj)
      : 0);

  // 期末未平仓：按收盘价计值，不计卖出费用，并显式标记
  if (position !== null) {
    trades.push(buildTrade(position, endIdx, lastBar.close, 0, true));
  }

  // 基准：同期买入持有（后复权，跨除权可比；不计费用、不计整手）
  const startBar = bars[startIdx] as DailyBar;
  const buyHoldReturn =
    startBar.open > 0
      ? (lastBar.close * lastBar.adjFactor) / (startBar.open * startBar.adjFactor) - 1
      : null;

  return {
    code: input.code,
    name: input.name,
    board: input.board,
    startDate: startBar.date,
    endDate: lastBar.date,
    initialEquity: params.capital,
    finalEquity,
    totalReturn: finalEquity / params.capital - 1,
    maxDrawdown,
    buyHoldReturn,
    trades,
    eligibleSignals,
    unfilledSignals,
    equityCurve,
  };
}

import type { Board } from "../market/qlib.js";

/**
 * 回测的领域类型。
 *
 * 两条贯穿全模块的口径（与 `screener/types.ts` 一致，不得混用）：
 * - **指标空间**：KDJ 等连续量算在「不复权价 × adjFactor」（后复权）上，跨除权不跳变；
 * - **交易所价格空间**：成交价、涨停价、涨跌停不可成交判定算在**不复权**真实价上。
 *
 * 本模块是纯领域层：不读文件、不发请求，日线由调用方喂进来。
 */

/** 回测参数（默认值见 `params.ts`，全部带来源标注）。 */
export type BacktestParams = {
  /** KDJ 的 RSV 窗口（A 股默认 9） */
  kdjPeriod: number;
  /** K 线平滑参数（中国式 `SMA(RSV, N, 1)` 的 N） */
  kdjKSmooth: number;
  /** D 线平滑参数 */
  kdjDSmooth: number;
  /** 「近一个月」的窗口长度：交易日数（不是自然日） */
  hotWindow: number;
  /** 「出现在热门列表」的判定：横截面排名 ≤ 该值 */
  hotTopN: number;
  /** 参与统计的最少 K 线根数（太短的样本不进结果） */
  minBars: number;
  /** 每只票的初始资金（逐票独立，互不影响） */
  capital: number;
  /** 佣金费率（双边） */
  commissionRate: number;
  /** 佣金最低收费（元） */
  commissionMin: number;
  /** 印花税率（仅卖出） */
  stampTaxRate: number;
  /** 过户费率（双边） */
  transferFeeRate: number;
  /** 一手股数（A 股 100） */
  lotSize: number;
};

/** 一笔完整的（或期末未平仓的）交易。 */
export type Trade = {
  code: string;
  /** 金叉信号日 */
  signalDate: number;
  /** 实际买入日/价（信号日之后第一个能成交的交易日开盘） */
  entryDate: number;
  entryPrice: number;
  /** 实际卖出日/价；期末未平仓时为最后一根 K 线的收盘价 */
  exitDate: number;
  exitPrice: number;
  shares: number;
  /** 信号日到成交日之间被顺延的交易日数（0 = 次日即成交） */
  entryDelay: number;
  /** 持有交易日数（买入日到卖出日） */
  holdingDays: number;
  /** 买入总成本（含费用） */
  cost: number;
  /** 卖出净所得（已扣费用） */
  proceeds: number;
  /** 已付费用合计 */
  fees: number;
  /** 不含费用的价格收益 */
  grossReturn: number;
  /** 含费用的净收益 */
  netReturn: number;
  /** 期末未平仓：按最后收盘价计值，未计卖出费用 */
  openAtEnd: boolean;
};

export type EquityPoint = { date: number; equity: number };

/** 单只标的的回测结果。 */
export type StockResult = {
  code: string;
  name: string | null;
  board: Board;
  startDate: number;
  endDate: number;
  initialEquity: number;
  finalEquity: number;
  /** 逐票总收益（期末权益 / 初始资金 − 1） */
  totalReturn: number;
  /** 单票权益曲线最大回撤（正数，0.2 = 回撤 20%） */
  maxDrawdown: number;
  /** 同期买入持有（后复权口径，不计费用）；样本不足时为 null */
  buyHoldReturn: number | null;
  trades: Trade[];
  /** 满足宇宙条件且出现金叉的信号数 */
  eligibleSignals: number;
  /** 因开盘涨停/资金不足等原因始终没能成交的信号数 */
  unfilledSignals: number;
  /** 逐日权益曲线；`keepEquityCurve = false` 时为空数组（节省内存） */
  equityCurve: EquityPoint[];
};

export type BacktestOptions = {
  params: BacktestParams;
  /** 回测区间（含端点），`YYYYMMDD` */
  fromDate: number;
  toDate: number;
  /** 是否保留逐日权益曲线；全市场跑时关掉，内存只与交易数有关 */
  keepEquityCurve?: boolean;
};

/** 宇宙成员判定所需：某日该票是否在"热门列表"里。 */
export type HotIndex = ReadonlyMap<number, ReadonlySet<string>>;

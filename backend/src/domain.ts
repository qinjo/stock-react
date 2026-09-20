/** 领域模型：与外部数据源解耦的中立结构。 */

export type SearchCandidate = {
  code: string;
  name: string;
  /** 东财 secid，如 "1.600519" */
  secid: string;
  /** 市场描述，如 "沪A" */
  market: string;
  /** 拼音首字母，便于前端展示 */
  pinyin: string;
};

export type Quote = {
  code: string;
  name: string;
  /** 最新价（元） */
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  prevClose: number | null;
  /** 涨跌幅（%） */
  changePercent: number | null;
  /** 涨停价 */
  limitUp: number | null;
  /** 跌停价 */
  limitDown: number | null;
  /** 成交量（手） */
  volume: number | null;
  /** 成交额（元） */
  amount: number | null;
  /** 总市值（元） */
  marketCap: number | null;
  /** 流通市值（元） */
  floatMarketCap: number | null;
  /** 市盈率（动） */
  pe: number | null;
  /** 市净率 */
  pb: number | null;
  /** 换手率（%） */
  turnoverRate: number | null;
};

export type Kline = {
  /** 交易日 YYYY-MM-DD */
  date: string;
  open: number;
  close: number;
  high: number;
  low: number;
  /** 成交量（手） */
  volume: number;
  /** 成交额（元） */
  amount: number | null;
  /** 振幅（%） */
  amplitude: number | null;
  /** 涨跌幅（%） */
  changePercent: number | null;
  /** 涨跌额 */
  changeAmount: number | null;
  /** 换手率（%） */
  turnoverRate: number | null;
};

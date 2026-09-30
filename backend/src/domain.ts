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

/**
 * 「没有这个标的」。
 *
 * 与"数据源不可用"必须分开：前者是**用户输入问题**（打错代码），后者是**服务端问题**。
 * 混在一起会让用户看到"数据源暂时不可用"而去等待，而真正该做的是改代码。
 *
 * 判断依据不是消息前缀（那正是原缺陷的成因——两个源抛的都是字段形态错误，
 * 没有一个以「无法识别」开头），而是：**两个源都失败、且都不是网络错误**。
 */
export class UnknownSymbolError extends Error {
  constructor(readonly input: string, detail: string) {
    super(`无法识别的股票代码「${input}」：${detail}`);
    this.name = "UnknownSymbolError";
  }
}

/**
 * 「数据源不可用」：网络失败、超时、HTTP 非 2xx。
 *
 * 与 `UnknownSymbolError` 相对：这个是**服务端问题**（该等），那个是**输入问题**（该改）。
 * 两者靠类型区分，不靠消息前缀——原缺陷正是因为靠消息前缀而永远匹配不上。
 */
export class SourceUnavailableError extends Error {
  constructor(message: string, readonly httpStatus?: number) {
    super(message);
    this.name = "SourceUnavailableError";
  }
}

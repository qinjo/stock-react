import { fromDateKey } from "../market/qlib.js";
import {
  BACKTEST_PROVENANCE,
  type BacktestProvenance,
} from "./params.js";
import {
  BOARD_LABELS,
  bucketByBoard,
  bucketByYear,
  returnHistogram,
  summarize,
  type Summary,
  type TradeBucket,
} from "./metrics.js";
import type { BacktestParams, StockResult, Trade } from "./types.js";

/**
 * Markdown 报告渲染（纯函数：输入结果与元信息，输出字符串）。
 *
 * 报告的首要职责不是"让收益好看"，而是**让读者知道自己看到的是什么**：
 * 样本是谁、假设是什么、哪些数字是我们编的、结论能推到多远。
 * 因此开头的"不可外推"警告与结尾的"局限"两节是强制的，不是装饰。
 */

export type ReportContext = {
  generatedAt: string;
  dbPath: string;
  /** 库内最新交易日 */
  dataLatestDate: number | null;
  fromDate: number;
  toDate: number;
  /** 宇宙说明（人类可读） */
  universeLabel: string;
  /** 参与宇宙判定的交易日数 */
  hotCalendarDays: number;
  params: BacktestParams;
  /** 各环节被剔除的标的数（保持漏斗可解释） */
  window: {
    instruments: number;
    noBarsInRange: number;
    shortSample: number;
    backtested: number;
  };
  command: string;
};

const PROVENANCE_LABEL: Record<BacktestProvenance["source"], string> = {
  user: "用户",
  inferred: "推断",
  offbook: "工程",
};

const BOARD_ORDER = ["main", "growth", "star", "bj"];

function pct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function num(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function ratio(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return value.toFixed(digits);
}

function table(headers: readonly string[], rows: ReadonlyArray<readonly string[]>): string {
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ];
  return lines.join("\n");
}

function bucketTable(buckets: readonly TradeBucket[]): string {
  return table(
    ["分组", "交易数", "胜率", "平均单笔", "中位单笔"],
    buckets.map((bucket) => [
      bucket.key,
      String(bucket.trades),
      pct(bucket.winRate, 1),
      pct(bucket.avgNetReturn, 2),
      pct(bucket.medianNetReturn, 2),
    ]),
  );
}

function statRows(summary: Summary, options: { quantiles?: boolean } = {}): string[][] {
  const rows: string[][] = [
    ["标的数", String(summary.stocks)],
    ["有交易的标的数", String(summary.tradedStocks)],
    ["交易笔数（含期末未平仓）", String(summary.trades)],
    ["期末未平仓笔数", String(summary.openTrades)],
    ["胜率", `${pct(summary.winRate, 1)}（${summary.wins}/${summary.trades}）`],
    ["平均单笔净收益", pct(summary.avgNetReturn, 2)],
    ["中位单笔净收益", pct(summary.medianNetReturn, 2)],
    ["盈亏比（总盈利/总亏损）", ratio(summary.profitFactor)],
    ["最差单笔净收益", pct(summary.maxLoss, 2)],
    ["平均持有交易日", num(summary.avgHoldingDays, 1)],
    ["逐票平均总收益", pct(summary.avgTotalReturn, 2)],
    ["逐票中位总收益", pct(summary.medianTotalReturn, 2)],
    ["逐票平均最大回撤", pct(summary.avgMaxDrawdown, 2)],
    ["同期买入持有（平均/中位）", `${pct(summary.avgBuyHold, 2)} / ${pct(summary.medianBuyHold, 2)}`],
    ["跑赢买入持有的标的数", `${summary.beatBuyHoldStocks}/${summary.stocksWithBuyHold}`],
    ["满足宇宙条件的金叉信号数", String(summary.eligibleSignals)],
    ["信号未能成交数（顺延期间死叉/买不起整手）", String(summary.unfilledSignals)],
  ];
  if (options.quantiles) {
    rows.splice(
      rows.length - 1,
      0,
      ["逐票总收益 P25 / P75", `${pct(summary.p25TotalReturn, 2)} / ${pct(summary.p75TotalReturn, 2)}`],
      ["逐票收益为 0 的标的数（从未触发交易）", String(summary.stocks - summary.tradedStocks)],
    );
  }
  return rows;
}

function stockRows(results: readonly StockResult[]): string[][] {
  return results.map((result) => {
    const summary = summarize([result]);
    return [
      result.code,
      result.name ?? "—",
      BOARD_LABELS[result.board] ?? result.board,
      String(result.trades.length),
      pct(summary.winRate, 1),
      pct(result.totalReturn, 2),
      pct(result.buyHoldReturn, 2),
      pct(result.maxDrawdown, 2),
    ];
  });
}

const STOCK_HEADERS = ["代码", "名称", "板块", "交易数", "胜率", "策略总收益", "买入持有", "最大回撤"];

export function renderReport(results: readonly StockResult[], context: ReportContext): string {
  const summary = summarize(results);
  const traded = results.filter((result) => result.trades.length > 0);
  const tradedSummary = summarize(traded);
  const ranked = [...traded].sort((a, b) => b.totalReturn - a.totalReturn);
  const top = ranked.slice(0, 10);
  const bottom = ranked.slice(-10).reverse();
  const histogram = returnHistogram(results);
  const yearBuckets = bucketByYear(results);
  const boardBuckets = bucketByBoard(results).sort(
    (a, b) =>
      BOARD_ORDER.indexOf(boardKeyOf(a.key)) - BOARD_ORDER.indexOf(boardKeyOf(b.key)),
  );
  const window = context.window;

  const lines: string[] = [];
  lines.push("# KDJ 金叉/死叉策略回测报告");
  lines.push("");
  lines.push(`> 生成时间 ${context.generatedAt}；数据截止 ${formDate(context.dataLatestDate)}；回测区间 ${formDate(context.fromDate)} → ${formDate(context.toDate)}。`);
  lines.push(">");
  lines.push("> **这不是投资建议。** 本报告是单套规则的历史机械回放，收益数字对样本区间敏感，且见第九节列出的全部近似。");
  lines.push("");

  lines.push("## 一、结论摘要（先读这段）");
  lines.push("");
  if (summary.trades === 0) {
    lines.push("- **样本区间内没有产生任何交易**：先确认宇宙条件（`--hot-top` 是否过窄）与数据区间是否正确。");
  } else {
    lines.push(`- 样本 ${summary.stocks} 只标的（其中有交易 ${summary.tradedStocks} 只）、${summary.trades} 笔交易；胜率 ${pct(summary.winRate, 1)}，平均单笔净收益 ${pct(summary.avgNetReturn, 2)}（中位 ${pct(summary.medianNetReturn, 2)}）。`);
    lines.push(`- **有交易的标的**：逐票平均总收益 ${pct(tradedSummary.avgTotalReturn, 2)}，同期买入持有平均 ${pct(tradedSummary.avgBuyHold, 2)}；${tradedSummary.beatBuyHoldStocks}/${tradedSummary.stocksWithBuyHold} 只跑赢买入持有。`);
    lines.push(`- **结论边界**：样本覆盖 ${formDate(context.fromDate)} → ${formDate(context.toDate)} 的单一市场周期，任何"这套策略有效/无效"的判断都不该越过这个区间与这套宇宙定义。`);
  }
  lines.push("");

  lines.push("## 二、数据与宇宙");
  lines.push("");
  lines.push(table(
    ["项", "值"],
    [
      ["本地日K库", `\`${context.dbPath}\``],
      ["库内最新交易日", formDate(context.dataLatestDate)],
      ["宇宙定义", context.universeLabel],
      ["宇宙判定的交易日数", String(context.hotCalendarDays)],
      ["参与回测的标的数", `${window.backtested}（全库 ${window.instruments}）`],
      ["剔除：区间内无日线", String(window.noBarsInRange)],
      ["剔除：区间内 K 线过短（< 60 个交易日）", String(window.shortSample)],
    ],
  ));
  lines.push("");
  lines.push("宇宙口径为**代理指标**，不是真实人气榜：仓库内没有历史热门列表，真实榜单由 issue #32 的数据层补齐；");
  lines.push("代理宇宙只能用「成交额排名」近似「资金关注度」，详见 `docs/research-hot-list-data.md`。");
  lines.push("");

  lines.push("## 三、参数与假设（含哪些数是「我们编的」）");
  lines.push("");
  const paramRows: string[][] = [
    ["KDJ 参数", `(${context.params.kdjPeriod}, ${context.params.kdjKSmooth}, ${context.params.kdjDSmooth})，中国式 SMA 平滑，算在后复权价上`, PROVENANCE_LABEL[BACKTEST_PROVENANCE.kdjPeriod.source]],
    ["金叉/死叉", "K 上穿 D 买入 / K 下穿 D 清仓，不加任何超买超卖过滤", "用户"],
    ["「近一个月」", `${context.params.hotWindow} 个交易日（该股自身有成交的交易日，停牌不计）`, PROVENANCE_LABEL[BACKTEST_PROVENANCE.hotWindow.source]],
    ["「热门列表」", `当日成交额横截面排名前 ${context.params.hotTopN}`, PROVENANCE_LABEL[BACKTEST_PROVENANCE.hotTopN.source]],
    ["「有过涨停」", "窗口内至少一根**收盘封涨停**；涨停价由前收盘 ×(1+比例) 四舍五入到分反推，比例按板块（10%/20%/30%）与当前名称是否 ST（5%）确定", "推断"],
    ["成交时点", "信号次日开盘；开盘涨停顺延买入、开盘跌停顺延卖出；T+1（买入当日不可卖）", "推断"],
    ["费用", `佣金 ${(context.params.commissionRate * 10000).toFixed(2)}‱（最低 ${context.params.commissionMin} 元）+ 印花税 ${(context.params.stampTaxRate * 1000).toFixed(2)}‰（卖出）+ 过户费 ${(context.params.transferFeeRate * 10000).toFixed(2)}‱`, "工程"],
    ["滑点", "0（V1 不建模；短周期策略的真实滑点会显著恶化结果）", "工程"],
    ["仓位", `逐票独立、单笔满仓、每票初始资金 ${context.params.capital.toLocaleString("en-US")} 元、整手 ${context.params.lotSize} 股`, "工程"],
    ["最短样本", `${context.params.minBars} 个交易日`, "工程"],
  ];
  lines.push(table(["项", "取值", "来源"], paramRows));
  lines.push("");

  lines.push("## 四、总体结果");
  lines.push("");
  lines.push(table(["指标", "全部样本"], statRows(summary)));
  lines.push("");
  lines.push("有交易的样本单独看：");
  lines.push("");
  lines.push(table(["指标", "仅有交易的样本"], statRows(tradedSummary, { quantiles: true })));
  lines.push("");

  lines.push("## 五、按年份");
  lines.push("");
  lines.push(yearBuckets.length > 0 ? bucketTable(yearBuckets) : "样本内没有交易，无法分年。");
  lines.push("");
  lines.push("（按买入年份分桶：同一只票跨年的交易会落进不同桶，不按标的摊平。）");
  lines.push("");

  lines.push("## 六、按板块");
  lines.push("");
  lines.push(boardBuckets.length > 0 ? bucketTable(boardBuckets) : "样本内没有交易。");
  lines.push("");

  lines.push("## 七、单笔收益分布");
  lines.push("");
  if (histogram.length === 0) {
    lines.push("无交易。");
  } else {
    const maxCount = Math.max(...histogram.map((bucket) => bucket.count));
    for (const bucket of histogram) {
      const bar = "█".repeat(maxCount === 0 ? 0 : Math.round((bucket.count / maxCount) * 30));
      lines.push(`\`${pct(bucket.from, 0)} ~ ${pct(bucket.to, 0)}\` ${bar} ${bucket.count}`);
    }
    lines.push("");
    lines.push(
      `分布比平均值更能说明问题：均值会被少数大赚的单子拉高，中位数（${pct(summary.medianNetReturn, 2)}）才是"典型一笔"的样子。`,
    );
  }
  lines.push("");

  lines.push("## 八、个股两端（按策略总收益）");
  lines.push("");
  if (top.length === 0) {
    lines.push("无交易。");
  } else {
    lines.push("### 最好 10 只");
    lines.push("");
    lines.push(table(STOCK_HEADERS, stockRows(top)));
    lines.push("");
    lines.push("### 最差 10 只");
    lines.push("");
    lines.push(table(STOCK_HEADERS, stockRows(bottom)));
  }
  lines.push("");

  lines.push("## 九、局限与不可外推项");
  lines.push("");
  lines.push("1. **宇宙是代理**：成交额排名 ≠ 人气榜；真实榜单只有约 12 个月历史（见 issue #32）。");
  lines.push("2. **样本区间单一**：结论只对报告开头的区间成立，跨牛熊的稳定性没有证据。");
  lines.push("3. **滑点未建模**：信号次日开盘的价格冲击、短周期高频交易的成本被低估。");
  lines.push("4. **涨跌停不可成交是近似**：开盘价等于涨跌停价即视为不可成交，实际盘中可能打开。");
  lines.push("5. **ST 历史状态不可知**：涨跌停幅度按「板块 + 当前名称」确定；当前非 ST、但历史上曾戴帽的主板股票，其历史 5% 板会被按 10% 漏判（反过来没有假阳性：不把普通股 +5% 当涨停）。");
  lines.push("6. **期末未平仓按收盘价计值**：未计卖出费用，持仓风险没有被体现。");
  lines.push("7. **分红按再投资近似**：收益换算到后复权空间（送转/拆股不会记成暴跌），但现金分红被当成再投资，未单独计息。");
  lines.push("8. **幸存者偏差部分存在**：库内标的为当前可取得的全市场清单，退市股覆盖不完整。");
  lines.push("");

  lines.push("## 十、复现");
  lines.push("");
  lines.push("```bash");
  lines.push(context.command);
  lines.push("```");
  lines.push("");
  return lines.join("\n");
}

function boardKeyOf(label: string): string {
  const entry = Object.entries(BOARD_LABELS).find(([, value]) => value === label);
  return entry ? entry[0] : label;
}

function formDate(key: number | null): string {
  if (key === null) return "—";
  try {
    return fromDateKey(key);
  } catch {
    return String(key);
  }
}

const TRADE_HEADERS = [
  "code",
  "signal_date",
  "entry_date",
  "entry_price",
  "exit_date",
  "exit_price",
  "shares",
  "entry_delay",
  "holding_days",
  "cost",
  "proceeds",
  "fees",
  "gross_return",
  "net_return",
  "open_at_end",
] as const;

function csvCell(value: string | number | boolean): string {
  const text = typeof value === "number" ? value.toFixed(6) : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 交易明细 CSV：一行一笔，便于丢进表格软件做二次分析。 */
export function tradesToCsv(results: readonly StockResult[]): string {
  const rows: string[] = [TRADE_HEADERS.join(",")];
  for (const result of results) {
    for (const trade of result.trades) {
      rows.push(
        [
          trade.code,
          String(trade.signalDate),
          String(trade.entryDate),
          trade.entryPrice,
          String(trade.exitDate),
          trade.exitPrice,
          trade.shares,
          trade.entryDelay,
          trade.holdingDays,
          trade.cost,
          trade.proceeds,
          trade.fees,
          trade.grossReturn,
          trade.netReturn,
          trade.openAtEnd,
        ]
          .map(csvCell)
          .join(","),
      );
    }
  }
  return `${rows.join("\n")}\n`;
}

/** 逐票汇总 CSV。 */
export function stocksToCsv(results: readonly StockResult[]): string {
  const headers = [
    "code",
    "name",
    "board",
    "start_date",
    "end_date",
    "trades",
    "eligible_signals",
    "unfilled_signals",
    "total_return",
    "buy_hold_return",
    "max_drawdown",
  ];
  const rows: string[] = [headers.join(",")];
  for (const result of results) {
    rows.push(
      [
        result.code,
        result.name ?? "",
        result.board,
        String(result.startDate),
        String(result.endDate),
        result.trades.length,
        result.eligibleSignals,
        result.unfilledSignals,
        result.totalReturn,
        result.buyHoldReturn ?? "",
        result.maxDrawdown,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${rows.join("\n")}\n`;
}

export type { Trade };

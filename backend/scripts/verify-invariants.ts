#!/usr/bin/env tsx
/**
 * 本地日K库的不变式检查（对真实库跑，不是夹具）。
 *
 *   npm run verify:invariants
 *
 * 前面所有测试验的都是**代码**；这一支验的是**数据**。
 * 三张表之间存在应当始终成立的关系，而它们一旦被破坏，
 * 表现是"筛选结果看起来正常但偏了"——没有异常、没有报错，只是悄悄不对。
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.MARKET_DB_PATH || join(BACKEND_ROOT, "data", "kline.sqlite");

if (!existsSync(dbPath)) {
  console.error(`✗ 找不到库：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });
const one = (sql: string): number => {
  const row = db.prepare(sql).get() as { n?: number } | undefined;
  return row?.n ?? 0;
};

type Check = { name: string; sql: string; why: string };
const CHECKS: Check[] = [
  /*
   * 一条**考虑过并明确否决**的检查，写在这里免得后人再加：
   *
   *   每只票的日线应当与交易日历逐日对齐（区间内不该缺日）
   *
   * 实测 1743 / 6030 只（28%）不满足，但这不是缺陷——它们是**停牌**。
   * 在市标的里 23.2% 有缺日，缺日中位数 5 天，分布是平滑重尾
   * （缺 1 天 340 / 2–5 天 605 / 6–20 天 635 / 21–100 天 144 / >100 天 19），
   * 正是停牌该有的形态；系统性数据错误会是聚集而非平滑。
   *
   * 而且：**丢一次增量留下的空洞与停牌在数据上无法区分**，
   * 所以这条检查不可能只抓后者——它必然产生 28% 的假阳性。
   *
   * 相关的正面结论：MA100 按「该票最近 100 根」算（而不是「最近 100 个日历交易日」），
   * 这对有停牌的票是标准做法，也是实现所选的口径。
   */
  {
    name: "复权因子恒为正",
    sql: "SELECT COUNT(*) AS n FROM bars WHERE adj_factor IS NULL OR adj_factor <= 0",
    why: "因子非正会让后复权价变成 0 或负数，均线随之失去意义",
  },
  {
    name: "OHLC 自洽（低 ≤ 开/收 ≤ 高）",
    sql: `SELECT COUNT(*) AS n FROM bars
          WHERE low > high OR low > open OR open > high OR low > close OR close > high`,
    why: "开盘或收盘落在当日高低区间之外，说明字段列错位",
  },
  {
    name: "成交量与成交额非负",
    sql: "SELECT COUNT(*) AS n FROM bars WHERE volume < 0 OR amount < 0",
    why: "负数会让成交额闸门与 VWAP 对账同时失效",
  },
  {
    name: "日线日期都在交易日历内",
    sql: `SELECT COUNT(*) AS n FROM bars b
          LEFT JOIN trading_calendar c ON c.date = b.date WHERE c.date IS NULL`,
    why: "日历用于除权判定（必须相邻交易日），日历缺日会让除权检测退化成'未判定'",
  },
  {
    name: "每只标的的日线按日期唯一",
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT code, date, COUNT(*) AS c FROM bars GROUP BY code, date HAVING c > 1)`,
    why: "主键本应保证；这条是防止将来换表结构时丢掉约束",
  },
  {
    // 「在交易」不等于「今天一定有成交」——当日停牌是正常现象，
    // 所以判据是"最后一条日线不能太久远"，而不是"必须有当日日线"。
    name: "在交易的标的没有被长期落下",
    sql: `SELECT COUNT(*) AS n FROM instruments i
          WHERE i.is_live = 1
            AND (SELECT MAX(date) FROM bars b WHERE b.code = i.code)
                < (SELECT date FROM trading_calendar ORDER BY date DESC LIMIT 1 OFFSET 20)`,
    why: "标记为在交易、最后一条日线却在 20 个交易日之前，说明增量长期漏了它（或退市判定错了）",
  },
  {
    // `latest_trade_date` 是为性能做的**记忆化**值（见 store.ts 的 latestDateMemo）：
    // 它一旦与真实数据脱节，`latestTradeDate()` 就会说谎，
    // 而整个筛选器会以为自己在另一天——用错日期的结果看起来照样正常。
    name: "meta.latest_trade_date 与日线真实最新日一致",
    sql: `SELECT COUNT(*) AS n FROM meta
          WHERE key = 'latest_trade_date'
            AND value <> (SELECT CAST(MAX(date) AS TEXT) FROM bars)`,
    why: "记忆化值与真实数据脱节会让筛选器在错误的交易日上工作",
  },
  {
    name: "估值表的日期都在交易日历内",
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT date FROM valuation
            EXCEPT SELECT date FROM trading_calendar)`,
    why: "估值落在非交易日，说明日期解析错了（列序或格式）",
  },
  {
    name: "估值表的日期都有对应的个股日线",
    sql: `SELECT COUNT(*) AS n FROM (
            SELECT DISTINCT date FROM valuation
            EXCEPT SELECT DISTINCT date FROM bars)`,
    why: "有估值却没有日线，说明两个源覆盖的交易日不一致",
  },
  {
    name: "股票池里不应混入指数",
    sql: "SELECT COUNT(*) AS n FROM instruments WHERE board = 'index'",
    why: `指数不是可交易的个股。它们目前被板块开关挡在候选之外，所以不影响结果，
          但会虚高漏斗第一档的"全市场"计数——第一档应当只数个股`,
  },
];

let failed = 0;
console.log(`库：${dbPath}\n`);
for (const check of CHECKS) {
  const started = Date.now();
  let n: number;
  try {
    n = one(check.sql);
  } catch (err) {
    console.log(`  ✗ ${check.name} —— 查询失败：${err instanceof Error ? err.message : err}`);
    failed++;
    continue;
  }
  const ms = Date.now() - started;
  if (n === 0) {
    console.log(`  ✓ ${check.name}（${ms}ms）`);
  } else {
    failed++;
    console.log(`  ✗ ${check.name} —— 违反 ${n.toLocaleString("en-US")} 行（${ms}ms）`);
    console.log(`      为什么重要：${check.why}`);
  }
}
db.close();
console.log(`\n${failed === 0 ? "全部通过" : `${failed} 项未通过`}`);
if (failed > 0) process.exitCode = 1;

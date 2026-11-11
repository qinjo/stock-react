# 热门列表数据可得性调研

- **日期**：2026-11-11
- **状态**：结论已用于「KDJ 金叉/死叉策略回测」的宇宙定义（决策见 §7）
- **相关**：[ADR-0004 全市场筛选器的数据层](adr/0004-market-wide-screener-data.md)、[ADR-0001 行情数据源主备](adr/0001-data-source-strategy.md)、`backend/data/kline.sqlite`（本地日 K 库）

## 为什么有这份文件

拟回测的策略，宇宙定义是「**近一个月内出现在热门列表、且期间有过涨停**」的股票。
动手之前必须回答一个数据问题：**历史热门列表成员能不能重建？** 只有当前快照的话，回测无从谈起。

仓库里原本没有任何热度/人气相关代码（`hot_rank`/`人气`/`热榜` 全仓无命中；`docs/spec-screener.md` 把「热点视图」推到 v2），
所以这份文件的目的不是解释已有实现，而是**把"能不能做、做到什么程度、代价是什么"钉死**，供回测与后续数据层决策引用。

方法与上一轮筛选器调研一致：**以本机实测为准，不转述文档**。本文所有"✅ 实测"标注均为 2026-11-11 在本机发出的真实请求。

## 一、结论先行

1. **真实人气榜历史存在，但硬上限 ≈ 366 天**（含周末，一天一行），且免费路径是**逐票**返回排名，不是逐日 Top-N。
2. **要重建"某日 Top-N 成员"，必须把全市场扫一遍**：约 5,400 次 POST。免费、无需 key，但触及本仓 ADR-0004 记录的东财 IP 封禁模式，**必须限速 + 落盘 + 可续跑**。
3. **一年以上的人气榜，任何免费源都拿不到**——所以"热门宇宙"回测窗口最多 12 个月，且落在单一市场环境里，结论不可外推。
4. 若放弃人气榜，有三个**可完整重建**的替代宇宙（成交额排名 / 涨停·连板 / 龙虎榜），能把窗口拉长到 6 年（本地库全量区间），但语义与"热门"不完全等价。

## 二、数据源实测表

| 来源 | 端点 | 历史? | 区间 | 成本 / 限制 | 可靠性 |
|---|---|---|---|---|---|
| **东财 人气榜历史**（主选） | `POST https://emappdata.eastmoney.com/stockrank/getHisList`<br>`{appId:"appId01", globalId:"786e4c21-70dc-435a-93bb-38", marketType:"", srcSecurityCode:"SZ000665", yearType:"5"}`<br>→ `{status:0, data:[{calcTime:"2026-11-11", rank:1493}, …]}` | ✅ **逐票**每日排名 | **366 行硬顶**（`yearType`=1/3/5 实测 182/366/366），返回区间恰为「今天 − 365 天 → 今天」，**含周末** | 免费、无需 key；全市场矩阵需 ~5,400 次 POST（0.2–0.7 s 间隔约 18 分钟–1 小时） | 实测 3/3 成功（0.5 s 间隔）；**接口未公开文档**，稳定性未经验证 |
| 东财 人气榜当前 | `getAllCurrentList` / `getCurrentList`（akshare `stock_hot_rank_em`） | ❌ 快照 | 仅当日 Top 100 | 免费 | 稳定 |
| 东财 涨停股池 | `push2ex.eastmoney.com/getTopicZTPool?date=YYYYMMDD`（akshare `stock_zt_pool_em`） | ❌ **只有 t / t−1** | 探针 2020-01-06 / 2023-01-03 / 2025-06-02 均 `tc:0` 空；仅 2026-11-10、11-11 有数据 | 免费 | 官方文档亦写明"只能获取近期数据" |
| 东财 千股千评 关注指数 | `datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_STOCK_MARKETFOCUS` | ⚠️ 逐票，**最多 30 行** | 实测 2026-09-23 → 2026-11-11 | 免费 | 是**关注度水平值**，不是全市场位次，无法直接换算 Top-N |
| 东财 龙虎榜 | `datacenter-web…RPT_DAILYBILLBOARD_DETAILSNEW?filter=(TRADE_DATE='2015-01-05')` | ✅ 按日 | 2015 → 今，免费、分页 | 每日仅 **20–90 只**，太稀疏 | 好 |
| tushare `ths_hot` | `pro.ths_hot(trade_date, market='热股')` | ✅ 逐日 Top-N（含 `hot`、`rank_time`） | 约 2024 起 | **6000 积分** | 官方，形状最正 |
| tushare `dc_hot` | `pro.dc_hot(trade_date, hot_type='人气榜')` | ✅ 逐日 Top-N | 约 2024 起 | **8000 积分** | 官方 |
| 同花顺数据 API（HiThink） | `GET /api/a-share/special-data/hot-stock-list-history?date=`<br>`GET …/hot-stock-rank-trend?thscode=&start_date=&end_date=` | ✅ **逐日列表** + 逐票趋势 | "只支持一年内数据" | 商业 API key、按次计费；30 天窗口 30 次调用 | 形状最贴合 |
| 雪球（关注/讨论/交易热度） | xueqiu hq 系列 | ❌ 快照 | 仅当前 | 免费但有反爬 | 一般 |
| 淘股吧 / 韭研公社 | — | ❌ | — | 无公开 API（仅 HTML） | 不可用 |

## 三、实测细节（东财 `getHisList`）

```bash
curl -s -X POST 'https://emappdata.eastmoney.com/stockrank/getHisList' \
  -H 'Content-Type: application/json' -H 'User-Agent: Mozilla/5.0' \
  -d '{"appId":"appId01","globalId":"786e4c21-70dc-435a-93bb-38","marketType":"",
       "srcSecurityCode":"SZ000665","yearType":"5"}'
```

- 三只标的（`SZ000665` / `SH600519` / `SZ300750`）均返回 **366 行**，首尾恰为 `2025-11-11` → `2026-11-11`，0.5 s 间隔 3/3 成功。
- 行是**自然日**粒度：2025-11-15 / 11-16 为周末仍存在（说明非交易日沿用前一交易日排名，或排名本身按自然日计算——**待确认**，见 §8）。
- `rank` 是全市场位次（观测值 50 / 799 / 1320 / 1817 …），量级约 5,000 名，因此"rank ≤ N"可直接当"进入热门列表"。
- 无需登录、无需 cookie。`globalId` 与 `appId01` 为固定常量（来自前端页面抓包），未验证是否可缺省。

## 四、东财路径的工程风险

本仓 [ADR-0004](adr/0004-market-wide-screener-data.md) 记录过真实封禁：突发 `clist?pz=6000` 会**立即封禁 ≥10 分钟**，且波及 `push2his`。
`emappdata` 是另一个域名，本次实测未触发，但**没有任何证据表明它豁免**：

- 必须**串行 + 间隔 ≥0.3 s**（建议 0.5–0.7 s），全量一次约 45 分钟–1 小时；
- 进度必须**可续跑**（按 code 断点），失败重试带退避；
- 结果落本地 SQLite，后续回测**只读本地**，绝不重复爬。

这与仓库既有的硬约束一致：**严禁逐票扇出轮询**。本方案的爬取是**一次性数据回填**，与"筛选时逐票轮询"性质不同，
但按 `AGENTS.md` 的约定，**引入新的数据层必须写 ADR**（见 §7 决策 3）。

## 五、代理宇宙（可回 6 年，全部可由 `bars` 重建）

| 代理 | 可重建性 | 语义偏离 | 备注 |
|---|---|---|---|
| **成交额排名**（近 20 交易日成交额分位/名次） | ✅ `bars.amount` 全量有 | 热门 ≈ 资金关注，但不等于散户人气 | **优于换手率**：换手率需要历史流通股本，库中只有当前 `float_market_cap`，无法回溯 |
| **涨停 / 连板数** | ✅ 已有 `screener/structure.ts:459-493` | 只覆盖情绪最极端的一小撮 | 需补 ST 5% 与跌停判定（见 §6） |
| **龙虎榜** | ✅ 按日可查（2015 起，免费） | 机构/游资席位关注，每日仅 20–90 只 | 适合做第二验证通道，不适合当主宇宙 |

## 六、回测用到的数据前提（本次核实）

- **本地库已过期**：`bars` 最新 `2026-09-30`，今天 `2026-11-11`，差 6 周。跑回测前必须 `npm run update:kline`。
- **无历史流通股本** → 换手率不可重建，只能用成交额。
- **无历史 ST 标记**：`instruments.name` 只是当前名称。因此"当日是否涨停"不能靠板块固定比例+ST 标记，
  应按 `close / prev_close` 实际涨幅反推（约 1.05 / 1.10 / 1.20 / 1.30），既不依赖 ST 状态也自然覆盖 20cm/30cm 板。
- **复权口径必须并存**：指标（KDJ）算在 `close × adj_factor`（后复权，跨除权连续）上；
  成交价、涨停价、涨跌停不可成交判定算在**不复权**价上。这是两个价格空间，代码里必须显式区分。

## 七、决策（2026-11-11 用户确认）

1. **双宇宙并行**：A = 真实人气榜（东财 `getHisList`，窗口≈12 个月）；C = 可重建代理宇宙（成交额 + 涨停，窗口 6 年）。两者分开报告，**不把收益数字放同一张表横向比**。
2. **A 的窗口强制标注**：报告顶部写死"样本区间 2025-11→2026-11，单一市场环境，不外推"。
3. **数据层新增**：一次性回填表 `hot_rank(code, date, rank)`（草案：`PRIMARY KEY(code, date)`，`date` 沿用 `bars.date` 的 `YYYYMMDD` 整数键）；此后**每个交易日必须冻结一次当日快照**，否则一年后这 12 个月同样会消失。按约定需补一份 ADR。
4. **付费路径不采用**：tushare 6000/8000 积分、同花顺商业 API 仅在东财爬取被封时作为退路，不进默认流程。

## 八、开放问题（未验证，实现前应补测）

- `rank` 缺失/停牌标的如何表示（返回 `rank: 0`？直接缺行？）——影响"当日 Top-N 成员"的判定。
- 每日被 tracked 的股票总数（分母）不固定，`rank ≤ N` 是否可直接跨日比较。
- 北交所（`bj`，库内 598 只）是否被该接口覆盖、`srcSecurityCode` 前缀是什么（`BJ…`？8 开头？）。
- 周末行为：沿用前一交易日 vs 独立计算——决定回测是按交易日还是自然日对齐。
- 全量爬取的真实速率上限（本次只测了 25–28 次请求，未做长跑压测）。
- 该接口无公开文档，是否有版本/参数变更风险。

## 九、来源

- [akshare 板块与热度数据](https://akshare.akfamily.xyz/data/stock/stock_board.html)
- [akshare 涨停板行情](https://akshare.akfamily.xyz/data/stock/stock_quote.html)
- [tushare ths_hot](https://tushare.pro/document/2?doc_id=320) / [tushare dc_hot](https://tushare.pro/document/2?doc_id=321)
- [同花顺 历史热股榜](https://fuyao.aicubes.cn/docs/mcp/tools/get_a_share_special_data_hot_stock_list_history/) / [同花顺 热股排名趋势](https://fuyao.aicubes.cn/docs/mcp/tools/get_a_share_special_data_hot_stock_rank_trend/)
- [akshare `stock_hot_rank_em` 源码](https://github.com/akfamily/akshare/blob/main/akshare/stock/board/stock_hot_rank_em.py)

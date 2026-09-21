# A股智能分析（stock-react）

输入 A 股代码或名称 → 免费接口取行情与历史数据 → 大模型生成结构化投研分析（评级 / 置信度 / 目标价 / 五节报告）→ 信号卡 + K 线图展示。

> ⚠️ **免责声明**：本项目所有分析结论均由 AI 生成，仅供学习与研究参考，**不构成任何投资建议**。数据来自公开免费接口，可能存在延迟、缺失或错误，请以交易所与上市公司披露为准。

---

## 功能

- **股票搜索**：支持 6 位代码、`sh/sz` 前缀、`.SH/.SZ` 后缀，以及中文名称模糊搜索（如「茅台」），带防抖补全下拉与键盘操作
- **行情快照**：最新价、涨跌幅、今开/最高/最低/昨收、市值、PE、PB、换手率、涨跌停价，并标注数据截至日
- **日 K 走势图**：250 根前复权日 K（klinecharts，支持缩放/十字光标），主图叠加 MA50 / MA200
- **派生技术指标**：SMA50/200、RSI14、MACD(DIF/DEA/HIST)、ATR14、20/60 日涨跌幅、20 日年化波动率、区间位置等约 12 项，并在页面上以紧凑面板呈现（含 RSI 分区提示与多空动能标注）
- **财务基本面**：近 8 个报告期的营收/净利/同比/ROE/毛利率/净利率/资产负债率/EPS/BPS/每股经营现金流
- **历史估值分位**：PE_TTM/PB_MRQ 的日度历史序列（约 6.4 年）→ 近 3 年与近 5 年分位，回答「估值相对自身历史是高是低」
- **同业估值对比**：行业 PE/PB 中位与个股在行业内的排名 → 回答「估值相对同行业是贵是贱」（与自身历史分位常出现背离，是重要信号）
- **隐含估值量**：由 PE/PB 反推 ROE、EPS、每股净资产、净利润（零外部数据的推导值，会明确标注为推断）
- **AI 分析**：5 档评级 + 0-100 置信度 + 目标价/时间窗 + 五节报告（快照 / 基本面 / 技术面 / 风险清单 / 结论）
- **异常契约**：区分「数据不足」「分析失败」「数据源不可用」三态，数据不足时明确 abstain 而非硬凑结论
- **缓存**：以「股票 + 交易日」为键的分析缓存（TTL 默认 10 分钟），同票重复查询零 LLM 调用，跨交易日自动失效
- **成本可观测**：每次分析在信号卡上显示真实 token 用量（输入/输出/命中缓存部分）

## 界面布局

宽屏采用**两栏**：左栏为行情（身份快照 + K 线 + 技术指标）并启用 `sticky`，右栏为 AI 分析（信号卡 + 五节报告）。这样阅读长报告时行情与图表不会滚走，便于随时对照；窄屏自动降级为单列堆叠。

## 架构

```
浏览器（React + Vite + Tailwind + klinecharts）
   │  /api/*  （Vite dev proxy → 后端，生产由反代承担）
   ▼
后端（Node + Fastify + TypeScript）
   ├── routes/data.ts       /api/search /api/quote /api/kline /api/indicators
   ├── routes/analyze.ts    /api/analyze（编排 + 缓存）
   ├── datasource.ts        主备降级：东方财富（主） → 腾讯财经（备）
   ├── eastmoney.ts         东财适配器（字段 ×100 缩放、K线列序、secid 解析）
   ├── tencent.ts           腾讯适配器（GBK 解码、市值/成交额单位换算、搜索）
   ├── indicators.ts        派生指标（technicalindicators；纯函数）
   ├── derived.ts           隐含估值量（PB/PE→ROE 等）与多空一致性统计
   ├── fundamentals.ts      财报主指标 + 日度估值历史 → 估值分位、同业对比（datacenter-web）
   ├── cache.ts             分析缓存（键=股票+交易日，TTL 可配）
   ├── rate-limit.ts        按 IP 限流（公开部署时启用）
   └── analysis/
        ├── prompt.ts       六段 persona 提示词构造器
        ├── llm.ts          DeepSeek 客户端（deepseek-chat + JSON 模式）
        ├── parse.ts        三级回退解析 + 校验 + 空值兜底
        └── index.ts        编排：重试一次 → abstain
   ▼
东方财富（push2/push2his）／腾讯财经（qt/fqkline/smartbox）／DeepSeek API
```

**分层原则**：外部数据源细节全部收敛在适配器内，上层只见领域模型；派生指标由代码计算，绝不交给模型算。

## 快速开始

```bash
# 1) 后端
cd backend
npm install
cp .env.example .env        # 填入 DEEPSEEK_API_KEY
npm run dev                 # http://127.0.0.1:3001

# 2) 前端（另开终端）
cd frontend
npm install
npm run dev                 # http://localhost:5173
```

未配置 `DEEPSEEK_API_KEY` 时行情功能可用，分析接口返回 503 并在页脚提示「分析未就绪」。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | — | **必填**（仅服务端持有，不下发前端） |
| `DEEPSEEK_MODEL` | `deepseek-chat` | 模型名 |
| `PORT` / `HOST` | `3001` / `127.0.0.1` | 监听地址 |
| `ANALYSIS_CACHE_TTL_MS` | `600000` | 分析缓存 TTL（10 分钟） |
| `RATE_LIMIT_ENABLED` | `false` | 公开部署时设为 `true` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `30` / `60000` | 每 IP 每窗口请求数 |

## API

| 端点 | 说明 |
|---|---|
| `GET /api/health` | 健康检查；`analysisReady` 表示是否已配置 API key |
| `GET /api/search?q=` | 名称/代码补全，返回 `{ candidates: [...] }` |
| `GET /api/quote?code=` | 实时快照 |
| `GET /api/kline?code=&limit=60` | 日 K（前复权，limit 上限 500） |
| `GET /api/indicators?code=&limit=250` | 派生技术指标 |
| `GET /api/fundamentals?code=` | 财报 + 估值分位 + 同业对比（**不消耗 LLM 调用**） |
| `GET /api/analyze?code=` | 完整 AI 分析（含缓存），响应带 `usage` token 用量 |

**统一错误形状**（前端按 `code` 分流展示）：

```json
{ "status": "error", "code": "SOURCE_UNAVAILABLE", "message": "行情数据源暂时不可用" }
```

`code` 取值：`INVALID_INPUT` / `NOT_FOUND` / `SOURCE_UNAVAILABLE` / `INSUFFICIENT_DATA` / `ANALYSIS_FAILED` / `RATE_LIMITED`。

## 提示词工程（本项目学习重点）

提示词采用六段 persona 模板（借鉴 [ai-hedge-fund](https://github.com/virtrat/ai-hedge-fund) 现版 v2.2.0）：

1. **角色定位** —— 「资深 A 股投研分析师，长期价值与风险平衡视角」
2. **清单式思维链** —— 估值 → 趋势 → 动能 → 波动 → 多空论据 → 结论，每步一句话
3. **信号规则** —— 5 档评级各自成立的条件
4. **置信度分档锚定** —— 90-100 / 70-89 / 40-69 / 10-39 各自的语义，先给语义再让模型填数（比裸数字稳定）
5. **硬规则** —— 三段防幻觉约束：
   - 只依据给定数据推理，**不发明数字**
   - **点时间约束**：把「数据截至日」当作今天，不使用此后发生的信息
   - 数据不足时必须说明，而非强行下结论
6. **JSON-only 输出** —— 明确 schema，字段不可增删改名

配套的三个工程约束：

- **不让模型做算术**：均线、RSI、MACD、波动率等全部由 `indicators.ts` 算好喂入
- **点时间对齐**：快照、指标、K 线各自标注数据日期；提示词以数据截至日为「今天」
- **abstain 与失败可区分**：解析失败重试一次后进入 abstain，绝不静默降级为「中性」（看空 ≠ 无法判断）

一个值得记录的坑：缓存键**不能用提示词全文哈希**。ai-hedge-fund 那样做是因为其输入是季度财报（期内稳定）；本项目输入含实时行情，盘中价格逐秒变化会让全文哈希永不命中，每次查询都真实调用 LLM。故改为「股票 + 交易日」——同交易日复用，跨交易日失效。

解析层做了三级回退（代码块 → 整串 → 首个平衡花括号块）与空值兜底（`None`/`N/A`/`-` → `null`），可参考 `backend/src/analysis/parse.ts` 的测试。

## 数据源策略

A 股行情采用**东方财富为主、腾讯财经为备的自动降级**；搜索使用腾讯 smartbox。原因与代价记录在 [`docs/adr/0001-data-source-strategy.md`](docs/adr/0001-data-source-strategy.md)。

**基本面数据**走 `datacenter-web.eastmoney.com`（东财数据中心）：免 key、CORS `*`、实测零限流，且其反爬与 push2 是**按域名隔离**的——push2 被封期间它照常可用。这一点很关键：行情与基本面互不拖累。

**一个值得记录的坑**：缓存键**不能用提示词全文哈希**。ai-hedge-fund 那样做是因为其输入是季度财报（期内稳定）；本项目输入含实时行情，盘中价格逐秒变化会让全文哈希永不命中，每次查询都真实调用 LLM。故改为「股票 + 交易日」——同交易日复用，跨交易日失效。

要点：东财 push2 有 IP 级反爬（密集请求后整段断连），单源会让页面直接不可用；腾讯实时接口是 GBK 编码，成交额/市值单位为万元/亿元，适配层已统一换算为元，上层无需感知来源差异。

## 成本

实测单次约 **7000 token**（提示词含快照/指标/隐含估值/财报/估值分位/60 根日 K + 约 2200 token 输出），按 DeepSeek 公开价格量级约 **¥0.02–0.04/次**；命中缓存时为 0。一天查询 50 次约 1–2 元。

提示词重构与数据补全后 token 较早期翻倍（3300→7000）、耗时约 12 秒——这是「报告深度」换来的成本，可通过下调 fundamentals 字数下限与 monitoring 条数回调。

## 测试

```bash
cd backend  && npm test   # 107 项：适配器 fixture、指标手算校验、fake LLM 主 seam、缓存、限流
cd frontend && npm test   #  32 项：搜索补全、快照卡、图表数据转换、分析三态
```

测试原则：**只测外部行为，永不触网**。适配器用真实录制的 fixture（东财 JSON、腾讯 GBK 原始字节），LLM 用 fake 注入，关键指标用独立手算断言而非照抄库输出。

## 开发文档

- 规格：[`docs/spec.md`](docs/spec.md)（对应 issue #1）
- 数据源决策：[`docs/adr/0001-data-source-strategy.md`](docs/adr/0001-data-source-strategy.md)
- 调研笔记：[`_research/开源LLM金融分析项目调研笔记.md`](_research/开源LLM金融分析项目调研笔记.md)、[`free-stock-api-research.md`](free-stock-api-research.md)

## 范围之外（当前版本）

美股（适配器已预留扩展点）、多股对比、自选/持仓管理、历史分析记录、定时任务、回测与实盘交易、新闻/社交情绪数据源、用户系统与数据库持久化。

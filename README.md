# A股智能分析（stock-react）

输入 A 股代码或名称 → 免费接口取行情与历史数据 → 大模型生成结构化投研分析（评级 / 置信度 / 目标价 / 五节报告）→ 信号卡 + K 线图展示。

> ⚠️ **免责声明**：本项目所有分析结论均由 AI 生成，仅供学习与研究参考，**不构成任何投资建议**。数据来自公开免费接口，可能存在延迟、缺失或错误，请以交易所与上市公司披露为准。

---

## 功能

- **股票搜索**：支持 6 位代码、`sh/sz` 前缀、`.SH/.SZ` 后缀，以及中文名称模糊搜索（如「茅台」），带防抖补全下拉与键盘操作
- **行情快照**：最新价、涨跌幅、今开/最高/最低/昨收、市值、PE、PB、换手率、涨跌停价，并标注数据截至日
- **日 K 走势图**：60 根前复权日 K（klinecharts，支持缩放与十字光标）
- **派生技术指标**：SMA50/200、RSI14、MACD(DIF/DEA/HIST)、ATR14、20/60 日涨跌幅、20 日年化波动率、区间位置等约 12 项
- **AI 分析**：5 档评级 + 0-100 置信度 + 目标价/时间窗 + 五节报告（快照 / 基本面 / 技术面 / 风险清单 / 结论）
- **异常契约**：区分「数据不足」「分析失败」「数据源不可用」三态，数据不足时明确 abstain 而非硬凑结论
- **缓存**：提示词哈希缓存（TTL 默认 10 分钟），同票重复查询零 LLM 调用

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
   ├── cache.ts             提示词哈希缓存（sha256 + TTL）
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
| `GET /api/analyze?code=` | 完整 AI 分析（含缓存） |

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

解析层做了三级回退（代码块 → 整串 → 首个平衡花括号块）与空值兜底（`None`/`N/A`/`-` → `null`），可参考 `backend/src/analysis/parse.ts` 的测试。

## 数据源策略

A 股行情采用**东方财富为主、腾讯财经为备的自动降级**；搜索使用腾讯 smartbox。原因与代价记录在 [`docs/adr/0001-data-source-strategy.md`](docs/adr/0001-data-source-strategy.md)。

要点：东财 push2 有 IP 级反爬（密集请求后整段断连），单源会让页面直接不可用；腾讯实时接口是 GBK 编码，成交额/市值单位为万元/亿元，适配层已统一换算为元，上层无需感知来源差异。

## 成本

单次分析约 3000–4700 token（提示词 + 快照 + 指标 + 60 根日 K + 输出），按 DeepSeek 公开价格量级约 **¥0.02–0.05/次**；命中缓存时为 0。一天查询 50 次约 1–2.5 元。

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

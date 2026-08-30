# 开源 LLM 金融分析项目调研笔记
### —— tradingAgents / OpenBB / ai-hedge-fund 的提示词与数据设计参考

> **调研方式说明**：本会话的 web_search 服务因缺少 API key 不可用，因此本笔记**全部基于三个仓库当前 HEAD 的实际源码**逐一核对（比二手文章更可靠）。各仓库基线：
> - **ai-hedge-fund**（virattt/ai-hedge-fund）@ `eff8a73`（v2.2.0，2026-08）
> - **TradingAgents**（TauricResearch/TradingAgents）@ `a33fd4c`（2026-07）
> - **OpenBB**（OpenBB-finance/OpenBB）@ `3e071fc`（2026-07），重点读 `openbb_platform/extensions/mcp_server` 与 `examples/openbbPlatformAsLLMTools.ipynb`
>
> 源码克隆在 `_research/{ai-hedge-fund,TradingAgents,OpenBB}/`，下文所有文件路径均相对各自仓库根。

---

## 0. 一页速览

| 维度 | ai-hedge-fund（当前版） | TradingAgents | OpenBB |
|---|---|---|---|
| 定位 | 可回测的"AI 对冲基金"：多 persona 投研 + 组合构建 | LangGraph 多智能体：分析师→牛熊辩论→风险辩论→决策 | 数据平台：把全市场数据暴露给 LLM（工具层） |
| 提示词载体 | **人设 persona = 一个 system prompt**，另有 5 个 LLM 代理共用 | 每个 agent 一个 prompt + Pydantic 结构化输出 | 几乎没有 prompt，给的是**函数 schema**（字段自带 description） |
| 输出形态 | **纯结构化**：固定 JSON `{signal, confidence, reasoning}` | **两者兼有**：分析师/辩手出 markdown 报告，决策层出结构化 JSON | 工具返回 `OBBject`（结构化），分析文本由接入的 LLM 自由产出 |
| 值得抄的核心 | persona 提示词六段模板；点时间(Point-in-Time)快照；abstain 失败契约；prompt 缓存 | 辩论注入"对方论点"；指标菜单式工具调用；field description 当输出指令 | MCP + 按需工具发现（防 token 膨胀）；schema-first 字段文档化 |

> ⚠️ 重要认知更新：**ai-hedge-fund 在 2026 年已重构**。网上绝大多数文章介绍的老版 7-agent（`value_investor / sentiment_investor / fundamentals_investor / technician → risk_management → portfolio_manager → trader`）已不存在于当前 HEAD。当前版本把"分析师"重写为可回测的 **AlphaModel**（LLM persona 与量化模型统一接口），本笔记以当前 HEAD 为准，老架构仅作背景说明。

---

## 1. 每个项目"分析提示词 / 分析框架"的核心结构

### 1.1 ai-hedge-fund：persona 化提示词 + 统一 Signal 输出

**框架总览**（`hedge_fund/`）：
- 模型分层：`AlphaModel`（视图）→ `Signal`；视图与仓位决策分离（`signals/base.py` 明说 "the alpha model only forms a view. It does NOT decide position mechanics"）。
- 信号注册表 `ALPHA_MODEL_REGISTRY`（`signals/__init__.py`）：量化模型 `pead` + LLM 代理 `buffett / munger / graham / lynch / druckenmiller`。
- 策略即数据：YAML 描述"哪些模型 + 权重 + 混合策略"（`fund/spec.py`、`strategies/deep-value.yaml`）：

```yaml
# strategies/deep-value.yaml
name: deep-value
display_name: Deep Value
models:
  - name: graham
    weight: 2.0        # 格雷厄姆权重翻倍
  - name: buffett
  - name: munger
blend:
  method: conviction_weighted
  gross_target: 1.0
```

**Persona 提示词模板**（`signals/buffett.py`、`graham.py`、`munger.py`、`lynch.py`、`druckenmiller.py` 几乎同构，是绝佳的参考模板）：

```
You are Warren Buffett, evaluating a single company as a
long-term business owner, not a trader.

Work through your checklist:          ← ① 角色定位（第一人称）
1. Circle of competence ...           ← ② 清单式思维链（5-6 步，每步一句话）
2. Competitive moat — durable high returns on equity, ...
3. Management quality — ...
4. Financial strength — ...
5. Valuation — ...
6. Long-term prospects — ...

Signal rules:                         ← ③ 信号判定规则（每档一句）
- bullish:   <条件>
- bearish:   <条件>
- neutral:   <条件>

Confidence scale (0-100):             ← ④ 置信度分段锚定
90-100 exceptional conviction ...; 70-89 solid conviction; 40-69 mixed; 10-39 weak.

Hard rules:                           ← ⑤ 硬规则（防幻觉核心）
- Reason ONLY from the data provided. Treat the most recent filing date
  shown as the present day; do not use any knowledge of anything that
  happened after it. Do not invent numbers.
- If the data is insufficient to judge, say so and go neutral.

Respond with JSON only, in exactly this schema:   ← ⑥ 强制 JSON
{"signal": "bullish" | "bearish" | "neutral",
 "confidence": <0-100>,
 "reasoning": "<your thesis in Buffett's voice, 2-4 sentences>"}
```

**机制**（`signals/llm_agent.py`）：
- `LLMAgent.predict()`：构建快照 → 拼 system+user → LLM 调用 → 解析固定 JSON → 折算成连续信号。
- 输出 schema 与数值折算（`models.py` + `llm_agent.py`）：
  - `Signal{model_name, ticker, date, value∈[-1,+1], reasoning, components, metadata}`；
  - `value = sign(signal) × confidence/100`，即 `bullish`+90 分 → `+0.9`；
  - 解析时校验：signal 必须在枚举内、confidence 必须在 `[0,100]`，否则判为解析失败。
- **失败契约**（防静默失真）：
  - 数据层错误 → 直接抛出（fail loud）；
  - LLM 调用/解析失败 → **abstain**：`Signal(value=0.0, metadata.abstained=True)`，绝不悄悄变成中性观点。
- **Prompt 缓存**（`llm/cache.py`）：`sha256(agent|model|system|user)` 做 key；快照 `content_hash` 排除日期字段——两次 filing 之间数据没变就命中缓存，不重复付费（`features/snapshot.py`：`content_hash` 排除 `as_of`；渲染文本也故意不含日历日期，防 LLM 锚定日期联想"未来事件"）。
- LLM 供应商可插拔：Anthropic / OpenAI / DeepSeek / Google / xAI / Kimi。

**输入组织**（`features/snapshot.py`）：LLM 看到的不是原始 API，而是一个**紧凑文本快照**——聚合指标由 Python 算好（`roe_avg`、`net_margin_avg`、`gross_margin_trend`、`bvps_cagr`、`debt_to_equity_latest`、`market_cap_latest`）+ 每期一行表格（`period | filed | mktcap | P/E | ROE | gross_m | op_m | net_m | D/E | curr | rev_gr | EPS | BVPS | FCF/sh`），最多 20 个 TTM 期、最新在前。

### 1.2 TradingAgents：LangGraph 编排 + 辩论式多代理 + 决策层结构化输出

**节点流程**（`graph/setup.py`、`graph/conditional_logic.py`）：

```
START
 → 分析师（顺序，各带工具循环）：
    market(技术面) / social(情绪) / news(新闻) / fundamentals(基本面)
 → Bull Researcher ↔ Bear Researcher  辩论（默认 max_debate_rounds=1 → 2 次发言）
 → Research Manager（deep-thinking LLM） → ResearchPlan
 → Trader → TraderProposal
 → Aggressive ↔ Conservative ↔ Neutral 风险辩论（默认 1 轮 → 3 次发言）
 → Portfolio Manager（deep-thinking LLM） → PortfolioDecision → END
 →（Phase B）reflect_on_final_decision：拿到实际收益后 2-4 句复盘，回写给未来分析
```

**角色与提示词风格**：
- **分析师**（`agents/analysts/*.py`）：工具调用型 agent（LangChain `bind_tools`），产出**自然语言 markdown 报告**，强制"末尾附 Markdown 表格"。
  - `market_analyst.py` 最有设计感：把**指标做成了菜单**，要求"select up to **8 indicators** that provide complementary insights without redundancy（避免冗余，如不要同时选 rsi 和 stochrsi）"，每个指标带用途与坑（如 "RSI may remain extreme in strong trends"）；先 `get_stock_data` 取 CSV，再 `get_indicators` 逐个取数，最后必须调 `get_verified_market_snapshot` 校准（"if another tool's output conflicts with the verified snapshot, flag the discrepancy rather than inventing a reconciled number"）。
  - `fundamentals_analyst.py`：`get_fundamentals / get_balance_sheet / get_cashflow / get_income_statement`，要求"include as much detail as possible + 末尾表格"。
- **牛/熊研究员**（`researchers/bull_researcher.py` 等）：辩论是**单 prompt 多轮**而非独立思维链，核心技巧是注入上下文：
  ```
  Conversation history of the debate: {history}
  Last bear argument: {current_response}
  ... engage directly with the bear analyst's points, refuting them with specific data ...
  ```
  即"对方最后一轮论点 + 全量辩论历史"塞进本轮 prompt，逼迫逐点反驳。
- **风险辩手**（`risk_mgmt/aggressive|conservative|neutral_debator.py`）：同样的辩论结构，注入 trader 决策 + 对方两人最近论点；轮转由 `latest_speaker` 状态决定。
- **决策层结构化输出**（`agents/schemas.py`）：核心设计——"**Schema 字段描述本身就是给模型的输出指令**，prompt 正文只放上下文与评级尺度"；用各供应商原生的结构化模式（OpenAI/xAI `json_schema`、Gemini `response_schema`、Anthropic tool-use），解析后再用 `render_*()` 渲染回与旧格式**同构的 markdown**，让展示/记忆/报告链路零改动。
- **双层 LLM 配置**（`graph/setup.py`）：分析师/辩手/交易员用 `quick_thinking_llm`，研究经理/组合经理用 `deep_thinking_llm`——便宜模型跑体力活、强模型做终审。
- **防幻觉基建**（`agents/utils/agent_utils.py`）：
  - `resolve_instrument_identity(ticker)`：先用 yfinance 查**确定性公司名/行业**注入上下文。README 注释写明这是为了修复真实 bug #814——"market analyst 看到图表形态后脑补出了一家错误公司，错误身份级联污染所有下游 agent"。
  - `get_language_instruction()`：`output_language` 非 English 时才追加 "Write your entire response in {lang}."——省 token 且防报告语言混排。

### 1.3 OpenBB：不是"分析框架"，而是"把数据工具暴露给 LLM"的三种方式

OpenBB 本体是 schema-first 数据平台，本身不产出投资分析；它给 LLM 提供的是**结构化的函数/工具层**，具体三条路（`examples/openbbPlatformAsLLMTools.ipynb` + `extensions/mcp_server/`）：

1. **LangChain 函数工具（最经典，示例即代码）**：
   ```python
   from langchain_core.tools import StructuredTool
   llm_historical_price = StructuredTool.from_function(
       func=obb.equity.price.historical,
       description=obb.equity.price.historical.__doc__.split("\n")[0],  # docstring 首行做描述
   )
   # 枚举全部命令：obb.coverage.command_schemas() → {name: {callable, ...}}
   # 然后 feed 给 create_openai_functions_agent / ReAct 等
   ```
   → 纯**函数 schema + 工具调用（function calling）**，无 MCP。
2. **官方 MCP Server**（`extensions/mcp_server/`，`openbb-mcp`）：
   - 用 FastMCP 的 **OpenAPI provider** 把 OpenBB REST API（`openbb_core.api.rest_api` 的全部 FastAPI 路由）自动转成 MCP **工具**（形如 `equity_price_historical`、`equity_price_quote`），同时把部分路由转成 **Resources / Resource Templates**（`app/app.py` 里 `OpenAPITool / OpenAPIResource / OpenAPIResourceTemplate`）。
   - 反 token 膨胀设计：**工具发现 + 按需启用**——核心管理工具 `available_categories()`、`available_tools()`、`activate_tools()/deactivate_tools()`、`activate_category()`（`app/app.py` 600-742 行）；工具可见性 **per-session**（每个客户端独立工具集）。README 原文："provides discovery tools that allow agents to explore available categories and dynamically activate only the tools they need. This keeps the initial tool list small — **preventing token bloat**"。
   - **提示词方面它做的是"宿主"**：支持 `--system-prompt <txt>`、`--server-prompts <json>`（`models/prompts.py`：`StaticPrompt` 模板 + 参数占位）；还支持把各厂商的 **skills 目录**（Claude / Cursor / VS Code / Copilot / Codex / Gemini / Goose / OpenCode 的 skill 文件夹）作为提示词资源注入（`_VENDOR_SKILLS_PROVIDERS`）；`PromptsAsTools`、`ResourcesAsTools` 两种 transform 可选。
   - 工具元数据（`models/tools.py`）：`ToolInfo{name, active, description}`、`CategoryInfo{name, subcategories, total_tools}`——目录树 `category → subcategory → tools` 可浏览。
3. **"OpenBB Agent"的正确理解**：项目里**没有**内置"分析师 agent"——OpenBB 的角色是数据/工具提供方，分析智能完全来自接入的任意 LLM（官方示例是 LangChain Agent 包裹 OpenBB 工具）。`openbb_platform` 里的 `merge_agents.py` 只是平台 API 的 `agents.json` 端点元数据合并，与 AI agent 无关。

**函数 schema 长什么样**（`core/openbb_core/provider/standard_models/equity_quote.py`）：每条命令 = `QueryParams`（入参，字段带 human description，`symbol` 自动大写校验）+ `Data`（出参）+ provider 私有实现，统一 `OBBject` 包装。入参示例：`symbol, provider, start_date, end_date, interval, ...`。**每个字段都有描述**，这正是 LLM 函数调用最需要的。

---

## 2. 三者的输出形态差异

| 项目 | 形态 | 具体形态 | 对前端的意义 |
|---|---|---|---|
| ai-hedge-fund | **纯结构化 JSON**（信号+置信度+理由） | `{"signal": bullish\|bearish\|neutral, "confidence": 0-100, "reasoning": "<2-4句>"}` → 内部再折算为 `Signal.value∈[-1,+1]` | 直接渲染成"看多/观望/看空 + 强度条 + 理由"，最省事 |
| TradingAgents | **两者兼有** | 分析师/辩手：自然语言 markdown 报告（人读 + 供下游 agent 读）；决策层：Pydantic 结构化 `ResearchPlan / TraderProposal / PortfolioDecision / SentimentReport`；落盘仍是 markdown（`render_*` 把 JSON 渲染回同样式的 markdown） | 结构化字段渲染卡片 + markdown 报告展示，双轨 |
| OpenBB | **数据侧结构化**，分析侧无内置形态 | 工具返回 `OBBject`（JSON/DataFrame，字段全带描述）；分析输出？完全由接的 LLM 决定，官方不给 schema | 把它当"取数后端"，分析 prompt 自己设计 |

**给"输入代码→输出分析"前端的具体建议**：底层统一为结构化 JSON（`{signal, confidence, reasoning, 可选 price_target/horizon}`），reasoning 保留自然语言段落用于详情展示——这是三个项目殊途同归的形态（ai-hedge-fund 最简、TradingAgents 最全）。

三个可参考的具体 schema（TradingAgents `agents/schemas.py`，字段描述即输出指令）：

```python
class ResearchPlan:      # 研究经理 → 交易员
    recommendation: Buy | Overweight | Hold | Underweight | Sell   # 5 档评级
    rationale: str        # 辩论双方要点 + 哪边胜出（口语、像跟同事说话）
    strategic_actions: str  # 给交易员的具体步骤（含仓位指导）

class TraderProposal:    # 交易员
    action: Buy | Hold | Sell
    reasoning: str          # 2-4 句，锚定分析师报告与研究计划
    entry_price: float | None
    stop_loss: float | None
    position_sizing: str | None   # 如 "5% of portfolio"

class PortfolioDecision:  # 组合经理（终审）
    rating: Buy | Overweight | Hold | Underweight | Sell
    executive_summary: str   # 2-4 句行动计划（入场/仓位/风险位/时限）
    investment_thesis: str
    price_target: float | None
    time_horizon: str | None

class SentimentReport:    # 情绪分析师
    overall_band: Bullish | Mildly Bullish | Neutral | Mixed | Mildly Bearish | Bearish  # 6 档
    overall_score: float        # 0-10（0=极度看空，5=中性，10=极度看多；bounds 强制校验）
    confidence: low | medium | high
    narrative: str              # 分源拆解 + 分歧 + 主题 + 催化剂/风险 + 信号表
```

---

## 3. 喂给 LLM 的"数据输入"清单

### 3.1 ai-hedge-fund：Point-in-Time 基本面快照（`data/models.py` + `features/snapshot.py`）

每期（TTM，最新在前，最多 20 期）核心字段：
```
market_cap 市值 | price_to_earnings_ratio P/E | return_on_equity ROE
gross_margin 毛利率 | operating_margin 营业利润率 | net_margin 净利率
debt_to_equity 债务/权益 | current_ratio 流动比率 | revenue_growth 营收增长
earnings_per_share EPS | book_value_per_share 每股账面值 | free_cash_flow_per_share 每股FCF
report_period / filing_date   ← 披露日（防前瞻偏差的关键）
```
派生聚合（**Python 算好再喂，不让 LLM 算**）：`roe_avg, net_margin_avg, gross_margin_trend(最新-最早), bvps_cagr(年化), debt_to_equity_latest, market_cap_latest`。
完整 `FinancialMetrics` 字段全家桶（后端 API 有，前端可选择性采）：
- 估值：`market_cap, enterprise_value, P/E, P/B, P/S, EV/EBITDA, EV/Revenue, free_cash_flow_yield, peg_ratio`
- 盈利：`gross_margin, operating_margin, net_margin, ROE, ROA, ROIC`
- 效率：`asset_turnover, inventory_turnover, receivables_turnover, days_sales_outstanding, operating_cycle, working_capital_turnover`
- 流动性：`current_ratio, quick_ratio, cash_ratio, operating_cash_flow_ratio`
- 杠杆：`debt_to_equity, debt_to_assets, interest_coverage`
- 增长：`revenue_growth, earnings_growth, book_value_growth, EPS_growth, FCF_growth, operating_income_growth, ebitda_growth`
- 每股/分红：`payout_ratio, EPS, BVPS, FCF_per_share`
- 其他数据源：OHLCV `Price`、`InsiderTrade`（内部人交易）、`CompanyNews`（标题+来源+日期+URL）、`CompanyFacts`（sector/industry/exchange）、`EarningsData`（实际 vs 预期 + `revenue_surprise/eps_surprise ∈ BEAT|MISS|MEET`）
- 数据门槛：`MIN_PERIODS = 4`，少于 4 期历史直接 `InsufficientData`（宁可不评，不可瞎评）。

### 3.2 TradingAgents：工具调用取数（`agents/utils/`）

- **技术指标菜单（12 个，LLM 自选 ≤8 个）**（`technical_indicators_tools.py` + market_analyst prompt 里的完整定义）：

  | 分类 | 指标名 | 用途（prompt 原文浓缩） |
  |---|---|---|
  | 均线 | `close_50_sma` / `close_200_sma` / `close_10_ema` | 趋势方向/金叉死叉；滞后，需配快指标 |
  | MACD | `macd` / `macds` / `macdh` | 动量、交叉、背离；震荡市需确认 |
  | 动量 | `rsi` | 超买超卖；**强趋势中可能长期极端** |
  | 波动 | `boll` / `boll_ub` / `boll_lb` | 中轨=20SMA；上下轨±2σ做突破/反转 |
  | 波动 | `atr` | 波动率→止损位/仓位 |
  | 量能 | `vwma` | 量加权均线，确认趋势；防量峰失真 |

- 基本面工具：`get_fundamentals`（综合报告）、`get_balance_sheet`、`get_cashflow`、`get_income_statement`（quarterly/annual）。
- 其它数据源：`get_news` / `get_global_news`（新闻）、`get_insider_transactions`（内部人交易）、`get_macro_indicators`（FRED 宏观）、`get_prediction_markets`（Polymarket 预测市场）、`get_verified_market_snapshot`（校准用权威快照）。
- 输入呈现形式：`get_stock_data` 返回 **CSV**（OHLCV+volume），指标按名逐个取；外加 `instrument_context`（公司名/行业等的确定性身份，防幻觉）。

### 3.3 OpenBB：按需取数的命令与字段（`standard_models/`）

- 常用命令：`equity.price.quote`（实时报价）、`equity.price.historical`（OHLCV，参数 `symbol, provider, start_date, end_date, interval`）、`equity.fundamental.*`（报表/比率）等，全部带 provider 抽象。
- `EquityQuoteData` 出参示例：`symbol, name, exchange, bid/ask/ask_size, last_price, last_tick, open/high/low/close, volume, market_center, 各时间戳`——每个字段有 description。
- 关键点：**OpenBB 不给分析提示词模板**，它批量提供"带描述的字段 schema"；LLM 分析质量取决于你给它选了哪些命令。

### 3.4 给小型前端的最小输入字段清单（综合三项目）

```
① 报价/行情：symbol, name, exchange(可选), last_price, open, high, low, close, volume, 日期
② 技术指标（免费可得且够用）：close_50_sma, close_200_sma, rsi, macd/macds/macdh, boll/boll_ub/boll_lb, atr（至少 6-8 个）
③ 估值倍数：market_cap, P/E, P/B, P/S(可选), EV/EBITDA(可选)
④ 盈利能力：ROE, ROA(可选), gross_margin, operating_margin, net_margin
⑤ 财务健康：debt_to_equity, current_ratio, interest_coverage
⑥ 增长：revenue_growth, earnings_growth, EPS
⑦ 每股/分红：EPS, BVPS, free_cash_flow_per_share(可选), payout_ratio(可选)
⑧ 身份：sector, industry（防幻觉，必给）
⑨ 衍生聚合（代码算）：roe_avg, gross_margin_trend, bvps_cagr, market_cap_latest
```

---

## 4. 可直接借鉴的 prompt 片段思路 & 值得避免的坑

### 4.1 可借鉴的思路（含可直接套用的 prompt 片段）

1. **Persona 提示词六段模板**（ai-hedge-fund，五个 persona 通用，复刻成本低）：
   `角色第一人称 → 清单式思维链 → 信号规则（每档一句）→ 置信度分段锚定 → 硬规则 → JSON-only schema`。示例片段：
   ```
   Work through your checklist:
   1. ...
   Signal rules:
   - bullish: ...
   Confidence scale (0-100): 90-100 ...; 70-89 ...; 40-69 ...; 10-39 ...
   Hard rules:
   - Reason ONLY from the data provided. Treat the most recent filing date
     shown as the present day; do not use any knowledge of anything that
     happened after it. Do not invent numbers.
   - If the data is insufficient to judge, say so and go neutral.
   Respond with JSON only, in exactly this schema: {...}
   ```
2. **点时间约束**（三段同源思想）："把最近披露日当今天，禁止知道之后发生的事、禁止编数字"——直接消灭"用未来数据/事后诸葛"型幻觉。前端取免费行情时尤其要传数据日期并明示"数据截至某日"。
3. **派生指标代码化**：聚合/趋势/复合增长在 Python 算好（`roe_avg`、`gross_margin_trend`、`bvps_cagr`）再喂，不让 LLM 做算术——消除计算不一致与微积分幻觉。
4. **置信度用分档文字锚定**：`0-100` 先给 4 档语义（exceptional/solid/mixed/weak）再让模型填数，比裸数字稳定（ai-hedge-fund 所有 persona 一致做法）。
5. **显式"不知道"出口**：数据不足 → 该 agent 明确 abstain/neutral（ai-hedge-fund 的失败契约：LLM 失败 abstain 而非静默中立；TradingAgents："If the data is insufficient to judge, say so"）。前端可加"数据不足/分析失败"状态，别硬凑结论。
6. **结构化输出时把 field description 当指令**：TradingAgents `schemas.py` 的核心设计——schema 字段描述承载输出规范，prompt 正文只留上下文；同时保留 `reasoning/narrative` 自然语言段供人读。**JSON 供 UI 渲染 + 文本供详情，双轨输出**。
7. **辩论式 prompt 注入对方论点**：`Conversation history: {history} + Last argument: {current_response}`，让每个立场的 agent 被迫逐点反驳（牛/熊、激进/保守/中性）。前端成本可控（2-4 次调用），视角覆盖全面性显著提升。
8. **指标菜单 + 数量上限**：把技术指标列成带"用途/坑"的菜单，要求"选 ≤N 个互补指标、避免冗余"（market_analyst 的 8 上限、rsi/stochrsi 反例）——控 token、防信息堆砌。
9. **确定性身份注入**：先用免费接口查公司名/行业再分析（TradingAgents `resolve_instrument_identity`，修复了 #814 幻觉 bug）；EE 前端建议同样在 prompt 里注明"本股票=XXX（sector/industry）"。
10. **校验快照当权威源**："以校验快照为准，其它工具输出与它冲突时如实标记，不要自己造调和数字"（`get_verified_market_snapshot`）。
11. **Prompt 文本哈希缓存**：`sha256(agent|model|system|user)` 做 key，数据无变化不重复调 LLM（ai-hedge-fund `PromptCache`）——前端对同一股票重复点击时直接省一次调用。
12. **报告强制 Markdown 表格收尾**（TradingAgents 分析师）：要点表格式总结，对 UI 表格渲染友好。
13. **语言指令按需追加**：默认英文不加字，非英文才追加 `Write your entire response in {lang}.`（`get_language_instruction`）。
14. **双层 LLM 分工**：体力活（分析师/取数/辩论）用便宜快模型，终审（研究经理/组合经理）用强模型——TradingAgents 的 quick/deep 双层配置。
15. **按需工具发现防 token 膨胀**（OpenBB MCP）：工具列表默认最小化，让 agent 通过 `available_tools / activate_tools` 按需启用；前端若挂多个数据源也可照此设计。
16. **反思闭环**（TradingAgents Phase B）：拿到实际收益后让模型写 2-4 句复盘（`reflect_on_final_decision`：方向对不对/哪段论点站住了/一条教训），沉淀有价值且要求极短——防止上下文膨胀。
17. **预取数据 + 显式禁工具**（TradingAgents `sentiment_analyst.py`）：情绪分析师不搞工具调用，而是把新闻（近 7 天）+ StockTwits（30 条）+ Reddit 评论**预先抓进 prompt**，并在 system 里写死 `NO_EXTERNAL_TOOLS`——注释原文："tool-range wording would only invite a hallucinated tool call (#1130)"。前端对"数据量小、可一次取全"的场景可直接照抄。

### 4.2 值得避免的坑

1. **幻觉级联**：图表价格形态 → LLM 脑补公司叙事 → 错误身份污染所有下游（TradingAgents #814 真实事故）。→ 必须先注入 ground-truth 身份（公司名/行业/交易所），且 prompt 里写死"数据里没有的不要声称"。
2. **Token 膨胀**：OpenBB MCP README 直说"preventing token bloat"是工具发现设计的动机；TradingAgents 反思 prompt 也明说"compact enough to be re-injected ... without bloating the context window"。→ 全量塞原始财报几十页 = 又贵又容易丢焦点；用快照压缩 + 指标菜单 + 输出长度上限（"2-4 sentences"）。
3. **回看/前瞻偏差**：ai-hedge-fund `snapshot.py` 明确指出必须按 **filing_date（披露日）** 过滤而非 report_period，否则回测等于作弊；对实时前端同样如此——免费行情里"最新财报"与"最新价格"日期不同，务必把两个日期都传给 LLM。
4. **JSON 解析脆弱性**：模型常输出带杂散文本的 JSON → ai-hedge-fund `extract_json` 三级回退（```json fence → 整串 → 第一个平衡 `{...}` 块）；可选数值字段被填 `"None"/"N/A"/"-"` 字符串 → TradingAgents `_NULLISH_FLOAT` 集合强制转 None（#1058）。→ 前端解析器必须做这两类兜底，否则一票否决式报错。
5. **失败被静默吞掉**：LLM 失败静默变成"中性"会污染信号库（ai-hedge-fund 明令禁止）。→ 设计上区分"看空"与"无法判断"（abstain），UI 里体现"分析失败/数据不足"。
6. **数据噪音误导**：market_analyst 提示词里几乎每个指标都带"Tips: 需与其他指标确认 / 强趋势中会失真 / 量峰扭曲"。→ prompt 里写明每个指标的使用边界，别让模型对单一指标强解读。
7. **让 LLM 徒手算财务派生量**：跨期复合增长率、趋势差，模型算出来可能各不相同。→ 代码里算好喂数值（同 4.1-#3）。
8. **辩论历史无限累积**：TradingAgents 的 `history` 每次累加整轮文本，回合多时上下文爆炸。→ 限制辩论轮数（默认 1 轮）+ 历史截断。
9. **日期锚定**：快照渲染故意不含日历日期（ai-hedge-fund），防止模型把"今天"联想成它训练数据里的事件日。→ 前端提示词里用"数据截至日"而非"今天"。
10. **语言混排**：多语言 prompt 会把说明语言和输出语言混在一起 → 显式语言指令（见 4.1-#13）。
11. **免费数据源不稳**：yfinance 限流/不可用时 TradingAgents 选择 fail-open 降级而非阻塞整轮；前端应做"数据源降级 + 缓存 + 明确数据日期"的三件套。
12. **幻想的工具调用**：TradingAgents #1130——给不需要工具的 agent（情绪分析）也列了工具措辞，模型就真的去编一个工具调用。→ 不用工具的 agent 就显式 `NO_EXTERNAL_TOOLS`；要用工具的 agent 则只在菜单范围内调用（"用上面定义的确切指标名，否则调用会失败"——market_analyst）。

---

## 附：三个仓库中值得直接打开读的文件（按优先级）

| 想抄什么 | 去哪读 |
|---|---|
| persona 提示词模板（5 个完整范例） | ai-hedge-fund `hedge_fund/signals/{buffett,graham,munger,lynch,druckenmiller}.py` |
| LLM 调用/解析/缓存/失败契约 | ai-hedge-fund `hedge_fund/signals/llm_agent.py`、`hedge_fund/llm/client.py`、`llm/cache.py` |
| 快照渲染与字段 | ai-hedge-fund `hedge_fund/features/snapshot.py`、`hedge_fund/data/models.py` |
| 结构化输出 schema（含 field description 写法） | TradingAgents `tradingagents/agents/schemas.py` |
| 分析师提示词（指标菜单写法） | TradingAgents `tradingagents/agents/analysts/market_analyst.py` |
| 辩论 prompt（注入对方论点） | TradingAgents `tradingagents/agents/researchers/bull_researcher.py`、`risk_mgmt/aggressive_debator.py` |
| 图编排/轮次控制 | TradingAgents `tradingagents/graph/setup.py`、`conditional_logic.py` |
| 反思 prompt（极短复盘） | TradingAgents `tradingagents/graph/reflection.py` |
| LLM 工具化（StructuredTool） | OpenBB `examples/openbbPlatformAsLLMTools.ipynb` |
| MCP 服务器（工具发现/防膨胀） | OpenBB `openbb_platform/extensions/mcp_server/README.md`、`.../app/app.py` |
| 函数 schema 风格 | OpenBB `openbb_platform/core/openbb_core/provider/standard_models/equity_quote.py` |
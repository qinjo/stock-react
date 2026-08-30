#!/usr/bin/env bash
# 将 6 张垂直切片票据发布为 GitHub issues（依赖顺序），动态回填 Blocked by 引用，
# 并打 ready-for-agent 标签。父规格：issue #1。
# 幂等：按标题检测，已存在的票跳过，可安全重跑。
# 需要：gh 已认证（gh auth status 显示 Logged in），远端仓库存在。
set -euo pipefail

cd "$(dirname "$0")/.."

issue_exists() {
  gh issue list --state all --limit 200 --json title --jq '.[].title' | grep -qxF "$1"
}

publish() {
  local title="$1" body="$2"
  if issue_exists "$title"; then
    echo "  exists, skip: $title"
    return
  fi
  gh issue create --title "$title" --label ready-for-agent --body "$body"
}

declare -a URLS=()

echo "== [1/6] T1 =="
TITLE="T1 — 项目骨架与前后端连通"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

从零搭起前后端骨架并打通第一条连通路径：前端（React + Vite + TS + Tailwind）渲染一个入口页，后端（Node + Fastify + TS）提供健康检查端点，页面真实调用后端并显示其状态。

## Acceptance criteria

- [ ] 前端服务可启动，页面含股票查询入口与后端状态显示
- [ ] 后端可启动，健康检查端点返回 JSON 状态
- [ ] 前端开发服务器代理到后端，页面显示真实连通结果
- [ ] 前后端各一个最小冒烟测试（仅测外部行为，不触网）

## Blocked by

- None — 可立即开始"
publish "$TITLE" "$BODY"

echo "== [2/6] T2 =="
TITLE="T2 — 股票搜索与行情展示"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

用户输入 A 股代码（6 位数字，宽容 sh/sz 前缀）或中文名称片段，即获得下拉补全候选；选定股票后看到身份与行情快照卡（代码/名称/行业/现价/涨跌幅/市值/PE/PB/换手率，含数据截至标注）和一张可缩放、带十字光标的日 K 线走势图（60 根，前复权）。

## Acceptance criteria

- [ ] 后端 /api/search?q= 接东财 suggest 返回补全候选（代码+名称），前端搜索框防抖+下拉展示
- [ ] 后端 /api/quote 与 /api/kline 归一化东财响应（×100 缩放、K线 11 列序、secid 沪/深判定）
- [ ] 选中股票后页面展示快照卡与 KLineChart 走势图，数据日期明确标注
- [ ] 东财适配器用实测 fixture 单测：缩放、列序、secid 归一化（次 seam，零网络）

## Blocked by

- T1（项目骨架与前后端连通）"
publish "$TITLE" "$BODY"

echo "== [3/6] T3 =="
TITLE="T3 — 技术指标层"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

基于日 K 数据计算派生技术指标（SMA50/200、RSI、MACD DIF/DEA/HIST、ATR、区间涨跌幅、波动率等约 12 个），作为后续分析提示词的数值输入；派生指标一律由代码计算，不交给模型。提供调试端点展示指标值。

## Acceptance criteria

- [ ] technicalindicators 集成并输出约 12 个指标字段（含最新值与必要的历史序列）
- [ ] 指标计算对 fixture 日 K 数据的已知结果断言成立（纯函数单测）
- [ ] /api/indicators 调试端点返回当前指标值 JSON
- [ ] 指标值单位与边界（如 RSI 0-100）在代码中明确校验

## Blocked by

- T2（股票搜索与行情展示）"
publish "$TITLE" "$BODY"

echo "== [4/6] T4 =="
TITLE="T4 — 分析核心：提示词+DeepSeek+解析"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

构建分析引擎的核心：六段 persona 提示词构造器（角色定位 / 清单式思维链 / 信号规则 / 置信度 4 档锚定 / 硬规则[点时间约束、只用给定数据、不发明数字、数据不足 abstain] / JSON-only 输出），对接 DeepSeek（deepseek-chat，key 仅存服务端），以三级回退解析 LLM 输出（json code-fence → 整串 → 首个平衡 JSON 块），空值字符串转 null，校验 5 档评级枚举与置信度 0-100；失败重试一次后 abstain。数据不足时显式 abstain 而非静默中性。输出五节报告文本（快照/基本面/技术面/风险清单/结论）与结构化信号 JSON。

## Acceptance criteria

- [ ] 提示词构造器输出符合六段模板，输入为冻结域对象（快照+指标+K线），含点时间约束与 JSON schema 硬规则
- [ ] DeepSeek 客户端从环境变量读 key，可配置模型名，支持 JSON 输出模式
- [ ] 解析器三级回退 + 空值兜底 + 枚举/置信度校验（fake LLM 四种夹具：干净 JSON / 杂散文本 / 空值字符串 / 抛错——主 seam 单测，零网络）
- [ ] 失败契约：调用/解析失败重试一次后 abstain；数据不足 abstain，与「看空」语义区分

## Blocked by

- T3（技术指标层）"
publish "$TITLE" "$BODY"

echo "== [5/6] T5 =="
TITLE="T5 — 完整分析体验与结果页"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

把数据、指标、分析串成完整用户体验：选定股票后点击分析，后端编排（快照+指标+60 根K线截尾 → 提示词 → DeepSeek → 解析）返回结构化分析，带 10 分钟内存缓存（同票重复查询零 LLM 调用）；前端结果页渲染信号卡（5 档评级徽章+置信度条+一句话理由+可选目标价/时间窗）、五节报告、以及三态异常（数据不足 abstain / 分析失败可重试 / 数据源不可用）与常驻免责声明。

## Acceptance criteria

- [ ] /api/analyze 端到端返回 AnalysisResult（评级/置信度/理由/可选 target+horizon/五节报告），含错误统一形状 status/code/message
- [ ] 内存缓存 TTL 10 分钟生效，同票重复查询命中缓存、无重复 LLM 调用
- [ ] 结果页渲染信号卡、五节报告、三态异常与免责声明（React hooks 状态机 loading/success/abstain/failed/source-unavailable）
- [ ] 页面内展示 KLineChart 走势图与快照卡（复用 T2 组件）

## Blocked by

- T2（股票搜索与行情展示）
- T4（分析核心：提示词+DeepSeek+解析）"
publish "$TITLE" "$BODY"

echo "== [6/6] T6 =="
TITLE="T6 — 硬化与文档"
BODY="## Parent

- #1（父规格：A股智能分析 MVP —— 功能规格）

## What to build

让项目达到「可作为作品/演示」的完成度：公开部署可启用的按 IP 限流中间件（可配置开关），.env 模板与密钥说明（key 仅存服务端），README 全链路架构说明（前端 → 后端 → 东财 → DeepSeek，含提示词工程学习重点与 token 成本预算），异常契约文档化。

## Acceptance criteria

- [ ] 按 IP 简单限流中间件可配置启用，超限返回 429（可验证）
- [ ] .env 模板列出全部服务端配置项且不含真实密钥，README 说明获取方式
- [ ] README 含架构图/链路说明、提示词六段模板讲解、成本预算（约 ¥0.02–0.05/次）
- [ ] 免责声明在 README 与页面均有体现

## Blocked by

- T5（完整分析体验与结果页）"
publish "$TITLE" "$BODY"

echo ""
echo "== 执行完成 =="
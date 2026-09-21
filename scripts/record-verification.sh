#!/usr/bin/env bash
# 补记真实 LLM 验证结果与后续优化（需 gh 已认证）。
# 对应：T4(#5) 分析核心、T5(#6) 完整分析体验。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== 补记 T4（#5）验证 =="
gh issue comment 5 --body "## 真实 LLM 验证已完成 ✅

配置 DEEPSEEK_API_KEY 后实测（deepseek-chat）：

| 项 | 结果 |
|---|---|
| 首次分析 | HTTP 200，3.67s，结构化 JSON 契约成立 |
| 五节报告 + 风险清单 | 结构完整，数值引用与后端指标一致（PE 17.57、SMA50 1300.97、MACD DIF −11.45、RSI 37.02） |
| 不编造硬规则 | 茅台因缺乏盈利预测数据**明确拒绝给目标价**；平安银行依据充分则给出 12.5 |
| 实测 token | prompt 2686 / completion 612 / total 3298（含 DeepSeek 自动缓存命中 2432） |

**后续优化（超出本票范围，见 ADR-0002/0003）**：提示词重构（置信度可数锚定、目标价双轨、删 conclusion、具名谬误与自检清单）+ 数据层补全（财报、估值分位、同业对比）。详见 \`docs/adr/0002-prompt-engineering.md\`、\`docs/adr/0003-fundamentals-data.md\`。"

echo "== 补记 T5（#6）验证 =="
gh issue comment 6 --body "## 真实 LLM 验证已完成 ✅（含缓存与成本实测）

| 项 | 结果 |
|---|---|
| 缓存命中 | 首次 3.98s（真实调用）→ 二次 **0.32s** → 三次 0.18s，\`fromCache: true\` 且 usage 复用首次值 |
| 缓存键修正 | 原用提示词全文哈希，因**盘中行情逐秒变化**（实测两次提示词 12/95 行不同）导致永不命中；改为「股票 + 交易日」，同交易日复用、跨交易日失效 |
| token 用量透传 | DeepSeek usage 一路透传到前端信号卡展示（输入/输出/缓存命中） |
| 端到端 | 五节报告 + 三态异常 + 免责声明在页面正常渲染 |

**后续优化（超出本票范围，见 ADR-0002/0003）**：报告结构由「结论段」改为「数据边界 / 什么会改变判断 / 监控指标」三块收尾；新增失效位（invalidation）；页面增加基本面与估值面板（\`/api/fundamentals\`，不消耗 LLM 调用）。"

echo ""
echo "== 完成 =="

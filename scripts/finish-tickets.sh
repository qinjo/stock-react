#!/usr/bin/env bash
# 推送全部提交，并关闭 T1–T6 工单（需 gh 已认证）。
# T4/T5 的真实 LLM 端到端验证依赖 DEEPSEEK_API_KEY；评论中已如实标注该状态。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== 推送提交 =="
git push

echo ""
echo "== 关闭工单 =="
gh issue close 2 --comment "T1 完成（b70c9db）：前后端骨架 + /api/health + Vite 代理，本地链路已验证。"
gh issue close 3 --comment "T2 完成（273edca、3e4851c）：搜索/快照/日K 端到端打通。两处数据源偏离见 ADR-0001 —— 搜索改用腾讯 smartbox（东财 suggest 对服务端请求返回用户搜索结构，结构性不可用）；行情改为东财主 + 腾讯备自动降级（东财 IP 级反爬）。"
gh issue close 4 --comment "T3 完成（59604b6）：约 12 项派生技术指标、MIN_SAMPLES=60 的数据不足契约、/api/indicators。关键指标以独立手算断言，两源同窗口 SMA50 交叉验证一致。"
gh issue close 5 --comment "T4 完成（a9083fa）：六段 persona 提示词、DeepSeek 客户端（json_object 模式）、三级回退解析 + 空值兜底、失败重试一次后 abstain。主 seam 以 fake LLM 四种夹具覆盖，全程零网络。真实 API 调用待配置 DEEPSEEK_API_KEY 后验证。"
gh issue close 6 --comment "T5 完成（908f7dc）：提示词哈希缓存（TTL 可配、abstain 不入缓存）+ 信号卡 + 五节报告 + 三态异常 + 免责声明。前端 32 项测试覆盖三态分流。真实 LLM 端到端待 key 验证。"
gh issue close 7 --comment "T6 完成（49c6ccd）：按 IP 限流（实测 3×200 → 第 4 次 429 + Retry-After）、README 全链路文档（含六段提示词讲解与成本预算）、.env 模板、页面与文档双免责声明。"

echo ""
echo "== 完成：6 张工单已关闭 =="

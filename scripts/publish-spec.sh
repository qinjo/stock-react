#!/usr/bin/env bash
# 将 docs/spec.md 发布为 GitHub issue 并打上 triage 标签。
# 需要：gh 已认证（gh auth status 显示 Logged in），远端仓库存在。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "== [1/2] 创建 triage 标签（如已存在则跳过） =="
for label in needs-triage needs-info ready-for-agent ready-for-human wontfix; do
  if ! gh label list --limit 200 --json name --jq ".[].name" | grep -qx "$label"; then
    gh label create "$label" --force
    echo "  created: $label"
  else
    echo "  exists:  $label"
  fi
done

echo "== [2/2] 发布规格 issue =="
gh issue create \
  --title "A股智能分析 MVP —— 功能规格" \
  --body-file docs/spec.md \
  --label ready-for-agent

echo "== 完成 =="
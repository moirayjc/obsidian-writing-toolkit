#!/usr/bin/env bash
#
# 跑全部检查（纯逻辑层，不需要启动 Obsidian）。
#   npm run verify
#   ./tools/checks/run-all.sh --vault ~/Documents/WT-Test-Vault
#
# 退出码：0 全通过 / 1 有失败 / 2 环境问题（缺依赖/缺构建产物）
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

# macOS 自带 bash 3.2：`set -u` 下展开空数组会报 unbound variable，故用字符串
VAULT_ARG=""
[ "${1:-}" = "--vault" ] && [ -n "${2:-}" ] && VAULT_ARG="--vault $2"

CHECKS=(
  "check-commentstore.js:批注存储 CommentStore"
  "check-loaddata.js:设置加载 loadPluginData"
  "check-vault.js:作品识别 project"
)

failed=""
passed=0
envfail=0

for item in "${CHECKS[@]}"; do
  file="${item%%:*}"
  label="${item##*:}"
  echo ""
  echo "── ${label}  (tools/checks/${file})"
  # shellcheck disable=SC2086
  node "tools/checks/${file}" ${VAULT_ARG}
  code=$?
  case "$code" in
    0) passed=$((passed + 1)) ;;
    2) envfail=1; failed="${failed}
  ✘ ${label}（环境问题）" ;;
    *) failed="${failed}
  ✘ ${label}" ;;
  esac
done

echo ""
echo "══════════════════════════════════════"
if [ -z "$failed" ]; then
  echo "全部通过：${passed} 项检查"
  exit 0
fi
echo "未通过：${failed}"
[ "$envfail" -eq 1 ] && echo "（有环境问题：先 npm install / npm run build）"
exit 1

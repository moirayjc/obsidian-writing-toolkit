#!/usr/bin/env bash
#
# 跑全部检查（不需要启动 Obsidian；含逻辑检查与规格形式检查）。
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
  "check-loaddata.js:设置加载 Settings Service"
  "check-settings-service.js:设置 Settings Service"
  "check-persistence-service.js:持久化 Persistence Service"
  "check-editor-service.js:编辑器 Editor Service"
  "check-ui-service.js:界面 UI Service"
  "check-events-service.js:事件与定时器 Events Service"
  "check-diagnostics-service.js:诊断 Diagnostics Service"
  "check-vault.js:作品识别 project"
  "check-diagnostics.js:诊断计数与自检报告"
  "check-hooks.js:诊断埋点守卫"
  "check-commandsurface.js:命令面板白名单"
  "check-host.js:Host 与模块生命周期"
  "check-project-index.js:作品索引 Project Service"
  "check-wordcount-service.js:字数统计 WordCount Service"
  "check-day-rollover.js:跨午夜统计（零点后保存不串日）"
  "check-typed-speed.js:时速（写下的字 ÷ 有效写作时长）"
  "check-cross-device-stats.js:跨设备字数统计（今日净增 = 书稿字数 − 今日起点）"
  "check-chapter-status.js:章节定稿锁"
  "check-anchor-tracking.js:批注位置跟踪（作者改正文）"
  "check-comment-panel.js:批注面板（标签 / 列表 / 详情）"
  "check-cnote-contrast.js:批注实心序号对比度"
  "check-sidecar-location.js:伴随数据存放位置"
  "check-onload.js:onload 体量守卫"
  "check-punctuation-module.js:中文标点辅助 Feature Module"
  "check-hardbreak-module.js:回车硬换行 Feature Module"
  "check-typewriter-module.js:打字机 Feature Module"
  "check-hemingway-module.js:海明威 Feature Module"
  "check-focus-link.js:海明威 ⇄ 沉浸联动"
  "check-typography-module.js:排版与主题 Feature Module"
  "check-theme-palette.js:配色主题令牌同步（styles.css ⇄ 首帧片段）"
  "check-format-toolbar-module.js:编辑工具条 Feature Module"
  "check-snapshot-module.js:快照核心 Feature Module"
  "check-snapshot-ui-module.js:快照 UI Feature Module"
  "check-outline-module.js:章纲 Feature Module"
  "check-comments-module.js:批注 Feature Module"
  "check-pomodoro-module.js:番茄钟 Feature Module"
  "check-pomodoro-lock.js:番茄钟锁定（SPEC-007）"
  "check-calendar-module.js:写作日历 Feature Module"
  "check-plan-board.js:写作计划看板"
  "check-anchors.js:批注四层锚点定位"
  "check-formatwrap.js:格式包裹与还原"
  "check-renumber.js:全书章节重编号"
  "check-snapshotdiff.js:快照对比块对齐"
  "check-headingstyle.js:标题样式开关"
  "check-settingcontrols.js:设置页控件增强"
  "check-ui-shell.js:UI Shell 解耦（源码级）"
  "check-boundaries.js:边界与入口守卫（源码级）"
  "check-module-contract.js:模块契约与数据键（源码级）"
  "check-workbench-search.js:编辑台全书搜索（源码级）"
  "check-mobilepreview-module.js:读者手机预览（源码级）"
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

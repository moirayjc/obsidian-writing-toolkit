#!/usr/bin/env bash
#
# 发布前隐私体检：确认待提交/待发布的内容里没有真实作品名、私密路径。
#
# 用法：
#   tools/release-check.sh              # 检查「暂存区 + 已跟踪文件」（提交前/发布前跑）
#   tools/release-check.sh --staged     # 只检查暂存区（pre-commit 钩子用）
#   tools/release-check.sh --tree       # 只检查工作区已跟踪文件
#
# 词表（真实作品名等）放在 .git/wt-blocklist.txt —— 刻意不进版本库，
# 否则这个词表本身就成了泄露源。文件不存在时只做通用检查。
#
# 首次设置词表（每行一个词，# 开头为注释）：
#   printf '%s\n' '作品名一' '角色名一' > .git/wt-blocklist.txt
# 安装 pre-commit 钩子（提交前自动跑本例的 --staged 模式）：
#   printf '#!/usr/bin/env bash\nroot="$(git rev-parse --show-toplevel)" || exit 0\n[ -x "$root/tools/release-check.sh" ] || exit 0\nexec "$root/tools/release-check.sh" --staged\n' > .git/hooks/pre-commit
#   chmod +x .git/hooks/pre-commit
#
# 退出码：0 干净 / 1 发现疑似泄露

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1

MODE="${1:---all}"
BLOCKLIST=".git/wt-blocklist.txt"

# 通用规则：本机路径、邮箱、以及「我的作品」类命名（P<数字>-…）
GENERIC_PATTERNS=(
  '/Users/[A-Za-z0-9._-]+/'
  '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}'
)

hits=0
report() { printf '  \033[31m✘\033[0m %s\n' "$1"; hits=$((hits + 1)); }

# ── 收集待检文本 ──────────────────────────────────────────────
collect() {
  case "$MODE" in
    --staged)
      git diff --cached --name-only --diff-filter=ACM 2>/dev/null
      ;;
    --tree)
      git ls-files 2>/dev/null
      ;;
    *)
      { git diff --cached --name-only --diff-filter=ACM 2>/dev/null; git ls-files 2>/dev/null; } | sort -u
      ;;
  esac
}

FILES=$(collect)
[ -z "$FILES" ] && { echo "没有需要检查的文件。"; exit 0; }

echo "隐私体检（${MODE}）——检查 $(echo "$FILES" | wc -l | tr -d ' ') 个文件"

# ── 1) 通用规则 ──────────────────────────────────────────────
for pat in "${GENERIC_PATTERNS[@]}"; do
  while IFS= read -r f; do
    [ -f "$f" ] || continue
    case "$f" in *.png|*.jpg|*.jpeg|*.gif|*.ico|*.woff*|*.ttf) continue ;; esac
    if grep -InE "$pat" "$f" 2>/dev/null | grep -v 'release-check.sh' | head -3 | grep -q .; then
      report "$f 命中通用规则：$pat"
      grep -InE "$pat" "$f" 2>/dev/null | grep -v 'release-check.sh' | head -2 | sed 's/^/       /'
    fi
  done <<< "$FILES"
done

# ── 2) 真实名词表（本地、不进版本库）──────────────────────────
if [ -f "$BLOCKLIST" ]; then
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    case "$name" in \#*) continue ;; esac
    while IFS= read -r f; do
      [ -f "$f" ] || continue
      if grep -IqF -- "$name" "$f" 2>/dev/null; then
        report "$f 命中本地词表：「${name}」"
        grep -InF -- "$name" "$f" 2>/dev/null | head -2 | sed 's/^/       /'
      fi
    done <<< "$FILES"
  done < "$BLOCKLIST"
else
  echo "  · 未找到 ${BLOCKLIST}，跳过词表检查（建议创建，见文件末尾说明）"
fi

# ── 3) 不该被提交的文件 ──────────────────────────────────────
for bad in data.json main.js; do
  if echo "$FILES" | grep -qx "$bad"; then
    report "$bad 被暂存了（应保持 gitignore）"
  fi
done
if echo "$FILES" | grep -qE '(^|/)\.wt-(snapshots|outlines|backups)/'; then
  report "暂存区里出现了 .wt-* 目录（插件数据，不应进仓库）"
fi

echo
if [ "$hits" -gt 0 ]; then
  printf '\033[31m体检未通过：%d 处疑似泄露。请处理后再提交/发布。\033[0m\n' "$hits"
  echo "（若确属误报，把它从词表或代码里处理掉，不要绕过检查）"
  exit 1
fi
printf '\033[32m体检通过：未发现真实作品名、私密路径或不该提交的文件。\033[0m\n'
exit 0

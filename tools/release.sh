#!/usr/bin/env bash
#
# 一键走完发布自检 → 构建 → 打包。
#   ./tools/release.sh                    # 自检 + 构建 + 打包到 release/
#   ./tools/release.sh --skip-verify      # 跳过检查（不推荐）
#
# 它做：① tsc --noEmit ② 官方审查规则闸门 ③ npm run verify ④ 版本三处一致
#       ⑤ 隐私体检 ⑥ 生产构建 ⑦ 把三个产物打进 release/ 并打印后续步骤（顺带列出 draft 规格，只提醒不拦截）
#
# 它**不做**远程操作：不 push、不打 tag、不建 Release——那些留给你确认后手动执行。
# 详见 docs/插件设计文档.md §6.1。
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --skip-verify) SKIP_VERIFY=1 ;;
    *) echo "未知参数：$arg"; exit 2 ;;
  esac
done

# 反向验证用的环境变量会重定向检查目标；必须在任何检查之前清掉，
# 否则 release 验的是副本。
unset WT_SPECS_ROOT WT_THEME_CSS

step() { echo ""; echo "── $1"; }
fail() { echo ""; printf '\033[31m✘ %s\033[0m\n' "$1"; exit 1; }
ok()   { printf '  \033[32m✔\033[0m %s\n' "$1"; }

# ── ① 类型检查 ──────────────────────────────────────────────
step "① 类型检查 (tsc --noEmit)"
./node_modules/.bin/tsc --noEmit || fail "类型检查未通过"
ok "类型检查干净"

# ── ② 官方审查规则（社区插件后台那套）──────────────────────
step "② 官方审查规则闸门 (tools/lint-gate.sh)"
bash tools/lint-gate.sh || fail "官方审查规则有 error（见上方明细）"
ok "官方审查规则 0 error"

# ── ③ 逻辑检查 ──────────────────────────────────────────────
if [ "$SKIP_VERIFY" -eq 0 ]; then
  step "③ 逻辑检查 (npm run verify)"
  bash tools/checks/run-all.sh || fail "检查未通过（可加 --skip-verify 跳过，但不推荐）"
else
  step "③ 逻辑检查 —— 已跳过"
fi

# ── ④ 版本三处一致 ──────────────────────────────────────────
step "④ 版本号三处一致"
V_MANIFEST=$(python3 -c "import json;print(json.load(open('manifest.json'))['version'])")
V_PKG=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
V_KEY=$(python3 -c "import json;print(list(json.load(open('versions.json')))[-1])")
V_IN_VERSIONS=$(python3 -c "
import json;v=json.load(open('versions.json'))
print('yes' if '$V_MANIFEST' in v else 'no')")
echo "   manifest.json = $V_MANIFEST | package.json = $V_PKG | versions.json 末项 = $V_KEY"
[ "$V_MANIFEST" = "$V_PKG" ] || fail "manifest.json 与 package.json 版本不一致"
[ "$V_IN_VERSIONS" = "yes" ] || fail "versions.json 里没有 $V_MANIFEST 这个键（新版本必须补）"
ok "版本一致：$V_MANIFEST"

# ── ⑤ 隐私体检 ──────────────────────────────────────────────
step "⑤ 隐私体检 (tools/release-check.sh)"
bash tools/release-check.sh --tree || fail "隐私体检未通过"
ok "体检通过"

# ── ⑥ 构建 ──────────────────────────────────────────────────
step "⑥ 生产构建"
npm run build >/dev/null 2>&1 || fail "构建失败"
[ -f main.js ] || fail "构建后没有 main.js"
ok "main.js $(wc -c < main.js | tr -d ' ') 字节"

# ── ⑦ 打包 ──────────────────────────────────────────────────
step "⑦ 打包"
OUT="release/$V_MANIFEST"
rm -rf "$OUT"
mkdir -p "$OUT"
for f in main.js manifest.json styles.css; do
  cp "$f" "$OUT/$f" || fail "拷贝 $f 失败"
  printf '  %-16s %8s 字节\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
done
ok "已打包到 $OUT/"

cat <<EOF

══════════════════════════════════════
产物已就绪：$OUT/（main.js / manifest.json / styles.css）

接下来手动做（脚本不碰远程）：
  git add -A && git commit -m "Release $V_MANIFEST"
  git tag $V_MANIFEST
  git push && git push --tags
  在 GitHub 建 Release「${V_MANIFEST}」，把 ${OUT}/ 里三个文件作为附件上传

换装到工作库（Workbench）：
  先备份 data.json → 再换入 main.js / styles.css / manifest.json
  步骤见 docs/插件设计文档.md §6.5
EOF

# 只提醒、不拦截：draft 规格不影响发布，但值得在发版时看一眼
DRAFTS=$(node tools/checks/check-specs.js --list | grep -E '^\s+draft ' || true)
if [ -n "$DRAFTS" ]; then
  echo ""
  echo "提醒：还有 draft 规格（不影响发布）："
  echo "$DRAFTS"
fi

#!/usr/bin/env bash
#
# 发布闸门：只跑官方审查那套规则（obsidianmd/*），要求 **0 条 error**。
#
#   npm run lint:review      # 给人看的完整报告（含 TS 噪音）
#   tools/lint-gate.sh       # 机器化的闸门（本脚本）
#
# 为什么只卡 obsidianmd/*：
#   eslint-plugin-obsidianmd 的 recommended 配置同时带进了 @typescript-eslint 的
#   no-unsafe-* / no-explicit-any 规则，本仓库历史上有 300+ 条这类告警（大量是
#   `plugin: any` 的既有写法）。它们**不是官方审核会拦的问题**，而且逐条修要动
#   核心类型，风险远大于收益。所以闸门只认「官方审核真会报的」那批规则。
#
# 退出码：0 通过 / 1 有 error
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

OUT="$(mktemp)"
./node_modules/.bin/eslint src package.json --format json > "$OUT" 2>/dev/null
code=$?

python3 - "$OUT" <<'PY'
import json, sys, collections
try:
    data = json.load(open(sys.argv[1]))
except Exception:
    print("✘ eslint 没能产出 JSON（可能配置本身报错）——先跑 npm run lint:review 看原因")
    sys.exit(1)

errors = collections.Counter()
warns = collections.Counter()
for f in data:
    for m in f["messages"]:
        r = m.get("ruleId") or "parse-error"
        if not r.startswith("obsidianmd/"):
            continue          # 只认官方审查那套规则；TS 噪音不在这里卡
        (errors if m["severity"] == 2 else warns)[r] += 1

if errors:
    print(f"✘ 官方审查规则有 {sum(errors.values())} 条 error：")
    for r, n in errors.most_common():
        print(f"    {n}  {r}")
    print("\n  error 基本都是 no-unsupported-api —— 用了比 manifest.json 的")
    print("  minAppVersion 更新的 API。要么换写法，要么把 minAppVersion 抬上去。")
    sys.exit(1)

if warns:
    print(f"· 官方审查规则剩 {sum(warns.values())} 条 warning（不阻塞发布）：")
    for r, n in warns.most_common():
        print(f"    {n}  {r}")
    print("  已知并接受的两条见 docs/插件设计文档.md §6.6。")
print("✔ 官方审查规则：0 条 error")
PY
rc=$?
rm -f "$OUT"
exit $rc

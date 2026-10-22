/**
 * 产品硬约束：命令面板永远只有“设置 + 三个页面”四个入口。
 *
 * 命令由运行时动态注册，单靠打开 Obsidian 很容易漏看。这里直接读
 * `registerCommands()` 的源码，固定命令白名单，并确认从命令面板撤掉的
 * “复制给 Agent 的处理指令”已经在批注面板获得替代入口。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const EXPECTED = [
  "open-sidebar",
  "open-writing-workbench",
  "open-workbench-home",
  "open-settings",
];

const EXPECTED_NAMES = {
  "open-workbench-home": "打开主页",
  "open-sidebar": "打开工具箱",
  "open-writing-workbench": "打开编辑台",
  "open-settings": "打开设置",
};

const REMOVED = [
  "toggle-mobile-preview",
  "format-bold",
  "format-italic",
  "format-underline",
  "format-strike",
  "format-highlight",
  "format-color",
  "format-selfcheck",
  "comment-selfcheck",
  "stats-selfcheck",
  "full-selfcheck",
  "comment-add",
  "comment-copy-agent-prompt",
  "comment-clear-resolved",
  "renumber-chapters",
];

function main() {
  const r = H.createReporter("命令面板白名单（源码级）");
  const mainSrc = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");
  const commentViewSrc = fs.readFileSync(
    path.join(H.ROOT, "src/commentView.ts"),
    "utf8"
  );

  const start = mainSrc.indexOf("private registerCommands(): void {");
  const end = mainSrc.indexOf("this.host.addRibbonIcon(", start);
  const block =
    start >= 0 && end > start ? mainSrc.slice(start, end) : "";
  const ids = [
    ...block.matchAll(/this\.host\.addCommand\(\s*\{\s*id:\s*"([^"]+)"/g),
  ]
    .map((m) => m[1]);
  const named = [...block.matchAll(
    /this\.host\.addCommand\(\s*\{\s*id:\s*"([^"]+)",\s*name:\s*"([^"]+)"/g
  )].map((m) => [m[1], m[2]]);
  const sorted = [...ids].sort();
  const expected = [...EXPECTED].sort();

  r.check("能定位 registerCommands()", block.length > 0);
  r.check(`只注册 ${EXPECTED.length} 条命令`, ids.length === EXPECTED.length);
  r.check(
    "命令 ID 与四入口白名单完全一致",
    sorted.length === expected.length &&
      sorted.every((id, i) => id === expected[i]),
    `实际: ${ids.join(", ") || "（无）"}`
  );
  r.check(
    "四条命令的显示名称完全一致",
    named.length === EXPECTED.length &&
      named.every(([id, name]) => EXPECTED_NAMES[id] === name),
    `实际: ${named.map(([id, name]) => `${id}=${name}`).join(", ") || "（无）"}`
  );
  r.check(
    "四条命令都使用普通 callback（不再挂编辑器 / 条件命令）",
    (block.match(/(?:^|\s)callback:/g) || []).length === EXPECTED.length &&
      !block.includes("editorCallback:") &&
      !block.includes("checkCallback:")
  );

  const totalAddCommands =
    (mainSrc.match(/this\.host\.addCommand\s*\(/g) || []).length;
  const directAddCommands =
    (mainSrc.match(/this\.addCommand\s*\(/g) || []).length;
  r.check(
    "main.ts 的命令全部经 Host 注册，且没有漏在 registerCommands() 之外",
    totalAddCommands === EXPECTED.length && directAddCommands === 0,
    `Host: ${totalAddCommands}，直接注册: ${directAddCommands}`
  );
  for (const id of REMOVED) {
    r.check(`已移除命令 ${id}`, !mainSrc.includes(`id: "${id}"`));
  }

  r.check(
    "批注面板接口保留两份 Agent 指令：copyReviewPrompt / copyReplyPrompt(docPath?)",
    /copyReviewPrompt\(docPath\?:\s*string\):\s*void;/.test(commentViewSrc) &&
      /copyReplyPrompt\(docPath\?:\s*string\):\s*void;/.test(commentViewSrc)
  );
  r.check(
    "批注面板提供「复制批注指令」「复制回复指令」按钮（不是命令）",
    commentViewSrc.includes('text: "复制批注指令"') &&
      commentViewSrc.includes('text: "复制回复指令"')
  );
  r.check(
    "复制按钮传入面板自己的文档路径",
    /this\.host\.copyReviewPrompt\(model\.docPath \?\? undefined\)/.test(
      commentViewSrc
    ) &&
      /this\.host\.copyReplyPrompt\(model\.docPath \?\? undefined\)/.test(
        commentViewSrc
      )
  );

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (e) {
  console.error("运行失败：" + e.stack);
  H.cleanup();
  process.exit(2);
}

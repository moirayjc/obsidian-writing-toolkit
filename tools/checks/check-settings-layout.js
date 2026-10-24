/**
 * 设置页分类（源码级）：6 个标签页的顺序、每页有哪些卡片、每个设置项恰好出现一次。
 *
 * 2026-10-23 重新分类：「写作」页拆成「编辑」「批注」「数据与同步」，「章纲」并进「作品」。
 * 挪位置时最容易丢掉或重复某一项，这里把整张表固定下来。只读源码，不启动 Obsidian。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

const EXPECTED = [
  {
    tab: "统计",
    groups: ["番茄钟"],
    settings: [
      "每日目标字数", "字数统计模式", "显示码字时速", "热力图显示方式",
      "状态栏仅在沉浸模式显示", "手机端常驻状态条",
      "专注时长", "休息时长", "长休息间隔", "长休息时长", "结束自动保存快照",
    ],
  },
  {
    tab: "编辑",
    groups: ["排版", "写作辅助", "编辑工具条"],
    settings: ["配色主题", "标题样式", "回车即新段落", "选中浮出格式工具条", "工具条生效范围"],
  },
  {
    tab: "批注",
    groups: ["批注", "Agent 连接"],
    settings: ["批注", "批注按钮全库可用", "在手机和平板上使用批注"],
  },
  {
    tab: "快照",
    groups: ["自动快照"],
    settings: [
      "自动快照", "高级：自定义快照文件夹", "连续写作快照间隔",
      "停止输入即保存", "每文件保留快照数", "仅自动快照正文草稿",
    ],
  },
  {
    tab: "作品",
    groups: ["章节识别", "章纲", "新建作品", "资料库", "看板"],
    settings: [
      "正文章节关键词", "不算章节的文件名", "章纲数据存放机制",
      "新作品位置", "共用资料库位置", "看板文件",
    ],
  },
  {
    tab: "数据与同步",
    groups: ["伴随数据", "维护"],
    settings: ["在 Obsidian 搜索里隐藏", "修复项目统计路径"],
  },
];

/** Agent 连接卡里的项写在 buildAgentBridgeSettings 里，由「批注」页的 Agent 连接卡调用 */
const BRIDGE_SETTINGS = ["允许 Agent 通过批注工具连接（仅本机）", "端口", "连接到 Agent", "每轮的快捷命令"];

function names(block, pattern) {
  return [...block.matchAll(pattern)].map((m) => m[1]);
}

function main() {
  const r = H.createReporter("设置页分类（源码级）");
  const source = fs.readFileSync(path.join(H.ROOT, "src", "settings.ts"), "utf8");
  const start = source.indexOf("const sections: Array<");
  const end = source.indexOf("sections.forEach", start);
  const body = source.slice(start, end);

  const tabMatches = [...body.matchAll(/\n {8}title: "([^"]+)",/g)];
  const tabs = tabMatches.map((m) => m[1]);
  r.check(
    "6 个标签页，顺序：统计 / 编辑 / 批注 / 快照 / 作品 / 数据与同步",
    tabs.join("/") === EXPECTED.map((e) => e.tab).join("/"),
    tabs.join("/")
  );

  const blocks = tabMatches.map((m, i) =>
    body.slice(m.index, i + 1 < tabMatches.length ? tabMatches[i + 1].index : body.length)
  );
  const allNames = [];
  EXPECTED.forEach((expected, i) => {
    const block = blocks[i] ?? "";
    const groups = names(block, /this\.group\("([^"]+)"/g);
    const settings = names(block, /\.setName\("([^"]+)"\)/g);
    allNames.push(...settings);
    r.check(
      `「${expected.tab}」页的卡片：${expected.groups.join("、")}`,
      groups.join("/") === expected.groups.join("/"),
      groups.join("/")
    );
    r.check(
      `「${expected.tab}」页的设置项一项不少、一项不多`,
      [...settings].sort().join("/") === [...expected.settings].sort().join("/"),
      settings.join("/")
    );
  });

  const helper = source.slice(
    source.indexOf("private buildAgentBridgeSettings"),
    source.indexOf("private card(")
  );
  const bridge = names(helper, /\.setName\("([^"]+)"\)/g);
  r.check(
    "Agent 连接卡：开关、端口、连接到 Agent、每轮的快捷命令，且只在「批注」页调用一次",
    bridge.join("/") === BRIDGE_SETTINGS.join("/") &&
      (blocks[2].match(/buildAgentBridgeSettings\(/g) || []).length === 1 &&
      (body.match(/buildAgentBridgeSettings\(/g) || []).length === 1,
    bridge.join("/")
  );
  r.check(
    "Agent 连接卡只在电脑上出现（按 available 判断）",
    /if \(this\.wt\.agentBridgeStatus\(\)\.available\)\s*\{\s*this\.group\("Agent 连接"/.test(blocks[2])
  );

  const counts = new Map();
  for (const name of [...allNames, ...bridge]) counts.set(name, (counts.get(name) ?? 0) + 1);
  const duplicated = [...counts].filter(([, n]) => n > 1).map(([name]) => name);
  r.check("每个设置项在整个设置页只出现一次", duplicated.length === 0, duplicated.join("、"));

  const stale = [...source.matchAll(/「写作 → [^」]*」/g)].map((m) => m[0]);
  r.check("说明文字里没有指向旧「写作」页的路径", stale.length === 0, stale.join("、"));

  return r.finish();
}

try {
  const ok = main();
  H.cleanup();
  process.exit(ok ? 0 : 1);
} catch (error) {
  console.error("运行失败：" + error.stack);
  H.cleanup();
  process.exit(2);
}

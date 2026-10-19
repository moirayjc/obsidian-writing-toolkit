/**
 * 读者手机预览检查（源码级，SPEC-005）。
 *
 * 编辑台书头新增「读者手机预览」入口：用一个只读弹窗把当前章节按手机阅读器的
 * 样子渲染出来（两机型 / 四档字号 / 三套底纹）。这个检查把契约固定成五组：
 *
 *   A. 新模块 src/mobilePreview.ts 的导出与常量（机型尺寸、字号档、底纹）；
 *   B. DOM 类名与 data-* 属性（styles.css 与渲染 harness 都按这套结构对接）；
 *   C. 入口与端口：UiShellActions 端口 → workbench 调用（真机隐藏）→ main 装配；
 *      图标，以及「单一文本管线」（formatWrap.cleanChapterText 同时供复制与预览用）；
 *   D. styles.css 的 .wt-phone-* 选择器与 [data-font=] / [data-theme=] 属性选择器；
 *   E. 反向守卫（都是「不许发生」）：预览只读（不出现任何 vault / editor 写入 API）、
 *      命令面仍 4 条、DEFAULT_SETTINGS 不新增预览设置（预览状态只存内存）。
 *   F. 提示边界与真机 gate（复验 F-2 / F-3 补的盲区）：readChapterText 方法体的三处
 *      Notice 与 openPhonePreview 的真机兜底提示必须还在；workbench 里
 *      `if (!Platform.isMobile)` 入口 gate ≥3 处（书头按钮 / 书头菜单 / 章节行菜单），
 *      且每处附近都能看到预览入口。
 *
 * 反向验证：本检查在实现之前先跑过一次——当时 src/mobilePreview.ts 还不存在，
 * 缺文件 / 缺符号 / 缺样式的断言全红，证明断言不是空转（见 SPEC-005 tasks 的证据）。
 *
 * 扫描范围只有 src/mobilePreview.ts、src/workbench.ts、src/uiShellContext.ts、
 * src/main.ts、src/icons.ts、src/formatWrap.ts、src/settingsSchema.ts、styles.css。
 * 不启动 Obsidian、不依赖 main.js、不联网、不读 vault。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/** 读取源码；文件不存在返回 null（缺文件由断言报红，不算环境问题）。 */
function readSource(relPath) {
  const full = path.join(H.ROOT, relPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full, "utf8");
}

/** 返回 needle 出现的行号（1 起），用于失败时定位。 */
function findLines(text, needle) {
  const lines = text.split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(needle)) hits.push(i + 1);
  }
  return hits;
}

/** 把行号列表压成一句可读详情（最多列 10 个）。 */
function where(lines) {
  const shown = lines.slice(0, 10).join("、");
  return "出现在第 " + shown + (lines.length > 10 ? " 等" : "") + " 行";
}

/** 从 marker 匹配处起，按花括号配平抽出后面的 { ... } 块（找不到返回 null）。 */
function extractBraced(text, markerRegex) {
  const match = markerRegex.exec(text);
  if (!match) return null;
  const open = text.indexOf("{", match.index);
  if (open < 0) return null;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return null;
}

/** 抽出 `const NAME = ...;` 或 `= [ ... ];` 的声明段（找不到返回 null）。 */
function constBlock(text, name) {
  const match = new RegExp("(?:export\\s+)?const\\s+" + name + "\\b").exec(text);
  if (!match) return null;
  const rest = text.slice(match.index);
  let end = rest.length;
  const semi = rest.indexOf(";");
  if (semi >= 0) end = semi + 1;
  const closeArr = rest.indexOf("];");
  if (closeArr >= 0) end = Math.min(end, closeArr + 2);
  return rest.slice(0, end);
}

/**
 * 常量段里是否出现某个 id。
 * 兼容三种写法：数组对象 `{ id: "s" }`、字符串数组 `["s", …]`、记录表 `{ s: … }`。
 */
function hasIdToken(block, id) {
  if (!block) return false;
  const quoted = new RegExp("[\"'`]" + id + "[\"'`]");
  const keyed = new RegExp("(?:^|[{,\\s])" + id + "\\s*:");
  return quoted.test(block) || keyed.test(block);
}

/** DOM 类名必须作为字符串字面量出现（后面不能紧跟 - 或字母数字，防止前缀误判）。 */
function hasClassToken(source, cls) {
  return new RegExp("[\"'`]" + cls + "(?![\\w-])").test(source);
}

/** 转义正则元字符（把中文提示原文安全地拼进正则）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 方法体里是否存在 `new Notice("某条提示")`。
 * 只认真的 Notice 调用——注释里出现同一句话不算数。
 */
function hasNotice(body, message) {
  if (!body) return false;
  return new RegExp(
    "new\\s+Notice\\s*\\(\\s*[\"'`]" + escapeRegExp(message) + "[\"'`]"
  ).test(body);
}

function main() {
  const r = H.createReporter("读者手机预览（源码级）");

  const phoneFile = readSource("src/mobilePreview.ts");
  const phone = phoneFile || "";
  const workbench = readSource("src/workbench.ts") || "";
  const shell = readSource("src/uiShellContext.ts") || "";
  const mainSrc = readSource("src/main.ts") || "";
  const icons = readSource("src/icons.ts") || "";
  const formatWrap = readSource("src/formatWrap.ts") || "";
  const settingsSchema = readSource("src/settingsSchema.ts") || "";
  const styles = readSource("styles.css") || "";

  // ---------- A. 新模块与导出 ----------

  r.check("A：src/mobilePreview.ts 已创建", phoneFile !== null, "文件不存在");

  r.check(
    "A：export class MobilePreviewModal extends Modal",
    /export\s+class\s+MobilePreviewModal\s+extends\s+Modal\b/.test(phone),
    "找不到 MobilePreviewModal extends Modal"
  );

  // 机型：产品明确不区分苹果 / 安卓（SPEC-005 需求变更），这里改成反向守卫——
  // 一旦有人把机型分支加回来，这条会红。
  r.check(
    "A：不再有 PHONE_DEVICES / data-device 机型分支（外框只有一种形态）",
    !/PHONE_DEVICES\b/.test(phone) &&
      !/data-device/.test(phone) &&
      !/["'`]iphone["'`]/.test(phone) &&
      !/["'`]android["'`]/.test(phone),
    "仍存在机型相关标识（PHONE_DEVICES / data-device / iphone / android）"
  );

  // 字号四档与底纹三套。
  const fontsBlock = constBlock(phone, "PHONE_FONTS");
  const fontMissing = ["s", "m", "l", "xl"].filter((id) => !hasIdToken(fontsBlock, id));
  r.check(
    "A：export const PHONE_FONTS = 四档 s / m / l / xl",
    /export\s+const\s+PHONE_FONTS\b/.test(phone) && fontMissing.length === 0,
    fontMissing.length ? "缺少档位 " + fontMissing.join("、") : "找不到 PHONE_FONTS"
  );
  const themesBlock = constBlock(phone, "PHONE_THEMES");
  const themeMissing = ["paper", "sepia", "night"].filter((id) => !hasIdToken(themesBlock, id));
  r.check(
    "A：export const PHONE_THEMES = paper / sepia / night",
    /export\s+const\s+PHONE_THEMES\b/.test(phone) && themeMissing.length === 0,
    themeMissing.length ? "缺少底纹 " + themeMissing.join("、") : "找不到 PHONE_THEMES"
  );

  // ---------- B. DOM 类名与 data-* 属性 ----------

  const DOM_CLASSES = [
    "wt-phone-modal",
    "wt-phone-title",
    "wt-phone-hint",
    "wt-phone-bar",
    "wt-phone-bar-group",
    "wt-phone-chip",
    "wt-phone-stage",
    "wt-phone-device",
    "wt-phone-screen",
    "wt-phone-status",
    "wt-phone-status-time",
    "wt-phone-status-icons",
    "wt-phone-reader-head",
    "wt-phone-reader-title",
    "wt-phone-reader-sub",
    "wt-phone-page",
    "wt-phone-body",
    "wt-phone-p",
    "wt-phone-reader-foot",
    "wt-phone-foot-btn",
    "wt-phone-foot-info",
  ];
  for (const cls of DOM_CLASSES) {
    r.check(
      "B：DOM 类名 " + cls,
      hasClassToken(phone, cls),
      "mobilePreview.ts 里找不到类名 " + cls
    );
  }
  const DATA_ATTRS = ["data-font", "data-theme"];
  const DATASET_PROPS = { "data-font": "font", "data-theme": "theme" };
  for (const attr of DATA_ATTRS) {
    const prop = DATASET_PROPS[attr];
    r.check(
      "B：数据集属性 " + attr,
      hasClassToken(phone, attr) || new RegExp("\\bdataset\\." + prop + "\\b").test(phone),
      "mobilePreview.ts 里找不到 " + attr + "（或 dataset." + prop + "）"
    );
  }
  r.check(
    "B：选中态 is-active",
    /["'`]is-active/.test(phone),
    "mobilePreview.ts 里找不到 is-active"
  );

  // ---------- C. 入口与端口 ----------

  const actionsBlock = extractBraced(shell, /export\s+interface\s+UiShellActions\s*\{/);
  r.check(
    "C：UiShellActions 有 openPhonePreview(path: string): void",
    actionsBlock !== null &&
      /openPhonePreview\s*\(\s*path\s*:\s*string\s*\)\s*:\s*void/.test(actionsBlock),
    actionsBlock === null ? "找不到 UiShellActions 接口" : "端口签名缺失"
  );
  r.check(
    "C：workbench 调用 this.host.actions.openPhonePreview(",
    /this\.host\.actions\.openPhonePreview\s*\(/.test(workbench),
    "找不到调用"
  );
  r.check(
    "C：workbench 用 Platform.isMobile 隐藏真机入口",
    /Platform\.isMobile/.test(workbench) &&
      /import\s*\{[^}]*\bPlatform\b[^}]*\}\s*from\s*"obsidian"/.test(workbench),
    "找不到 Platform.isMobile，或没有从 obsidian 引入 Platform"
  );
  r.check(
    "C：main.ts 装配 openPhonePreview 并 new MobilePreviewModal(",
    /openPhonePreview/.test(mainSrc) &&
      /new\s+MobilePreviewModal\s*\(/.test(mainSrc) &&
      /from\s+"\.\/mobilePreview"/.test(mainSrc),
    "main.ts 里缺 openPhonePreview / new MobilePreviewModal( / import ./mobilePreview"
  );
  r.check(
    "C：icons.ts 注册 wt-phone 图标",
    /["'`]wt-phone["'`]/.test(icons),
    '找不到 "wt-phone"'
  );
  r.check(
    "C：formatWrap.ts 导出 cleanChapterText(",
    /export\s+(?:async\s+)?(?:function\s+)?cleanChapterText\s*\(/.test(formatWrap),
    "找不到 cleanChapterText 导出"
  );
  const copyBody = extractBraced(
    mainSrc,
    /(?:async\s+)?copyCleanChapter\s*\(\s*path\s*:\s*string\s*\)\s*:\s*Promise<\s*void\s*>\s*\{/
  );
  r.check(
    "C：main.ts 的 copyCleanChapter 也使用 cleanChapterText(（单一文本管线）",
    copyBody !== null && /cleanChapterText\s*\(/.test(copyBody),
    copyBody === null ? "找不到 copyCleanChapter 方法" : "方法体里没有 cleanChapterText("
  );

  // ---------- D. 样式 ----------

  for (const cls of ["wt-phone-device", "wt-phone-screen", "wt-phone-page", "wt-phone-p", "wt-phone-chip"]) {
    r.check(
      "D：styles.css 有 ." + cls + " 规则",
      new RegExp("\\." + cls + "(?![\\w-])").test(styles),
      "找不到选择器 ." + cls
    );
  }
  r.check(
    "D：styles.css 有 [data-font=] 属性选择器",
    /\[data-font\s*=/.test(styles),
    "找不到 [data-font="
  );
  r.check(
    "D：styles.css 有 [data-theme=] 属性选择器",
    /\[data-theme\s*=/.test(styles),
    "找不到 [data-theme="
  );

  // ---------- E. 反向守卫（都不许发生） ----------

  const WRITE_APIS = [
    "vault.modify",
    "vault.process",
    "vault.create",
    "vault.delete",
    "vault.rename",
    "editor.replaceRange",
    "editor.transaction",
  ];
  for (const api of WRITE_APIS) {
    const lines = findLines(phone, api);
    r.check(
      "E：mobilePreview.ts 不含 " + api + "（预览只读）",
      lines.length === 0,
      lines.length ? where(lines) : ""
    );
  }

  const cmdCount = (mainSrc.match(/addCommand\s*\(/g) || []).length;
  r.check(
    "E：main.ts 的 addCommand( 仍为 4 处（命令面不新增）",
    cmdCount === 4,
    "实际 " + cmdCount + " 处"
  );

  const defaultsBlock = extractBraced(
    settingsSchema,
    /export\s+const\s+DEFAULT_SETTINGS\b[^=]*=\s*\{/
  );
  const previewKeys = defaultsBlock
    ? (defaultsBlock.match(/^\s*([A-Za-z_$][\w$]*)\s*:/gm) || [])
        .map((line) => line.trim().replace(/:$/, ""))
        .filter((key) => /preview|phone/i.test(key))
    : [];
  r.check(
    "E：DEFAULT_SETTINGS 未新增预览相关键（预览状态只存内存）",
    defaultsBlock !== null && /themeTone/.test(defaultsBlock) && previewKeys.length === 0,
    defaultsBlock === null
      ? "找不到 DEFAULT_SETTINGS 块"
      : previewKeys.length
        ? "疑似新键：" + previewKeys.join("、")
        : "DEFAULT_SETTINGS 块解析异常"
  );
  r.check(
    "E：settingsSchema.ts 不含 phonePreview / readerPreview 字面量",
    !/phonePreview|readerPreview/i.test(settingsSchema),
    "命中 " + (settingsSchema.match(/phonePreview|readerPreview/gi) || []).join("、")
  );

  // ---------- F. 提示边界与真机 gate（复验 F-2 / F-3 补齐的盲区） ----------

  // F-2a：这三处提示是「找不到 / 空文档 / 读取失败」的唯一出口——删掉之后调用方
  // 只会静默返回 null，用户看不到任何反馈。必须钉在方法体里，不认全文里的散落字符串。
  const readBody = extractBraced(
    mainSrc,
    /(?:async\s+)?readChapterText\s*\(\s*path\s*:\s*string\s*\)/
  );
  const READ_NOTICES = [
    "找不到这篇文档",
    "这篇文档是空的",
    "读取正文失败（详见控制台）",
  ];
  const missingReadNotices = READ_NOTICES.filter((msg) => !hasNotice(readBody, msg));
  r.check(
    "F2：readChapterText( 方法体含三处提示（找不到 / 空文档 / 读取失败）",
    readBody !== null && missingReadNotices.length === 0,
    readBody === null
      ? "找不到 readChapterText 方法"
      : "缺少 new Notice：" + missingReadNotices.join("、")
  );

  // F-2b：真机兜底——入口可以不显示，但被直接调用时必须提示并返回。
  const previewBody = extractBraced(
    mainSrc,
    /(?:async\s+)?openPhonePreview\s*\(\s*path\s*:\s*string\s*\)/
  );
  r.check(
    "F2：openPhonePreview( 方法体含真机兜底（Platform.isMobile + 桌面端提示）",
    previewBody !== null &&
      /Platform\.isMobile/.test(previewBody) &&
      hasNotice(previewBody, "读者手机预览只在桌面端提供"),
    previewBody === null
      ? "找不到 openPhonePreview 方法"
      : "方法体里缺 Platform.isMobile 或「读者手机预览只在桌面端提供」提示"
  );

  // F-3：书头按钮 / 书头菜单 / 章节行菜单三处入口各一道 gate；拆掉任何一处都会让
  // 真机上冒出「手机预览」入口。顺带确认每处 gate 附近确实是手机预览入口。
  const gates = [];
  const gateRe = /if\s*\(\s*!\s*Platform\.isMobile\s*\)/g;
  let gateMatch;
  while ((gateMatch = gateRe.exec(workbench))) gates.push(gateMatch.index);
  const strayGates = gates.filter(
    (at) =>
      !/openPhonePreview|previewCurrentChapterOnPhone|wt-phone/.test(
        workbench.slice(at, at + 400)
      )
  );
  r.check(
    "F3：workbench.ts 的真机 gate「if (!Platform.isMobile)」≥3 处且都在预览入口上",
    gates.length >= 3 && strayGates.length === 0,
    gates.length < 3
      ? "只有 " + gates.length + " 处 gate"
      : "有 " + strayGates.length + " 处 gate 附近看不到预览入口"
  );

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

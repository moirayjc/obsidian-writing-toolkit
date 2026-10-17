/**
 * 检查：标题样式开关（源码 + CSS 级守卫）。
 *
 * 为什么需要它：这是一个**纯 CSS 功能**，全部效果都靠 `body.wt-heading-style`
 * 前缀的选择器。它有三类容易被静默破坏的问题，跑 Obsidian 才发现：
 *
 * 1. **漏了 gate**：新写一条 `.markdown-preview-view h1 {...}` 忘了加
 *    `body.wt-heading-style` 前缀 → 关掉开关标题样式依然生效，「开关」名存实亡。
 * 2. **em 双重放大复发**：实时预览里字号必须落在 `.cm-line`（行级），
 *    而 `.cm-header-N`（文本 span）要 `font-size: inherit`。否则 em 相对父级
 *    重复放大，H1 会涨到约 48px。这个坑在旧 snippet 里踩过（见其文件头注释）。
 * 3. **令牌未定义**：CSS 用了 `var(--wt-h1-size)` 但令牌没定义 → 整条声明作废，
 *    标题静默回到浏览器默认大小。
 *
 * 这是**文本级**检查（不跑行为、不开 Obsidian），能挡住"被删掉/漏加前缀"，
 * 挡不住"值调错了"——值的观感只能靠眼睛验收。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

/**
 * 取所有含 wt-heading-style 的规则，并**按逗号拆开逐个选择器**判定。
 *
 * 踩过的坑：最初只判「整串选择器里有没有 wt-heading-style」，结果一条
 * 逗号分隔的规则里只要有**一个**选择器带前缀，整条就通过——漏掉的那几个
 * 照样会脱开关生效。反向验证时发现的（去掉规则里第一条的前缀，检查仍全绿）。
 * 所以必须逐条判：每个选择器自己都要以 `body.wt-heading-style` 开头。
 */
function gatedSelectors(css) {
  // 先剥掉注释：规则头的正则会把 `/* … */` 一起吞进来，注释里出现的
  // wt-heading-style 会造成假绿、注释被当成选择器又会造成假红（都踩过）。
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const re = /(^|\})([^{}]*?)\{/g;
  const out = [];
  let m;
  while ((m = re.exec(clean)) !== null) {
    const rule = m[2].trim();
    if (!rule.includes("wt-heading-style")) continue;
    for (const one of rule.split(",")) {
      const sel = one.trim().replace(/\s+/g, " ");
      if (sel) out.push(sel);
    }
  }
  return out;
}

function main() {
  const r = H.createReporter("标题样式开关（源码 + CSS 级）");

  const css = fs.readFileSync(path.join(H.ROOT, "styles.css"), "utf8");
  const settingsSrc = fs.readFileSync(path.join(H.ROOT, "src/settings.ts"), "utf8");
  const typoSrc = fs.readFileSync(path.join(H.ROOT, "src/typography.ts"), "utf8");
  const sidebarSrc = fs.readFileSync(path.join(H.ROOT, "src/sidebar.ts"), "utf8");
  const mainSrc = fs.readFileSync(path.join(H.ROOT, "src/main.ts"), "utf8");

  // ── 1. TS 侧的接线（接口 / 默认值 / body 类 / 清理 / 两处 UI / legacy 分支）
  r.check(
    "settings.ts 接口声明 headingStyle",
    /headingStyle:\s*boolean;/.test(settingsSrc)
  );
  r.check(
    "settings.ts 默认值 headingStyle: true",
    /headingStyle:\s*true,/.test(settingsSrc)
  );
  r.check(
    "settings.ts 设置页有「标题样式」开关",
    settingsSrc.includes('setName("标题样式")')
  );
  r.check(
    "sidebar.ts 侧栏有「标题样式」开关",
    sidebarSrc.includes('"标题样式"') &&
      /settings\.headingStyle\s*=/.test(sidebarSrc)
  );
  r.check(
    "typography.ts 注入时切换 body.wt-heading-style",
    /toggleClass\("wt-heading-style",\s*settings\.headingStyle\)/.test(typoSrc)
  );
  r.check(
    "typography.ts 卸载时移除该 body 类",
    /removeClass\("wt-heading-style"\)/.test(typoSrc)
  );
  r.check(
    "main.ts legacy 分支带上 headingStyle（否则老数据升级后类型不全）",
    /headingStyle:\s*pick\(data\.headingStyle,\s*DEFAULT_SETTINGS\.headingStyle\)/.test(mainSrc)
  );

  // ── 2. CSS 侧：**每个**选择器都必须自己带 gate（逐条判，不看整串）
  const sels = gatedSelectors(css);
  r.check("styles.css 至少有一条标题样式规则", sels.length > 0);
  const ungated = sels.filter((s) => !s.startsWith("body.wt-heading-style"));
  r.check(
    `全部 ${sels.length} 个标题选择器都自己带 body.wt-heading-style 前缀（漏一个则那个元素脱开关）`,
    ungated.length === 0,
    ungated.length ? "未带前缀: " + ungated.slice(0, 4).map((s) => s.slice(0, 46)).join(" | ") : ""
  );

  // ── 3. em 双重放大的防复发
  r.check(
    "`.cm-header-N` 强制 font-size: inherit（否则 em 相对父级重复放大，H1→约 48px）",
    /cm-header-1[\s\S]{0,700}?font-size:\s*inherit/.test(css)
  );
  r.check(
    "字号落在 `.cm-line.HyperMD-header-N` 上（行级），而不是只给 span",
    /\.cm-line\.HyperMD-header-1\s*\{\s*font-size:\s*var\(--wt-h1-size\)/.test(css)
  );

  // ── 4. 令牌必须都被定义，否则整条声明作废、标题静默回默认大小
  const need = [
    "--wt-h1-size", "--wt-h2-size", "--wt-h3-size",
    "--wt-h4-size", "--wt-h5-size", "--wt-h6-size",
    "--wt-h1-weight", "--wt-h2-weight", "--wt-h3-weight",
    "--wt-h4-weight", "--wt-h5-weight", "--wt-h6-weight",
  ];
  const UNDEF = new RegExp("^\\s*" + "(--wt-h\\d-(?:size|weight))" + ":\\s*[^;]+;", "m");
  const missingDef = need.filter((k) => !new RegExp("\\s" + k + ":\\s*[^;]+;").test(css));
  r.check(
    `${need.length} 个标题令牌都有定义`,
    missingDef.length === 0,
    missingDef.length ? "未定义: " + missingDef.join(", ") : ""
  );
  const used = need.filter((k) => css.includes("var(" + k + ")"));
  r.check(
    `${need.length} 个标题令牌都被用到（定义了却没人用说明接错了）`,
    used.length === need.length,
    used.length !== need.length
      ? "未被引用: " + need.filter((k) => !used.includes(k)).join(", ")
      : ""
  );

  // ── 5. Claude 方案的核心约定：层级不靠颜色
  r.check(
    "H2~H6 用墨色令牌而非字面色（层级只靠字号/字重）",
    /HyperMD-header-2[\s\S]{0,200}?color:\s*var\(--wt-ink\)/.test(css) &&
      !/HyperMD-header-2[\s\S]{0,200}?color:\s*#[0-9a-fA-F]{3,6}/.test(css)
  );
  r.check(
    "只有 H1 用强调色锚点",
    /HyperMD-header-1[\s\S]{0,200}?color:\s*var\(--wt-accent\)/.test(css)
  );
  r.check(
    "带 text-wrap: balance（多行标题不落单字）",
    css.includes("text-wrap: balance")
  );

  // ── 6. 文档标题（.inline-title）
  // 实测教训：用户报「H1 没看到朱砂和下划线」，根因是——笔记名显示在正文顶部
  // 那条由 Obsidian 用 `.inline-title` 渲染，**它不是一个 <h1> 元素**，
  // 所以 h1 选择器全都管不到它。这条断言防止它再被漏掉。
  const it = /body\.wt-heading-style\s+\.inline-title\s*\{([^}]*)\}/.exec(css);
  r.check("覆盖了文档标题 .inline-title（它不是 <h1>，h1 选择器管不到）", !!it);
  if (it) {
    const body = it[1];
    r.check(
      ".inline-title 用强调色 + 下划线，与正文 H1 对齐",
      /color:\s*var\(--wt-accent\)/.test(body) && /border-bottom:\s*2px/.test(body)
    );
    r.check(
      ".inline-title **不设 font-size**（Obsidian 自己管字号，再用 em 会相对它双重放大）",
      !/font-size/.test(body)
    );
  }

  // ── 7. 令牌作用域：这是「H1 一直没有朱砂」的真正原因
  // `--wt-accent` 只定义在 .wt-home/.wt-wb/.wt-sidebar/.wt-settings-page 四个容器上。
  // 普通笔记里**没有这些容器**，所以标题规则里 var(--wt-accent) 解析不到，
  // 整条 color 声明静默作废——**没有任何报错**，只能靠眼睛发现。
  // 修法是把它延伸进六档 .cm-editor 主题规则。
  // 必须**落在编辑器主题段里**才有效——只数全文件的 --wt-accent 会假绿：
  // 文件里本来就有 7 处主题块的定义，删光编辑器那 6 处总数仍 ≥6（反向验证抓到的）。
  const edStart = css.indexOf("/* 正文（编辑器）也跟随配色主题");
  const edEnd = css.indexOf("标题样式（设置 → 写作 → 标题样式");
  const edSeg = edStart >= 0 && edEnd > edStart ? css.slice(edStart, edEnd) : "";
  const inEditor = (edSeg.match(/--wt-accent:\s*#[0-9a-fA-F]{3,6};/g) || []).length;
  r.check(
    `强调色已延伸进编辑器主题段（段内 ${inEditor} 处，应 6 处：暖纸/冷淡/高对比 × 深浅）`,
    inEditor >= 6,
    inEditor < 6
      ? "只定义在 .wt-* 容器上则**普通笔记里解析不到**，标题的 color 会静默作废"
      : ""
  );
  // 每个消费 --wt-accent 的标题规则，其选择器必须能在没有容器的情况下命中
  const accentSels = [];
  const ruleRe = /(^|\})([^{}]*?)\{([^{}]*)\}/g;
  let rm;
  while ((rm = ruleRe.exec(css)) !== null) {
    const sel = rm[2].trim();
    if (!sel.includes("body.wt-heading-style")) continue;
    if (/var\(--wt-accent\)/.test(rm[3])) accentSels.push(sel.split(",")[0].trim());
  }
  r.check(
    "消费 --wt-accent 的标题规则存在（H1 / 文档标题）",
    accentSels.length > 0
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

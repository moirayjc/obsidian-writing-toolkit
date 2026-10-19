/**
 * 检查：配色主题令牌在 styles.css 与自动生成的 CSS 片段之间是否同步。
 *
 * 背景（踩过的坑）：两种主题的令牌写了两份——`styles.css` 的
 * `body.wt-theme-<tone>` 块，和 `src/themeSnippet.ts` 生成的
 * `.obsidian/snippets/wt-theme-tone.css`（首帧用，且**每条声明都带
 * `!important`**）。片段先于插件 JS 生效，会盖掉 styles.css 的同名令牌。
 *
 * 后果极隐蔽：只改 styles.css 不重编片段，界面**一点变化都没有**——
 * 2026-10-18 高对比度换 Notion 风配色时就发生过一次（styles.css 改了，
 * 片段还是旧的纯黑，用户看到的仍是黑字黑边）。
 *
 * 这里把两边都解析出来逐令牌比对：
 *   · 浅色 / 深色主令牌块（片段里的 → 必须是 styles.css 里同名令牌的子集，且值一致）
 *   · 窄栏 `--wt-ink-3` 覆盖块（两边要么都没有，要么值一致）
 *   · 热力图 `--wt-heat-*`（两边都必须有且值一致）
 *   · 纸面背景规则（`background` / `background-image`）
 *
 * 反向验证：只改 styles.css 里任一令牌（不重编片段），本检查必须变红。
 */
const fs = require("fs");
const path = require("path");
const H = require("./_harness");

// WT_THEME_CSS 只给反向验证用：拿一份改坏的副本跑，确认本检查会变红
const CSS_PATH =
  process.env.WT_THEME_CSS || path.join(H.ROOT, "styles.css");
const TONES = ["cool", "contrast"];

/** 主令牌块里必须由片段负责的令牌（少一个，首帧就会漏回暖纸） */
const REQUIRED_MAIN = [
  "--wt-paper",
  "--wt-paper-2",
  "--wt-card-bg",
  "--wt-ink",
  "--wt-ink-2",
  "--wt-ink-3",
  "--wt-rule",
  "--wt-rule-strong",
  "--wt-wash",
  "--wt-accent",
  "--wt-accent-soft",
  "--wt-accent-ink",
  "--wt-jade",
  "--wt-amber",
  "--wt-shadow",
];

/** 字体栈只在浅色块里写一次，深色块继承（styles.css 同样如此） */
const REQUIRED_FONTS = ["--wt-serif", "--wt-kai", "--wt-num"];

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** 极简规则切分：只够读本项目这些顶层规则（@media 里的嵌套规则不参与比对） */
function rules(cssText) {
  const text = stripComments(cssText);
  const out = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = re.exec(text))) {
    out.push({
      selector: m[1].replace(/\s+/g, " ").trim(),
      body: m[2],
    });
  }
  return out;
}

/** 自定义属性 + 普通属性都收进来（普通属性只用来比背景那两条） */
function declarations(body) {
  const map = new Map();
  const re = /([-\w]+)\s*:\s*([^;]+);/g;
  let m;
  while ((m = re.exec(body))) map.set(m[1], m[2]);
  return map;
}

/** 只比 --wt- 令牌；空白与 !important 不影响等价判断 */
function tokenMap(body) {
  const map = new Map();
  for (const [name, value] of declarations(body)) {
    if (name.startsWith("--wt-")) map.set(name, value);
  }
  return map;
}

function norm(value) {
  return String(value)
    .replace(/!important/gi, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function sameValue(a, b) {
  return norm(a) === norm(b);
}

/** 把片段按语义切成「主令牌 / 窄栏 / 热力图 / 背景」四类 × 明暗两档 */
function snippetSections(text) {
  const sec = {
    main: { light: null, dark: null },
    narrow: { light: null, dark: null },
    heat: { light: null, dark: null },
    background: [],
  };
  for (const rule of rules(text)) {
    const dark = /\.theme-dark/.test(rule.selector);
    const key = dark ? "dark" : "light";
    if (/(^|[;\s])background(-image)?\s*:/.test(rule.body)) {
      sec.background.push(rule);
    } else if (/--wt-heat-l0\s*:/.test(rule.body)) {
      sec.heat[key] = rule;
    } else if (/--wt-paper\s*:/.test(rule.body)) {
      sec.main[key] = rule;
    } else if (/--wt-ink-3\s*:/.test(rule.body)) {
      sec.narrow[key] = rule;
    }
  }
  return sec;
}

/** styles.css 里 `body.wt-theme-<tone>` 的对应块 */
function stylesSections(all, tone) {
  const base = `body.wt-theme-${tone}`;
  const pick = (predicate) => all.find(predicate) || null;
  const has = (rule, suffix) => rule && rule.selector.includes(base + suffix);

  const main = {
    light: pick((r) =>
      has(r, " :is(.wt-home, .wt-wb, .wt-sidebar, .wt-settings-page)") &&
      !/\.theme-dark/.test(r.selector)
    ),
    dark: pick((r) =>
      has(r, ".theme-dark :is(.wt-home, .wt-wb, .wt-sidebar, .wt-settings-page)")
    ),
  };
  const narrow = {
    // 只认真的写了 --wt-ink-3 的块；主题块里还有别的同选择器规则（交互色映射等）
    light: pick((r) =>
      has(r, " :is(.wt-wb, .wt-sidebar, .wt-settings-page)") &&
      /--wt-ink-3\s*:/.test(r.body) &&
      !/\.theme-dark/.test(r.selector)
    ),
    dark: pick((r) =>
      has(r, ".theme-dark :is(.wt-wb, .wt-sidebar, .wt-settings-page)") &&
      /--wt-ink-3\s*:/.test(r.body)
    ),
  };
  const heat = {
    light: pick((r) => has(r, " .wt-home .wt-heatmap") && !/\.theme-dark/.test(r.selector)),
    dark: pick((r) => has(r, ".theme-dark .wt-home .wt-heatmap")),
  };
  return { main, narrow, heat };
}

/** 逐令牌比对一个「片段侧 ⇒ styles.css 侧」的块 */
function compareBlock(reporter, label, snippetRule, stylesRule) {
  if (!snippetRule && !stylesRule) {
    reporter.check(`${label}：两边都没有该覆盖（一致）`, true);
    return;
  }
  if (!snippetRule || !stylesRule) {
    reporter.check(
      `${label}：片段与 styles.css 都存在该块`,
      false,
      !snippetRule ? "片段缺少该块" : "styles.css 缺少该块"
    );
    return;
  }
  const snip = tokenMap(snippetRule.body);
  const styles = tokenMap(stylesRule.body);
  const diffs = [];
  for (const [name, value] of snip) {
    if (!styles.has(name)) diffs.push(`${name}（styles.css 没有）`);
    else if (!sameValue(value, styles.get(name))) {
      diffs.push(`${name}: 片段 ${value.trim()} ≠ styles.css ${styles.get(name).trim()}`);
    }
  }
  reporter.check(
    `${label}：片段令牌与 styles.css 一致`,
    diffs.length === 0,
    diffs.slice(0, 4).join("；")
  );
}

/** 纸面背景：只比 `background` 的值；`background-image: none` 是片段为了压过
    暖纸渐变而额外写的声明，styles.css 的 `background` 简写已隐含重置，不必两边都有 */
function backgroundValue(rule) {
  return declarations(rule.body).get("background") ?? "";
}

/** 四个容器的面板底色（主页 / 编辑台 / 工具箱 / 设置页）。
    只认「容器本体」的 background 规则，`.wt-wb .wt-wb-head` 这种后代规则不算——
    否则头部背景会把容器底色盖掉。后面的规则覆盖前面的（同 CSS 层叠）。 */
const SURFACES = [
  { key: "home", label: "主页", pattern: /\.wt-home\b/ },
  { key: "wb", label: "编辑台", pattern: /\.wt-wb\b/ },
  { key: "sidebar", label: "工具箱", pattern: /\.wt-sidebar\b/ },
  { key: "settings", label: "设置页", pattern: /\.wt-settings-page\b/ },
];

const CONTAINER_CLASS = "\\.wt-(?:home|wb|sidebar|settings-page)(?:\\.(?:view-content|vertical-tab-content))?$";

function surfaceMap(ruleList, prefix) {
  const map = {};
  const container = new RegExp("^" + prefix + " " + CONTAINER_CLASS);
  for (const rule of ruleList) {
    const value = backgroundValue(rule);
    if (!value) continue;
    for (const group of rule.selector.split(",")) {
      const g = group.trim();
      if (!container.test(g)) continue;
      for (const surface of SURFACES) {
        if (surface.pattern.test(g)) map[surface.key] = value;
      }
    }
  }
  return map;
}

function main() {
  const snippets = H.compile("src/themeSnippet.ts", "theme-snippet-palette");
  const all = rules(fs.readFileSync(CSS_PATH, "utf8"));
  const r = H.createReporter("配色主题令牌同步（styles.css ⇄ 首帧片段）");

  for (const tone of TONES) {
    const text = snippets.buildThemeSnippet(tone);
    const snip = snippetSections(text);
    const styles = stylesSections(all, tone);

    for (const key of ["light", "dark"]) {
      const label = `${tone} ${key === "light" ? "浅色" : "深色"}`;
      const snipMain = snip.main[key];
      if (snipMain) {
        const got = tokenMap(snipMain.body);
        const missing = REQUIRED_MAIN.filter((name) => !got.has(name));
        r.check(
          `${label}：片段包含全部 ${REQUIRED_MAIN.length} 个主令牌`,
          missing.length === 0,
          `缺少 ${missing.join(", ")}`
        );
        if (key === "light") {
          const missingFonts = REQUIRED_FONTS.filter((name) => !got.has(name));
          r.check(
            `${label}：片段写出字体栈`,
            missingFonts.length === 0,
            `缺少 ${missingFonts.join(", ")}`
          );
        }
      }
      compareBlock(r, `${label} 主令牌`, snipMain, styles.main[key]);
      compareBlock(r, `${label} 窄栏墨色`, snip.narrow[key], styles.narrow[key]);

      if (snip.heat[key]) {
        compareBlock(r, `${label} 热力图`, snip.heat[key], styles.heat[key]);
      } else if (styles.heat[key]) {
        r.check(`${label} 热力图：片段不能漏掉 styles.css 已有的覆盖`, false);
      }
    }

    const snipSurfaces = surfaceMap(snip.background, "body");
    const stylesSurfaces = surfaceMap(
      all,
      `body\\.wt-theme-${tone}(?:\\.theme-dark)?`
    );
    for (const surface of SURFACES) {
      const inSnippet = snipSurfaces[surface.key];
      const inStyles = stylesSurfaces[surface.key];
      if (!inSnippet && !inStyles) {
        r.check(`${tone} ${surface.label}：两边都没有面板底色覆盖（一致）`, true);
      } else if (!inSnippet || !inStyles) {
        r.check(
          `${tone} ${surface.label}：片段与 styles.css 都写了面板底色`,
          false,
          !inSnippet ? "片段缺少 background" : "styles.css 缺少 background"
        );
      } else {
        r.check(
          `${tone} ${surface.label}：面板底色一致`,
          sameValue(inSnippet, inStyles),
          `片段 ${inSnippet.trim()} ≠ styles.css ${inStyles.trim()}`
        );
      }
    }
  }

  // 暖纸不应往片段里写任何令牌（默认外观由 styles.css 负责）
  const warm = snippets.buildThemeSnippet("warm");
  r.check(
    "暖纸片段为空（不含任何令牌）",
    !/--wt-[a-z0-9-]+\s*:/.test(warm),
    "暖纸不应写入令牌"
  );

  process.exit(r.finish() ? 0 : 1);
}

main();

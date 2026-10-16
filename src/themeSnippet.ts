import type { App } from "obsidian";
import type { ThemeTone } from "./settings";

/**
 * 首帧配色用的 CSS 代码片段内容。
 * Obsidian 在插件 JS 运行前就会加载已启用的代码片段，所以把当前主题的令牌写进片段，
 * 启动时第一帧就是正确配色，不再先闪暖纸。
 * 选择器不依赖 body.wt-theme-* 类（类由插件 JS 才会加上），
 * 而是用 `body` 前缀把特异性抬到 styles.css 暖纸默认值之上。
 * 暖纸不需要覆盖，片段内容为空注释。
 */
export const THEME_SNIPPET_NAME = "wt-theme-tone";

const VIEWS = ":is(.wt-home, .wt-wb, .wt-sidebar, .wt-settings-page)";

const COOL = `
body ${VIEWS} {
  --wt-paper: #f4f6f8; --wt-paper-2: #e9edf2; --wt-card-bg: #fdfdfe;
  --wt-ink: #1e2630; --wt-ink-2: #5a6673; --wt-ink-3: #8b96a2;
  --wt-rule: rgba(51, 72, 94, 0.13); --wt-rule-strong: rgba(51, 72, 94, 0.22);
  --wt-wash: rgba(51, 72, 94, 0.05);
  --wt-accent: #3e6185; --wt-accent-soft: rgba(62, 97, 133, 0.1); --wt-accent-ink: #f7f9fb;
  --wt-jade: #4d7c7e; --wt-amber: #a57c35;
  --wt-shadow: 0 1px 2px rgba(30, 45, 60, 0.05), 0 4px 14px -8px rgba(30, 45, 60, 0.16);
  --wt-serif: "PingFang SC", "Helvetica Neue", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  --wt-kai: "PingFang SC", "Helvetica Neue", "Noto Sans SC", sans-serif;
  --wt-num: "SF Pro Text", "Helvetica Neue", var(--wt-serif);
}
body.theme-dark ${VIEWS} {
  --wt-paper: #16191d; --wt-paper-2: #1c2025; --wt-card-bg: #20252b;
  --wt-ink: #e2e8ee; --wt-ink-2: #9aa6b3; --wt-ink-3: #6f7c8a;
  --wt-rule: rgba(200, 215, 230, 0.1); --wt-rule-strong: rgba(200, 215, 230, 0.18);
  --wt-wash: rgba(200, 215, 230, 0.05);
  --wt-accent: #8fb6d4; --wt-accent-soft: rgba(143, 182, 212, 0.14); --wt-accent-ink: #14181c;
  --wt-jade: #7fb1ae; --wt-amber: #d6b06c;
  --wt-shadow: 0 1px 2px rgba(0, 0, 0, 0.3), 0 8px 22px -10px rgba(0, 0, 0, 0.5);
}
body.theme-dark :is(.wt-wb, .wt-sidebar, .wt-settings-page) {
  --wt-ink-3: #8593a1;
}
body .wt-home, body .wt-wb.view-content, body .wt-sidebar.view-content, body .wt-settings-page.vertical-tab-content {
  background: var(--wt-paper);
  background-image: none;
}
body .wt-home .wt-heatmap {
  --wt-heat-l0: rgba(51, 72, 94, 0.08); --wt-heat-l1: #cbd9e6; --wt-heat-l2: #9bb7cf;
  --wt-heat-l3: #5d84a6; --wt-heat-l4: #2f5577;
}
body.theme-dark .wt-home .wt-heatmap {
  --wt-heat-l0: rgba(200, 215, 230, 0.06); --wt-heat-l1: #22303d; --wt-heat-l2: #2f4658;
  --wt-heat-l3: #4a6c8a; --wt-heat-l4: #8fb6d4;
}
`;

const CONTRAST = `
body ${VIEWS} {
  --wt-paper: #ffffff; --wt-paper-2: #f2f2f2; --wt-card-bg: #ffffff;
  --wt-ink: #000000; --wt-ink-2: #1a1a1a; --wt-ink-3: #4d4d4d;
  --wt-rule: rgba(0, 0, 0, 0.55); --wt-rule-strong: #000000;
  --wt-wash: rgba(0, 0, 0, 0.07);
  --wt-accent: #000000; --wt-accent-soft: rgba(0, 0, 0, 0.12); --wt-accent-ink: #ffffff;
  --wt-jade: #000000; --wt-amber: #000000;
  --wt-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35);
  --wt-serif: "PingFang SC", "Helvetica Neue", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei", sans-serif;
  --wt-kai: "PingFang SC", "Helvetica Neue", "Noto Sans SC", sans-serif;
  --wt-num: "SF Pro Text", "Helvetica Neue", var(--wt-serif);
}
body :is(.wt-wb, .wt-sidebar, .wt-settings-page) {
  --wt-ink-3: #333333;
}
body.theme-dark ${VIEWS} {
  --wt-paper: #000000; --wt-paper-2: #0d0d0d; --wt-card-bg: #000000;
  --wt-ink: #ffffff; --wt-ink-2: #e6e6e6; --wt-ink-3: #b3b3b3;
  --wt-rule: rgba(255, 255, 255, 0.6); --wt-rule-strong: #ffffff;
  --wt-wash: rgba(255, 255, 255, 0.1);
  --wt-accent: #ffffff; --wt-accent-soft: rgba(255, 255, 255, 0.14); --wt-accent-ink: #000000;
  --wt-jade: #ffffff; --wt-amber: #ffffff;
  --wt-shadow: 0 0 0 1px rgba(255, 255, 255, 0.4);
}
body.theme-dark :is(.wt-wb, .wt-sidebar, .wt-settings-page) {
  --wt-ink-3: #cccccc;
}
body .wt-home, body .wt-wb.view-content, body .wt-sidebar.view-content, body .wt-settings-page.vertical-tab-content {
  background: var(--wt-paper);
  background-image: none;
}
body .wt-home .wt-heatmap {
  --wt-heat-l0: #f2f2f2; --wt-heat-l1: #bfbfbf; --wt-heat-l2: #8c8c8c;
  --wt-heat-l3: #404040; --wt-heat-l4: #000000;
}
body.theme-dark .wt-home .wt-heatmap {
  --wt-heat-l0: #1a1a1a; --wt-heat-l1: #404040; --wt-heat-l2: #8c8c8c;
  --wt-heat-l3: #bfbfbf; --wt-heat-l4: #ffffff;
}
`;

/**
 * 把当前配色写入 .obsidian/snippets/wt-theme-tone.css，并同步启用/停用该片段。
 * 暖纸时片段停用（默认外观不需要覆盖）；内容未变化时不重复写盘。
 */
export async function syncThemeSnippet(app: App, tone: ThemeTone): Promise<void> {
  const adapter = app.vault.adapter;
  const dir = `${app.vault.configDir}/snippets`;
  const path = `${dir}/${THEME_SNIPPET_NAME}.css`;
  try {
    if (!(await adapter.exists(dir))) await adapter.mkdir(dir);
    const content = buildThemeSnippet(tone);
    const old = (await adapter.exists(path)) ? await adapter.read(path) : null;
    if (old !== content) await adapter.write(path, content);

    const customCss = (app as any).customCss;
    if (customCss?.setCssEnabledStatus) {
      customCss.setCssEnabledStatus(THEME_SNIPPET_NAME, tone !== "warm");
    }
  } catch (err) {
    console.warn("写作工具箱：同步配色片段失败", err);
  }
}

/** 按配色生成片段内容；暖纸返回仅含注释的空片段。 */
export function buildThemeSnippet(tone: ThemeTone): string {
  const header = `/* 由 Writing Toolkit 自动生成，请勿手动修改。配色：${tone} */\n`;
  if (tone === "cool") return header + important(COOL);
  if (tone === "contrast") return header + important(CONTRAST);
  return header;
}

/**
 * 给变量与背景声明加 !important：片段要压过插件 styles.css 里的暖色规则
 * （包括 .theme-dark 下优先级更高的渐变背景），不依赖选择器特异性。
 */
function important(css: string): string {
  return css.replace(/(--[\w-]+\s*:[^;]+|\bbackground(?:-image)?\s*:[^;]+);/g, "$1 !important;");
}


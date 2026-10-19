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

/**
 * 高对比度：参照 Notion 浅/深色皮肤（2026-10-18）。
 * 浅色 = 纯白纸 + 深炭黑字 + 暖灰次要字 + 发丝线；
 * 深色 = 炭黑纸（#191919，不是纯黑）+ 近白字 + 同强度发丝线。
 * 字体换成系统无衬线栈（-apple-system → SF / PingFang），与 Notion 一致。
 *
 * ⚠️ 这段令牌必须与 styles.css「配色主题：高对比度」块逐字一致
 * （片段带 !important，会盖掉 styles.css 的同名令牌；只改一处 = 改了不生效）。
 * `tools/checks/check-theme-palette.js` 会拦下任何不一致。
 */
const CONTRAST = `
body ${VIEWS} {
  --wt-paper: #ffffff; --wt-paper-2: #f9f8f7; --wt-card-bg: #ffffff;
  --wt-ink: #202020; --wt-ink-2: #5f5e58; --wt-ink-3: #8d8b85;
  --wt-rule: rgba(55, 53, 47, 0.22); --wt-rule-strong: #5f5e58;
  --wt-wash: #f0eceb;
  --wt-accent: #202020; --wt-accent-soft: rgba(55, 53, 47, 0.1); --wt-accent-ink: #ffffff;
  --wt-jade: #0f7b6c; --wt-amber: #d9730d;
  --wt-shadow: none;
  --wt-serif: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, "PingFang SC", "Noto Sans SC", sans-serif;
  --wt-kai: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
  --wt-num: "SF Pro Text", "Helvetica Neue", -apple-system, sans-serif;
}
body.theme-dark ${VIEWS} {
  --wt-paper: #191919; --wt-paper-2: #202020; --wt-card-bg: #252525;
  --wt-ink: #ffffff; --wt-ink-2: #d4d2ce; --wt-ink-3: #9a9893;
  --wt-rule: rgba(255, 255, 255, 0.22); --wt-rule-strong: rgba(255, 255, 255, 0.5);
  --wt-wash: rgba(255, 255, 255, 0.08);
  --wt-accent: #ffffff; --wt-accent-soft: rgba(255, 255, 255, 0.14); --wt-accent-ink: #191919;
  --wt-jade: #4dab9a; --wt-amber: #e99745;
  --wt-shadow: none;
}
body .wt-home, body .wt-settings-page.vertical-tab-content {
  background: var(--wt-paper);
  background-image: none;
}
body .wt-wb, body .wt-wb.view-content, body .wt-sidebar, body .wt-sidebar.view-content {
  background: var(--wt-paper-2);
  background-image: none;
}
body .wt-home .wt-heatmap {
  --wt-heat-l0: #ebedf0; --wt-heat-l1: #c6cbd1; --wt-heat-l2: #959da5;
  --wt-heat-l3: #586069; --wt-heat-l4: #24292e;
}
body.theme-dark .wt-home .wt-heatmap {
  --wt-heat-l0: #252525; --wt-heat-l1: #383838; --wt-heat-l2: #5a5a5a;
  --wt-heat-l3: #8a8a8a; --wt-heat-l4: #e0e0e0;
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


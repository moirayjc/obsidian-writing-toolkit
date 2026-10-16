export interface TypographySettings {
  themeTone: "warm" | "cool" | "contrast";
  lineHeight: number;
  paragraphSpacing: number;
  letterPaperMode: boolean;
  paragraphIndent: boolean;
}

// 启动时主题要在首帧就生效，而插件数据要异步读取，因此把配色主题同步缓存到 localStorage：
// 启动时 onload 最前面同步读取并套用，避免先闪一下默认暖纸再切换。
const THEME_TONE_CACHE_KEY = "wt-theme-tone-cache";
const THEME_TONES = ["warm", "cool", "contrast"];

function applyThemeTone(tone: string): void {
  document.body.toggleClass("wt-theme-cool", tone === "cool");
  document.body.toggleClass("wt-theme-contrast", tone === "contrast");
}

/** 在插件数据加载完成之前调用：用上次缓存的配色主题同步套用，消除启动闪烁。 */
export function applyCachedThemeTone(): void {
  try {
    const cached = window.localStorage.getItem(THEME_TONE_CACHE_KEY);
    if (cached && THEME_TONES.includes(cached)) applyThemeTone(cached);
  } catch {
    // localStorage 不可用时退回默认暖纸，不影响插件加载
  }
}

// 排版规则全部写在 styles.css 中，这里只更新 CSS 变量与 body 类名，
// 不再动态创建 <style> 元素（Obsidian 审核禁止此做法）。
export function injectTypography(settings: TypographySettings): void {
  try {
    window.localStorage.setItem(THEME_TONE_CACHE_KEY, settings.themeTone);
  } catch {
    // 忽略：缓存失败只会退回原来的启动行为
  }
  document.body.setCssProps({
    "--wt-line-height": String(settings.lineHeight),
    "--wt-paragraph-spacing": `${settings.paragraphSpacing}em`,
  });
  document.body.toggleClass("wt-letter-paper", settings.letterPaperMode);
  document.body.toggleClass("wt-indent", settings.paragraphIndent);
  // 配色主题：冷淡风格的令牌与覆盖全部写在 styles.css 的 body.wt-theme-cool 作用域下
  applyThemeTone(settings.themeTone);
}

export function removeTypography(): void {
  document.body.setCssProps({
    "--wt-line-height": "",
    "--wt-paragraph-spacing": "",
  });
  document.body.removeClass("wt-letter-paper");
  document.body.removeClass("wt-indent");
  document.body.removeClass("wt-theme-cool");
  document.body.removeClass("wt-theme-contrast");
}

export interface TypographySettings {
  lineHeight: number;
  paragraphSpacing: number;
  letterPaperMode: boolean;
  paragraphIndent: boolean;
}

// 排版规则全部写在 styles.css 中，这里只更新 CSS 变量与 body 类名，
// 不再动态创建 <style> 元素（Obsidian 审核禁止此做法）。
export function injectTypography(settings: TypographySettings): void {
  document.body.setCssProps({
    "--wt-line-height": String(settings.lineHeight),
    "--wt-paragraph-spacing": `${settings.paragraphSpacing}em`,
  });
  document.body.toggleClass("wt-letter-paper", settings.letterPaperMode);
  document.body.toggleClass("wt-indent", settings.paragraphIndent);
}

export function removeTypography(): void {
  document.body.setCssProps({
    "--wt-line-height": "",
    "--wt-paragraph-spacing": "",
  });
  document.body.removeClass("wt-letter-paper");
  document.body.removeClass("wt-indent");
}

let styleEl: HTMLStyleElement | null = null;

export interface TypographySettings {
  lineHeight: number;
  paragraphSpacing: number;
  letterPaperMode: boolean;
  paragraphIndent: boolean;
}

export function injectTypography(settings: TypographySettings): void {
  removeTypography();
  styleEl = document.createElement("style");
  styleEl.id = "writing-toolkit-typography";
  styleEl.textContent = `
    :root {
      --wt-line-height: ${settings.lineHeight};
      --wt-paragraph-spacing: ${settings.paragraphSpacing}em;
    }
    .cm-editor .cm-content {
      line-height: var(--wt-line-height) !important;
    }
    .cm-editor .cm-line {
      padding-bottom: var(--wt-paragraph-spacing) !important;
    }
    .markdown-reading-view .markdown-preview-sizer,
    .markdown-rendered .markdown-preview-sizer {
      line-height: var(--wt-line-height) !important;
    }
    .markdown-reading-view p,
    .markdown-rendered p {
      margin-bottom: var(--wt-paragraph-spacing) !important;
    }
  `;
  document.head.appendChild(styleEl);
  document.body.toggleClass("wt-letter-paper", settings.letterPaperMode);
  document.body.toggleClass("wt-indent", settings.paragraphIndent);
}

export function removeTypography(): void {
  document.body.removeClass("wt-letter-paper");
  document.body.removeClass("wt-indent");
  if (styleEl) {
    styleEl.remove();
    styleEl = null;
  }
}

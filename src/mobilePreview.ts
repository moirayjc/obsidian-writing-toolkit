/**
 * 读者手机预览（SPEC-005）。
 *
 * 把「一键复制纯净正文」的那份内容放进手机外框里，按阅读器的排版显示出来：
 * 段首缩进两格、阅读器行距、三种底纹、四档字号。
 *
 * 三条设计约定：
 * 1. **纯文本，不渲染 Markdown**——读者在平台上看到的就是纯文本，渲染反而会
 *    掩盖 `#`、`**` 这类会被平台原样显示的东西（见 spec 非目标）。
 * 2. **本文件不读也不写任何文件**：正文与字数由 Host 取好（与复制共用同一条
 *    管线 `cleanChapterText`）后传进来，翻章也走注入的 `ReaderPreviewSource`。
 * 3. **切换只改属性、不重建正文 DOM**：字号 / 底纹都落在
 *    `data-font` / `data-theme` 上，滚动位置因此天然不丢。
 *
 * 外框**不区分机型**（用户明确不要苹果/安卓两套）：只按手机的大致比例呈现，
 * 尺寸交给 CSS 按窗口高度自适应，保证整台手机一屏可见。
 */
import { App, Modal, Notice } from "obsidian";

export interface PhoneOption {
  id: string;
  label: string;
}

/** 字号四档：实际像素值在 `styles.css` 的 `.wt-phone-screen[data-font]` 里。 */
export const PHONE_FONTS: PhoneOption[] = [
  { id: "s", label: "小" },
  { id: "m", label: "标准" },
  { id: "l", label: "大" },
  { id: "xl", label: "特大" },
];

/** 阅读底纹：阅读器自己的配色，不跟随 Obsidian 主题（否则就不是「读者的手机」了）。 */
export const PHONE_THEMES: PhoneOption[] = [
  { id: "paper", label: "白纸" },
  { id: "sepia", label: "米黄" },
  { id: "night", label: "夜间" },
];

/** 一章的预览模型：正文已是交稿载荷（与复制出去的一致）。 */
export interface ReaderPreviewModel {
  path: string;
  /** 章节名（没有标题时用「第 N 章」或文件名） */
  title: string;
  /** 纯净正文 */
  text: string;
  /** 本章字数（宿主按当前统计口径算好） */
  words: number;
  /** 在本书里的序号（0 起）；-1 = 不属于任何作品目录 */
  index: number;
  /** 本书章节总数；0 = 未知 */
  total: number;
}

/** 翻章取数：相对当前章 ±1，边界或读取失败时返回 null。 */
export interface ReaderPreviewSource {
  load(offset: 1 | -1): Promise<ReaderPreviewModel | null>;
}

function formatNumber(n: number): string {
  return n.toLocaleString("en-US");
}

/**
 * 纯净正文按行切段：连续空行合成一个段间距，空行不生成空段落。
 * **不动行首空白**——作者手打的缩进要如实呈现，段首缩进由 CSS 补。
 */
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n+/)
    .map((line) => line.replace(/[ \t\u3000]+$/g, ""))
    .filter((line) => line.replace(/\s+/g, "").length > 0);
}

/**
 * 手机预览弹窗：外框 + 阅读器顶栏 + 正文滚动区 + 阅读器底栏 + 顶部显示设置。
 */
export class MobilePreviewModal extends Modal {
  private themeId = PHONE_THEMES[0].id;
  private fontId = PHONE_FONTS[1].id;

  private model: ReaderPreviewModel;
  private readonly source: ReaderPreviewSource;
  private busy = false;

  private deviceEl!: HTMLElement;
  private screenEl!: HTMLElement;
  /** 阅读顶栏的章节名（不要叫 titleEl：Modal 基类已有同名成员） */
  private chapterTitleEl!: HTMLElement;
  private subEl!: HTMLElement;
  private bodyEl!: HTMLElement;
  private pageEl!: HTMLElement;
  private infoEl!: HTMLElement;
  private prevBtn!: HTMLButtonElement;
  private nextBtn!: HTMLButtonElement;

  constructor(
    app: App,
    model: ReaderPreviewModel,
    source: ReaderPreviewSource
  ) {
    super(app);
    this.model = model;
    this.source = source;
  }

  onOpen(): void {
    const { contentEl, modalEl } = this;
    contentEl.empty();
    // 样式挂在 `.modal` 外壳上，与本仓库既有的 `wt-outline-modal` / `wt-diff-modal` 一致。
    modalEl.addClass("wt-phone-modal");

    contentEl.createDiv({ cls: "wt-phone-title", text: "读者手机预览" });
    contentEl.createDiv({
      cls: "wt-phone-hint",
      text: "内容与「一键复制纯净正文」一致；批注标记不会出现在这里。",
    });

    this.renderBar(contentEl);

    const stage = contentEl.createDiv({ cls: "wt-phone-stage" });
    this.deviceEl = stage.createDiv({ cls: "wt-phone-device" });
    this.screenEl = this.deviceEl.createDiv({ cls: "wt-phone-screen" });

    const status = this.screenEl.createDiv({ cls: "wt-phone-status" });
    status.createSpan({ cls: "wt-phone-status-time", text: "9:41" });
    status.createSpan({ cls: "wt-phone-status-icons" });

    const head = this.screenEl.createDiv({ cls: "wt-phone-reader-head" });
    this.chapterTitleEl = head.createDiv({ cls: "wt-phone-reader-title" });
    this.subEl = head.createDiv({ cls: "wt-phone-reader-sub" });

    this.pageEl = this.screenEl.createDiv({ cls: "wt-phone-page" });
    this.bodyEl = this.pageEl.createDiv({ cls: "wt-phone-body" });

    const foot = this.screenEl.createDiv({ cls: "wt-phone-reader-foot" });
    this.prevBtn = foot.createEl("button", {
      cls: "wt-phone-foot-btn is-prev",
      text: "上一章",
      attr: { type: "button" },
    });
    this.infoEl = foot.createSpan({ cls: "wt-phone-foot-info" });
    this.nextBtn = foot.createEl("button", {
      cls: "wt-phone-foot-btn is-next",
      text: "下一章",
      attr: { type: "button" },
    });

    this.prevBtn.addEventListener("click", () => void this.step(-1));
    this.nextBtn.addEventListener("click", () => void this.step(1));

    this.applyVisualState();
    this.renderChapter();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  /** 顶部两组显示设置：字号 / 底纹（不做机型切换）。 */
  private renderBar(parent: HTMLElement): void {
    const bar = parent.createDiv({ cls: "wt-phone-bar" });
    this.renderChipGroup(bar, "data-font", PHONE_FONTS, this.fontId, (id) => {
      this.fontId = id;
      this.applyVisualState();
    });
    this.renderChipGroup(bar, "data-theme", PHONE_THEMES, this.themeId, (id) => {
      this.themeId = id;
      this.applyVisualState();
    });
  }

  private renderChipGroup(
    parent: HTMLElement,
    attrName: "data-font" | "data-theme",
    options: PhoneOption[],
    activeId: string,
    onPick: (id: string) => void
  ): void {
    const group = parent.createDiv({ cls: "wt-phone-bar-group" });
    for (const option of options) {
      const attrs: Record<string, string> = { type: "button" };
      attrs[attrName] = option.id;
      const chip = group.createEl("button", {
        cls: "wt-phone-chip",
        text: option.label,
        attr: attrs,
      });
      if (option.id === activeId) chip.addClass("is-active");
      chip.addEventListener("click", () => onPick(option.id));
    }
  }

  /** 把偏好落到数据属性上——只改属性，不动正文 DOM，滚动位置不丢。 */
  private applyVisualState(): void {
    this.deviceEl.setAttr("data-theme", this.themeId);
    this.screenEl.setAttr("data-font", this.fontId);

    this.contentEl
      .querySelectorAll<HTMLElement>(".wt-phone-chip")
      .forEach((chip) => {
        const active =
          chip.getAttribute("data-font") === this.fontId ||
          chip.getAttribute("data-theme") === this.themeId;
        chip.toggleClass("is-active", active);
      });
  }

  /** 渲染当前章的标题、字数与正文段落。 */
  private renderChapter(): void {
    const { model } = this;
    const hasIndex = model.index >= 0 && model.total > 0;
    this.chapterTitleEl.setText(model.title);
    this.subEl.setText(
      hasIndex
        ? `第 ${model.index + 1}/${model.total} 章 · 本章 ${formatNumber(
            model.words
          )} 字`
        : `本章 ${formatNumber(model.words)} 字`
    );
    this.infoEl.setText(hasIndex ? `第 ${model.index + 1}/${model.total} 章` : "单篇");

    this.bodyEl.empty();
    for (const line of splitParagraphs(model.text)) {
      this.bodyEl.createEl("p", { cls: "wt-phone-p", text: line });
    }
    this.updateFootState();
  }

  /** 首章禁用「上一章」、末章禁用「下一章」；单篇文档两个都禁用。 */
  private updateFootState(): void {
    const hasIndex = this.model.index >= 0 && this.model.total > 0;
    const atStart = !hasIndex || this.model.index <= 0;
    const atEnd = !hasIndex || this.model.index >= this.model.total - 1;
    this.prevBtn.disabled = this.busy || atStart;
    this.nextBtn.disabled = this.busy || atEnd;
  }

  private async step(offset: 1 | -1): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.updateFootState();
    try {
      const next = await this.source.load(offset);
      if (next) {
        this.model = next;
        this.renderChapter();
        this.pageEl.scrollTop = 0;
      }
    } catch (error) {
      // 点击处是 `void this.step(...)`：这里必须兜住，否则读盘失败会变成
      // unhandled rejection，用户只看到按钮没反应。
      console.error("[Writing Toolkit:phone.preview] 翻章失败", error);
      new Notice("预览加载失败（详见控制台）");
    } finally {
      this.busy = false;
      this.updateFootState();
    }
  }
}

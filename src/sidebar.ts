import { ItemView, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import { WordCountMode } from "./wordcount";
import { SnapshotOperationPanel } from "./snapshotPanel";
import { ChapterOutlinePanel } from "./chapterOutline";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";
import { PomodoroWidget } from "./pomodoroWidget";

export const WRITING_TOOLKIT_SIDEBAR = "writing-toolkit-sidebar";

export const WORD_COUNT_MODE_LABELS: Record<WordCountMode, string> = {
  webnovel: "番茄模式（含标点）",
  standard: "标准模式（汉字+字母+数字）",
  native: "原生模式（分词计数）",
};

export class WritingToolkitSidebar extends ItemView {
  private readonly plugin: any;
  private pomodoroWidget: PomodoroWidget | null = null;
  private snapshotPanel: SnapshotOperationPanel | null = null;
  private chapterOutline: ChapterOutlinePanel | null = null;
  private activeTabIndex = 0;
  /** 标签页 / 面板引用：供命令直接切到指定分组 */
  private tabEls: HTMLElement[] = [];
  private panelEls: HTMLElement[] = [];
  private sectionTitles: string[] = [];
  private pomoStartBtn: HTMLButtonElement | null = null;
  /** combo 下拉菜单的清理函数（滚动监听 + 菜单 DOM），视图关闭时统一释放 */
  private comboCleanups: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, plugin: any) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_SIDEBAR;
  }

  getDisplayText(): string {
    return "工具箱";
  }

  getIcon(): string {
    return "pen-line";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.pomodoroWidget?.destroy();
    this.pomodoroWidget = null;
    this.snapshotPanel?.destroy();
    this.snapshotPanel = null;
    this.chapterOutline?.destroy();
    this.chapterOutline = null;
    this.contentEl.empty();
    // 释放 combo 菜单：移除滚动/缩放监听与挂在 body 上的菜单 DOM
    for (const fn of this.comboCleanups) fn();
    this.comboCleanups = [];
  }

  refresh(text?: string): void {
    this.pomodoroWidget?.update();
    this.snapshotPanel?.updateCurrentCount(text ?? null);
  }

  refreshSnapshotList(): void {
    this.snapshotPanel?.refresh();
  }

  refreshSettings(): void {
    this.render();
  }

  /** 命令入口：切到「章纲」标签并聚焦编辑框。 */
  openChapterOutline(): void {
    const index = this.sectionTitles.indexOf("章纲");
    if (index >= 0 && this.tabEls.length === this.sectionTitles.length) {
      this.activateTab(index, this.tabEls, this.panelEls);
    }
    this.chapterOutline?.focusEditor();
  }

  /** 根据番茄钟状态更新组件。 */
  updatePomodoroButton(phase: PomodoroPhase): void {
    this.pomodoroWidget?.update();
  }

  /** 番茄钟每秒 tick 或状态变化时实时刷新环形倒计时。 */
  updatePomodoro(state?: PomodoroState): void {
    this.pomodoroWidget?.update(state);
  }

  /** 工具箱里的一张纸卡：标题在卡内，与主页 .wt-card 同一套语言。 */
  private card(parent: HTMLElement, title: string): HTMLElement {
    const card = parent.createDiv({ cls: "wt-tb-card" });
    if (title) card.createDiv({ cls: "wt-tb-card-title", text: title });
    return card;
  }

  /** 卡内小节标题（打字机 / 排版）。first 为 true 时不画顶部分隔线。 */
  private sub(parent: HTMLElement, title: string, first = false): void {
    parent.createDiv({
      cls: first ? "wt-tb-sub is-first" : "wt-tb-sub",
      text: title,
    });
  }

  /** 卡内一行开关：名称靠左、开关靠右，行与行之间由 CSS 画虚线。 */
  private toggleRow(
    parent: HTMLElement,
    name: string,
    value: boolean,
    onChange: (value: boolean) => void | Promise<void>
  ): void {
    new Setting(parent).setName(name).addToggle((toggle) =>
      toggle.setValue(value).onChange((v) => void onChange(v))
    );
  }

  /**
   * 填写 + 选择两用输入（自绘下拉菜单）。
   * 菜单挂载到 document.body 并用 fixed 定位：
   * - 不会被卡片（overflow:hidden）或侧栏滚动容器裁剪；
   * - 下方空间不足时自动向上弹出；
   * - 滚动/缩放窗口时自动关闭，避免错位；
   * - 聚焦时总是显示全部选项，输入时按前缀过滤。
   * 点击选项即填入并提交；回车/失焦提交，越界自动钳制，非法输入还原。
   */
  private comboSetting(
    parent: HTMLElement,
    name: string,
    value: number,
    min: number,
    max: number,
    step: number,
    onCommit: (v: number) => void,
    suffix = ""
  ): void {
    // 步进的小数位数（0.05 → 2 位；5 → 0 位），避免浮点误差产生的长尾巴
    const decimals = step >= 1 ? 0 : (String(step).split(".")[1]?.length ?? 0);
    const format = (v: number): string =>
      `${Number(v.toFixed(decimals))}${suffix}`;
    const options: string[] = [];
    for (let v = min; v <= max + 1e-9; v += step) {
      options.push(format(v));
    }
    const current = format(value);
    if (!options.includes(current)) options.push(current);
    let committed = value;

    new Setting(parent).setName(name).addText((text) => {
      const input = text.inputEl;
      input.type = "text";
      input.value = current;
      input.placeholder = `${min} ~ ${max}`;
      input.addClass("wt-combo-input");

      // 下拉箭头按钮：唯一的下拉入口，点击打开/关闭菜单
      const control = input.parentElement;
      if (control) {
        control.addClass("wt-combo-control");
        const arrow = control.createEl("button", {
          cls: "wt-combo-arrow",
          attr: { type: "button" },
        });
        setIcon(arrow, "chevron-down");
        arrow.addEventListener("mousedown", (e) => e.preventDefault());
        arrow.addEventListener("click", () => {
          if (menu.hasClass("is-open")) {
            closeMenu();
          } else {
            input.focus();
            openMenu(true);
          }
        });
      }

      // 菜单挂到 body：脱离卡片/滚动容器的裁剪
      const menu = document.body.createDiv({ cls: "wt-combo-menu" });

      const commit = (): void => {
        const parsed = parseFloat(input.value);
        if (Number.isNaN(parsed)) {
          input.value = format(committed);
          return;
        }
        const clamped = Math.min(max, Math.max(min, parsed));
        input.value = format(clamped);
        // 值未变化时不重复提交（避免每次失焦都写盘）
        if (clamped !== committed) {
          committed = clamped;
          onCommit(clamped);
        }
      };

      /** 按输入框位置计算菜单位置；下方空间不足时向上弹出。 */
      const positionMenu = (): void => {
        const rect = input.getBoundingClientRect();
        const minWidth = Math.max(64, rect.width);
        // 定位数值通过 CSS 变量传入，样式规则在 styles.css 的 .wt-combo-menu 中
        menu.setCssProps({
          "--wt-menu-min-width": `${minWidth}px`,
          "--wt-menu-right": `${Math.max(8, window.innerWidth - rect.right)}px`,
        });
        // 估算菜单高度（每项约 26px + 内边距），与上下空间比较
        const est = Math.min(220, options.length * 26 + 16);
        const spaceBelow = window.innerHeight - rect.bottom - 8;
        const spaceAbove = rect.top - 8;
        if (spaceBelow >= est || spaceBelow >= spaceAbove) {
          menu.setCssProps({ "--wt-menu-top": `${rect.bottom + 4}px`, "--wt-menu-bottom": "auto" });
        } else {
          menu.setCssProps({ "--wt-menu-top": "auto", "--wt-menu-bottom": `${window.innerHeight - rect.top + 4}px` });
        }
      };

      /** showAll=true 时忽略当前输入值，展示全部选项（聚焦时用） */
      const renderMenu = (showAll: boolean): void => {
        menu.empty();
        const q = showAll ? "" : input.value.trim();
        for (const opt of options) {
          if (q && !opt.startsWith(q)) continue;
          const item = menu.createDiv({ cls: "wt-combo-item", text: opt });
          // mousedown 阻止默认行为：点击选项时输入框不失焦
          item.addEventListener("mousedown", (e) => e.preventDefault());
          item.addEventListener("click", () => {
            input.value = opt;
            commit();
            closeMenu();
            input.focus();
          });
        }
        if (menu.children.length === 0) {
          menu.createDiv({ cls: "wt-combo-empty", text: "无匹配选项" });
        }
      };

      const openMenu = (showAll: boolean): void => {
        renderMenu(showAll);
        positionMenu();
        menu.addClass("is-open");
      };
      const closeMenu = (): void => menu.removeClass("is-open");

      // 点击输入框本身不再弹菜单（下拉只由箭头按钮触发）；
      // 菜单已打开时输入，按前缀过滤选项
      input.addEventListener("input", () => {
        if (menu.hasClass("is-open")) renderMenu(false);
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          closeMenu();
          input.blur();
        } else if (e.key === "Escape") {
          closeMenu();
        }
      });
      input.addEventListener("blur", () => {
        closeMenu();
        commit();
      });

      // 菜单自身滚动（选项超长时）不关闭；其余滚动/缩放都会关闭菜单
      const onScroll = (e: Event): void => {
        const t = e.target as Node | null;
        if (t && (t === menu || menu.contains(t))) return;
        closeMenu();
      };
      const onResize = (): void => closeMenu();
      window.addEventListener("scroll", onScroll, true);
      window.addEventListener("resize", onResize);
      this.comboCleanups.push(() => {
        window.removeEventListener("scroll", onScroll, true);
        window.removeEventListener("resize", onResize);
        menu.remove();
      });
    });
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.pomodoroWidget?.destroy();
    this.pomodoroWidget = null;
    this.snapshotPanel?.destroy();
    this.snapshotPanel = null;
    this.chapterOutline?.destroy();
    this.chapterOutline = null;
    contentEl.addClass("wt-sidebar");

    // 品牌头：朱砂小印 + 宋体标题，与主页左侧导航列同一套语言
    const brand = contentEl.createDiv({ cls: "wt-tb-brand" });
    brand.createSpan({ cls: "wt-tb-seal", text: "写" });
    brand.createSpan({ cls: "wt-tb-brand-name", text: "工具箱" });

    const tabs = contentEl.createDiv({ cls: "wt-settings-tabs" });
    const panels = contentEl.createDiv({ cls: "wt-settings-panels" });
    const sections: Array<{ title: string; build: (el: HTMLElement) => void }> = [
      {
        title: "写作",
        build: (section) => {
          // 专注计时在最上面（今日目标、全年热力图与统计设置都在中间「主页」，
          // 这里不重复放一份）。
          this.pomodoroWidget = new PomodoroWidget(section, this.plugin);

          // 书写：打字机与排版
          const writeCard = this.card(section, "书写");
          this.sub(writeCard, "打字机", true);
          this.toggleRow(
            writeCard,
            "打字机模式",
            this.plugin.settings.typewriterMode,
            async (value) => {
              this.plugin.settings.typewriterMode = value;
              this.plugin.setTypewriterMode(value);
              await this.plugin.saveSettings();
            }
          );

          this.comboSetting(
            writeCard,
            "光标位置",
            Math.round(this.plugin.settings.typewriterOffset * 100),
            20,
            70,
            5,
            (v) => {
              this.plugin.settings.typewriterOffset = v / 100;
              this.plugin.setTypewriterOffset(v / 100);
              void this.plugin.saveSettings();
            },
            "%"
          );

          this.sub(writeCard, "排版");
          this.comboSetting(
            writeCard,
            "行高",
            this.plugin.settings.lineHeight,
            1.2,
            2.5,
            0.1,
            (v) => {
              this.plugin.settings.lineHeight = v;
              void this.plugin.saveSettings();
            }
          );

          this.comboSetting(
            writeCard,
            "段间距",
            this.plugin.settings.paragraphSpacing,
            0,
            1.5,
            0.1,
            (v) => {
              this.plugin.settings.paragraphSpacing = v;
              void this.plugin.saveSettings();
            }
          );

          this.toggleRow(
            writeCard,
            "段首缩进",
            this.plugin.settings.paragraphIndent,
            async (value) => {
              this.plugin.settings.paragraphIndent = value;
              await this.plugin.saveSettings();
            }
          );

          // 沉浸与辅助
          const focusCard = this.card(section, "沉浸与辅助");
          this.toggleRow(
            focusCard,
            "沉浸模式",
            this.plugin.settings.immersiveMode,
            async (value) => {
              this.plugin.settings.immersiveMode = value;
              this.plugin.setImmersiveMode(value);
              await this.plugin.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "高亮当前段落",
            this.plugin.settings.immersiveParagraphHighlight,
            async (value) => {
              this.plugin.settings.immersiveParagraphHighlight = value;
              this.plugin.setParagraphHighlight(value);
              await this.plugin.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "中文标点辅助",
            this.plugin.settings.punctuationAssist,
            async (value) => {
              this.plugin.settings.punctuationAssist = value;
              this.plugin.setPunctuationAssist(value);
              await this.plugin.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "海明威模式",
            this.plugin.settings.hemingwayMode,
            async (value) => {
              this.plugin.settings.hemingwayMode = value;
              this.plugin.setHemingwayMode(value);
              await this.plugin.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "信纸横线",
            this.plugin.settings.letterPaperMode,
            async (value) => {
              this.plugin.settings.letterPaperMode = value;
              await this.plugin.saveSettings();
            }
          );
        },
      },
      {
        title: "章纲",
        build: (section) => {
          const outlineSection = section.createDiv({ cls: "wt-sidebar-section" });
          this.chapterOutline = new ChapterOutlinePanel(outlineSection, this.plugin);
          this.chapterOutline.scheduleReload();
        },
      },
      {
        title: "快照",
        build: (section) => {
          const panelEl = section.createDiv({ cls: "wt-snapshot-panel" });
          this.snapshotPanel = new SnapshotOperationPanel(
            panelEl,
            this.plugin,
            this.plugin.snapshotManager
          );
          this.snapshotPanel.refresh();
        },
      },
    ];

    const tabEls: HTMLElement[] = [];
    const panelEls: HTMLElement[] = [];
    this.sectionTitles = sections.map((section) => section.title);
    sections.forEach((section, index) => {
      const tab = tabs.createEl("button", { cls: "wt-settings-tab", text: section.title });
      tab.setAttr("type", "button");
      tab.addEventListener("click", () => this.activateTab(index, tabEls, panelEls));
      tabEls.push(tab);

      const panel = panels.createDiv({ cls: "wt-settings-panel" });
      panelEls.push(panel);
      section.build(panel);
    });
    this.tabEls = tabEls;
    this.panelEls = panelEls;
    this.activateTab(Math.min(this.activeTabIndex, sections.length - 1), tabEls, panelEls);
  }

  private activateTab(index: number, tabs: HTMLElement[], panels: HTMLElement[]): void {
    this.activeTabIndex = index;
    tabs.forEach((tab, i) => tab.toggleClass("is-active", i === index));
    panels.forEach((panel, i) => panel.toggleClass("is-active", i === index));
    // 章纲面板需要撑满侧栏剩余高度（长章纲不再挤在小框里），用类名交给 CSS
    this.contentEl.toggleClass("wt-tab-outline", this.sectionTitles[index] === "章纲");
  }
}

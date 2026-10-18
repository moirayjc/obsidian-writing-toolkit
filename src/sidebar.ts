import { ItemView, Setting, WorkspaceLeaf, setIcon } from "obsidian";
import type { UiPanelGroup } from "./services/uiService";
import type { PomodoroPhase, PomodoroState } from "./pomodoro";
import { PomodoroWidget } from "./pomodoroWidget";
import { WRITING_TOOLKIT_SIDEBAR } from "./uiSlots";
import type { UiShellContext } from "./uiShellContext";

export { WRITING_TOOLKIT_SIDEBAR } from "./uiSlots";

/** 侧栏只消费徽标需要的窄视图，不依赖批注面板的实现模块。 */
interface CommentsBadgeView {
  items: ReadonlyArray<{ status: string }>;
}

export class WritingToolkitSidebar extends ItemView {
  private readonly host: UiShellContext;
  private pomodoroWidget: PomodoroWidget | null = null;
  private snapshotPanel: UiPanelGroup | null = null;
  private outlinePanel: UiPanelGroup | null = null;
  private commentsPanel: UiPanelGroup | null = null;
  /** 「批注」标签上的计数徽标 */
  private commentsBadgeEl: HTMLSpanElement | null = null;
  /** 徽标异步更新的代数（防止旧结果覆盖新结果） */
  private badgeSeq = 0;
  private activeTabIndex = 0;
  /** 「批注」分组在标签里的下标；点正文标记时用它切过去 */
  private commentsTabIndex = -1;
  /** 标签页 / 面板引用：供命令直接切到指定分组 */
  private tabEls: HTMLElement[] = [];
  private panelEls: HTMLElement[] = [];
  private sectionTitles: string[] = [];
  private pomoStartBtn: HTMLButtonElement | null = null;
  /** combo 下拉菜单的清理函数（滚动监听 + 菜单 DOM），视图关闭时统一释放 */
  private comboCleanups: Array<() => void> = [];

  constructor(leaf: WorkspaceLeaf, host: UiShellContext) {
    super(leaf);
    this.host = host;
  }

  getViewType(): string {
    return WRITING_TOOLKIT_SIDEBAR;
  }

  getDisplayText(): string {
    return "工具箱";
  }

  getIcon(): string {
    return "wt-toolbox";
  }

  async onOpen(): Promise<void> {
    this.render();
  }

  async onClose(): Promise<void> {
    this.pomodoroWidget?.destroy();
    this.pomodoroWidget = null;
    this.snapshotPanel?.destroy();
    this.snapshotPanel = null;
    this.outlinePanel?.destroy();
    this.outlinePanel = null;
    this.commentsPanel?.destroy();
    this.commentsPanel = null;
    this.commentsBadgeEl = null;
    this.contentEl.empty();
    // 释放 combo 菜单：移除滚动/缩放监听与挂在 body 上的菜单 DOM
    for (const fn of this.comboCleanups) fn();
    this.comboCleanups = [];
  }

  refresh(text?: string): void {
    this.pomodoroWidget?.update();
    this.snapshotPanel?.updateLive(text ?? null);
  }

  refreshSettings(): void {
    this.render();
  }

  /** 重建工具箱里的批注列表并更新标签计数（主插件在批注变化 / 切文档时调用）。 */
  refreshComments(): void {
    this.commentsPanel?.refresh();
    this.refreshCommentsBadge();
  }

  /** 批注数据或活动文档变化后只更新标签徽标，面板刷新由 comments 模块负责。 */
  refreshCommentsBadge(): void {
    void this.updateCommentsBadge();
  }

  /** 在「批注」标签上显示当前文档的批注总数（待处理为蓝、全部处理完为灰、无批注隐藏）。 */
  private async updateCommentsBadge(): Promise<void> {
    const badge = this.commentsBadgeEl;
    if (!badge) return;
    const seq = ++this.badgeSeq;
    let model: CommentsBadgeView;
    try {
      model = await this.host.caps.comments.panelModel();
    } catch {
      return;
    }
    if (seq !== this.badgeSeq || badge !== this.commentsBadgeEl) return;
    const total = model.items.length;
    const pending = model.items.filter((item) => item.status === "pending")
      .length;
    badge.setText(total > 0 ? String(total) : "");
    badge.toggleClass("is-empty", total === 0);
    badge.toggleClass("is-done", total > 0 && pending === 0);
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

  /**
   * 卡内一组「同一个模块」的行。
   * 组内不画分隔线，组与组之间才画——没有小标题也能看出模块边界。
   */
  private group(parent: HTMLElement): HTMLElement {
    return parent.createDiv({ cls: "wt-tb-group" });
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
        setIcon(arrow, "wt-chevron-down");
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
    this.outlinePanel?.destroy();
    this.outlinePanel = null;
    this.commentsPanel?.destroy();
    this.commentsPanel = null;
    contentEl.addClass("wt-sidebar");

    // 品牌头：朱砂小印 + 宋体标题，与主页左侧导航列同一套语言
    const brand = contentEl.createDiv({ cls: "wt-tb-brand" });
    brand.createSpan({ cls: "wt-tb-seal", text: "写" });
    brand.createSpan({ cls: "wt-tb-brand-name", text: "工具箱" });

    const tabs = contentEl.createDiv({ cls: "wt-settings-tabs" });
    const panels = contentEl.createDiv({ cls: "wt-settings-panels" });
    const sections: Array<{
      title: string;
      build: (el: HTMLElement) => void;
      /** 建完标签按钮后的装饰钩子（如「批注」标签上的计数徽标） */
      onTabCreated?: (tab: HTMLElement) => void;
    }> = [
      {
        title: "写作",
        build: (section) => {
          // 专注计时在最上面（今日目标、全年热力图与统计设置都在中间「主页」，
          // 这里不重复放一份）。
          this.pomodoroWidget = new PomodoroWidget(section, this.host.caps.pomodoro);

          // 打字机与排版合成一张无标题卡，卡内按「模块」分成两个小组：
          // 打字机（模式 / 光标位置）、排版（行高 / 段间距 / 段首缩进）。
          // 组内不画分隔线、组与组之间才画——不再写「书写 / 打字机 / 排版」
          // 三行小标题，模块边界仍然看得出来。
          const writeCard = this.card(section, "");
          const typewriterGroup = this.group(writeCard);
          this.toggleRow(
            typewriterGroup,
            "打字机模式",
            this.host.settings.typewriterMode,
            async (value) => {
              this.host.settings.typewriterMode = value;
              this.host.editorOptions.setTypewriterMode(value);
              await this.host.actions.saveSettings();
            }
          );

          this.comboSetting(
            typewriterGroup,
            "光标位置",
            Math.round(this.host.settings.typewriterOffset * 100),
            20,
            70,
            5,
            (v) => {
              this.host.settings.typewriterOffset = v / 100;
              this.host.editorOptions.setTypewriterOffset(v / 100);
              void this.host.actions.saveSettings();
            },
            "%"
          );

          const typeGroup = this.group(writeCard);
          this.comboSetting(
            typeGroup,
            "行高",
            this.host.settings.lineHeight,
            1.2,
            2.5,
            0.1,
            (v) => {
              this.host.settings.lineHeight = v;
              void this.host.actions.saveSettings();
            }
          );

          this.comboSetting(
            typeGroup,
            "段间距",
            this.host.settings.paragraphSpacing,
            0,
            1.5,
            0.1,
            (v) => {
              this.host.settings.paragraphSpacing = v;
              void this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            typeGroup,
            "段首缩进",
            this.host.settings.paragraphIndent,
            async (value) => {
              this.host.settings.paragraphIndent = value;
              await this.host.actions.saveSettings();
            }
          );

          // 沉浸与辅助：同样不写卡头，一列开关靠虚线分隔
          const focusCard = this.card(section, "");
          this.toggleRow(
            focusCard,
            "沉浸模式",
            this.host.settings.immersiveMode,
            async (value) => {
              this.host.settings.immersiveMode = value;
              this.host.editorOptions.setImmersiveMode(value);
              await this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "高亮当前段落",
            this.host.settings.immersiveParagraphHighlight,
            async (value) => {
              this.host.settings.immersiveParagraphHighlight = value;
              this.host.editorOptions.setParagraphHighlight(value);
              await this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "中文标点辅助",
            this.host.settings.punctuationAssist,
            async (value) => {
              this.host.settings.punctuationAssist = value;
              this.host.editorOptions.setPunctuationAssist(value);
              await this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "海明威模式",
            this.host.settings.hemingwayMode,
            async (value) => {
              this.host.settings.hemingwayMode = value;
              this.host.editorOptions.setHemingwayMode(value);
              await this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "信纸横线",
            this.host.settings.letterPaperMode,
            async (value) => {
              this.host.settings.letterPaperMode = value;
              await this.host.actions.saveSettings();
            }
          );

          this.toggleRow(
            focusCard,
            "标题样式",
            this.host.settings.headingStyle,
            async (value) => {
              this.host.settings.headingStyle = value;
              await this.host.actions.saveSettings();
            }
          );
        },
      },
      {
        title: "章纲",
        build: (section) => {
          const outlineSection = section.createDiv({
            cls: "wt-sidebar-section",
          });
          const panels = this.host.caps.panels.mountOutlinePanels(outlineSection);
          this.outlinePanel = panels;
          panels.refresh();
        },
      },
      {
        title: "批注",
        onTabCreated: (tab) => {
          this.commentsBadgeEl = tab.createSpan({
            cls: "wt-tab-badge is-empty",
          });
        },
        build: (section) => {
          const panelEl = section.createDiv({ cls: "wt-tb-comments" });
          const panel = this.host.caps.panels.mountCommentsPanels(panelEl);
          this.commentsPanel = panel;
          panel.refresh();
          void this.updateCommentsBadge();
        },
      },
      {
        title: "快照",
        build: (section) => {
          const panelEl = section.createDiv({ cls: "wt-snapshot-panel" });
          const panels = this.host.caps.panels.mountSnapshotPanels(panelEl);
          this.snapshotPanel = panels;
          panels.refresh();
        },
      },
    ];

    const tabEls: HTMLElement[] = [];
    const panelEls: HTMLElement[] = [];
    this.sectionTitles = sections.map((section) => section.title);
    sections.forEach((section, index) => {
      if (section.title === "批注") this.commentsTabIndex = index;
      const tab = tabs.createEl("button", { cls: "wt-settings-tab", text: section.title });
      tab.setAttr("type", "button");
      tab.addEventListener("click", () => this.activateTab(index, tabEls, panelEls));
      tabEls.push(tab);
      section.onTabCreated?.(tab);

      const panel = panels.createDiv({ cls: "wt-settings-panel" });
      panelEls.push(panel);
      section.build(panel);
    });
    this.tabEls = tabEls;
    this.panelEls = panelEls;
    this.activateTab(Math.min(this.activeTabIndex, sections.length - 1), tabEls, panelEls);
  }

  /** 切到「批注」标签；具体卡片定位由 comments 模块的插槽句柄完成。 */
  activateCommentsTab(): void {
    if (this.commentsTabIndex >= 0 && this.tabEls.length) {
      this.activateTab(this.commentsTabIndex, this.tabEls, this.panelEls);
    }
  }

  private activateTab(index: number, tabs: HTMLElement[], panels: HTMLElement[]): void {
    this.activeTabIndex = index;
    tabs.forEach((tab, i) => tab.toggleClass("is-active", i === index));
    panels.forEach((panel, i) => panel.toggleClass("is-active", i === index));
    // 章纲面板需要撑满侧栏剩余高度（长章纲不再挤在小框里），用类名交给 CSS
    this.contentEl.toggleClass("wt-tab-outline", this.sectionTitles[index] === "章纲");
  }
}

import { PluginSettingTab, Setting, App, Plugin } from "obsidian";
import { WordCountMode } from "./wordcount";
import { DEFAULT_SNAPSHOT_SETTINGS, SnapshotSettings } from "./snapshot";
import { DEFAULT_CHAPTER_EXCLUDE_NAMES } from "./outlineText";

interface DailyHistory {
  [date: string]: number;
}

export type DailyDisplayMode = "words" | "duration";

/** 配色主题：warm 暖纸（默认）/ cool 极简冷淡 / contrast 高对比度 */
export type ThemeTone = "warm" | "cool" | "contrast";

export const THEME_TONE_LABELS: Record<ThemeTone, string> = {
  warm: "暖纸（默认）",
  cool: "极简冷淡",
  contrast: "高对比度",
};

/** 编辑工具条的生效范围：全库 / 全库排除正文 / 仅自己作品与共用资料库 */
export type FormatToolbarScope = "all" | "all-except-chapters" | "library-only";

export interface WritingToolkitSettings extends SnapshotSettings {
  themeTone: ThemeTone;
  lineHeight: number;
  paragraphSpacing: number;
  letterPaperMode: boolean;
  paragraphIndent: boolean;
  typewriterMode: boolean;
  typewriterOffset: number;
  immersiveMode: boolean;
  immersiveParagraphHighlight: boolean;
  hemingwayMode: boolean;
  punctuationAssist: boolean;
  hardBreakOnEnter: boolean;
  /** 选中文字时浮出的格式工具条（加粗/斜体/下划线/删除线/高亮/字色） */
  formatToolbarEnabled: boolean;
  /** 工具条的生效范围（正文默认排除） */
  formatToolbarScope: FormatToolbarScope;
  /** 批注功能总开关（选中文字加批注、侧栏批注面板） */
  commentsEnabled: boolean;
  /** 批注按钮不受工具条生效范围限制（全库文件都能批注） */
  commentBubbleEverywhere: boolean;
  dailyGoal: number;
  dailyDisplayMode: DailyDisplayMode;
  wordCountMode: WordCountMode;
  showSpeed: boolean;
  statusBarOnlyImmersive: boolean;
  /** 手机端：在正文界面上常驻一条轻量状态条（进度 / 番茄 / 时速） */
  mobileStatusBar: boolean;
  pomodoroFocusMinutes: number;
  pomodoroBreakMinutes: number;
  pomodoroLongBreakEvery: number;
  pomodoroLongBreakMinutes: number;
  pomodoroAutoSnapshot: boolean;
  draftKeywords: string;
  /** 「不算章节」的辅助文件名（逗号分隔，如 Agent.md），不计入章节列表与字数统计 */
  chapterExcludeNames: string;
  outlineStorageMode: "sidecar" | "frontmatter";
  /** 「新建作品」统一创建位置（仓库相对路径） */
  newProjectFolder: string;
  /** 共用资料库目录（仓库相对路径）：工作台「资料库」页展示 */
  sharedLibraryFolder: string;
}

export const DEFAULT_SETTINGS: WritingToolkitSettings = {
  ...DEFAULT_SNAPSHOT_SETTINGS,
  themeTone: "warm",
  lineHeight: 1.8,
  paragraphSpacing: 0.5,
  letterPaperMode: true,
  paragraphIndent: true,
  typewriterMode: false,
  typewriterOffset: 0.4,
  immersiveMode: false,
  immersiveParagraphHighlight: true,
  hemingwayMode: false,
  punctuationAssist: true,
  hardBreakOnEnter: true,
  formatToolbarEnabled: true,
  formatToolbarScope: "all-except-chapters",
  commentsEnabled: true,
  commentBubbleEverywhere: true,
  dailyGoal: 5000,
  dailyDisplayMode: "words",
  wordCountMode: "webnovel",
  showSpeed: true,
  statusBarOnlyImmersive: true,
  mobileStatusBar: true,
  pomodoroFocusMinutes: 25,
  pomodoroBreakMinutes: 5,
  pomodoroLongBreakEvery: 4,
  pomodoroLongBreakMinutes: 15,
  pomodoroAutoSnapshot: true,
  draftKeywords: "正文草稿, 正文, 章节, 草稿, 卷, draft, chapter",
  chapterExcludeNames: DEFAULT_CHAPTER_EXCLUDE_NAMES,
  outlineStorageMode: "sidecar",
  newProjectFolder: "写作/新作品",
  sharedLibraryFolder: "写作/资料库",
};

const WORD_COUNT_MODE_LABELS: Record<WordCountMode, string> = {
  webnovel: "番茄模式（含标点）",
  standard: "标准模式（汉字+字母+数字）",
  native: "原生模式（分词计数）",
};

export const DAILY_DISPLAY_MODE_LABELS: Record<DailyDisplayMode, string> = {
  words: "字数",
  duration: "时长",
};

/**
 * 设置页需要的插件接口。刻意不与 Obsidian 的 Plugin 类型交叉，
 * 避免 Plugin.settings（1.13.0 才有）被官方扫描误判为不兼容 API。
 */
export interface WritingToolkitPluginLike {
    settings: WritingToolkitSettings;
    dailyHistory: DailyHistory;
    saveSettings: () => Promise<void>;
    setTypewriterMode: (on: boolean) => void;
    setTypewriterOffset: (offset: number) => void;
    setPunctuationAssist: (on: boolean) => void;
    setHardBreakOnEnter: (on: boolean) => void;
    setWordCountMode: (mode: WordCountMode) => void;
    setImmersiveMode: (on: boolean) => void;
    setParagraphHighlight: (on: boolean) => void;
    setHemingwayMode: (on: boolean) => void;
    saveSnapshotNow: () => Promise<void>;
    openSnapshotFolder: () => Promise<void>;
    repairProjectStatPaths: () => Promise<void>;
    updateStatusBarVisibility: () => void;
    refreshMobileStatusBar: () => void;
    /** 批注总开关变化后，刷新已打开文档里的批注痕迹 */
    refreshAllCommentDecors: () => void;
}

export class WritingToolkitSettingTab extends PluginSettingTab {
  private wt: WritingToolkitPluginLike;

  private activeTabIndex: number = 0;
  private tabEls: HTMLElement[] = [];
  private panelEls: HTMLElement[] = [];

  constructor(app: App, plugin: WritingToolkitPluginLike) {
    super(app, plugin as unknown as Plugin);
    this.wt = plugin;
  }

  /** 设置页里的一张纸卡：标题在卡内，与工具箱、主页同一套语言。 */
  private card(parent: HTMLElement, title: string): HTMLElement {
    const card = parent.createDiv({ cls: "wt-tb-card" });
    if (title) card.createDiv({ cls: "wt-tb-card-title", text: title });
    return card;
  }

  /**
   * 分组卡片：把同功能模块的设置项包进一个整体块，标题在卡内。
   * 与工具箱、主页的卡片是同一套外观。
   */
  private group(
    title: string,
    parent: HTMLElement,
    build: (el: HTMLElement) => void
  ): void {
    build(this.card(parent, title));
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("wt-settings-page");

    // 品牌头：朱砂小印 + 宋体标题，与主页导航列、工具箱同一套语言
    const brand = containerEl.createDiv({ cls: "wt-tb-brand" });
    brand.createSpan({ cls: "wt-tb-seal", text: "写" });
    brand.createSpan({ cls: "wt-tb-brand-name", text: "写作工具箱" });

    this.tabEls = [];
    this.panelEls = [];
    const tabs = containerEl.createDiv({ cls: "wt-settings-tabs" });
    const panels = containerEl.createDiv({ cls: "wt-settings-panels" });

    const sections: Array<{ title: string; build: (el: HTMLElement) => void }> = [
      {
        title: "统计",
        build: (section) => {
          // 联系松散的统计偏好：收进一张卡
          const statsCard = this.card(section, "统计");
          new Setting(statsCard)
            .setName("每日目标字数")
            .setDesc("状态栏进度条的目标值")
            .addText((text) =>
              text
                .setValue(String(this.wt.settings.dailyGoal))
                .onChange(async (val) => {
                  const num = parseInt(val, 10);
                  if (num > 0) {
                    this.wt.settings.dailyGoal = num;
                    await this.wt.saveSettings();
                  }
                })
            );

          new Setting(statsCard)
            .setName("字数统计模式")
            .setDesc("番茄模式统计所有非空白字符（含标点）；标准模式只统计汉字、字母和数字；原生模式按词组计数")
            .addDropdown((dd) => {
              for (const [key, label] of Object.entries(WORD_COUNT_MODE_LABELS)) {
                dd.addOption(key, label);
              }
              dd.setValue(this.wt.settings.wordCountMode);
              dd.onChange(async (val) => {
                this.wt.settings.wordCountMode = val as WordCountMode;
                this.wt.setWordCountMode(val as WordCountMode);
                await this.wt.saveSettings();
              });
            });

          new Setting(statsCard)
            .setName("显示码字时速")
            .setDesc("在状态栏显示实时码字速度")
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.showSpeed)
                .onChange(async (value) => {
                  this.wt.settings.showSpeed = value;
                  await this.wt.saveSettings();
                })
            );

          new Setting(statsCard)
            .setName("热力图显示方式")
            .setDesc("选择热力图按每日净增字数或有效写作时长着色")
            .addDropdown((dropdown) => {
              for (const [key, label] of Object.entries(DAILY_DISPLAY_MODE_LABELS)) {
                dropdown.addOption(key, label);
              }
              dropdown.setValue(this.wt.settings.dailyDisplayMode).onChange(async (value) => {
                this.wt.settings.dailyDisplayMode = value as DailyDisplayMode;
                await this.wt.saveSettings();
              });
            });

          new Setting(statsCard)
            .setName("状态栏仅在沉浸模式显示")
            .setDesc("常规编辑时右下角状态栏保持隐藏，由侧栏统一承载；进入沉浸模式时自动显现")
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.statusBarOnlyImmersive)
                .onChange(async (value) => {
                  this.wt.settings.statusBarOnlyImmersive = value;
                  this.wt.updateStatusBarVisibility();
                  await this.wt.saveSettings();
                })
            );

          new Setting(statsCard)
            .setName("手机端常驻状态条")
            .setDesc(
              "手机版没有状态栏，开启后在阅读 / 编辑正文时于屏幕底部显示一条轻量状态条（今日进度 · 番茄 · 时速），点击可打开菜单"
            )
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.mobileStatusBar)
                .onChange(async (value) => {
                  this.wt.settings.mobileStatusBar = value;
                  this.wt.refreshMobileStatusBar();
                  await this.wt.saveSettings();
                })
            );

          new Setting(statsCard)
            .setName("修复项目统计路径")
            .setDesc("作品文件夹改名后，检查并迁移失联的项目统计记录")
            .addButton((button) =>
              button
                .setButtonText("检查并修复")
                .onClick(() => void this.wt.repairProjectStatPaths())
            );

          this.group("番茄钟", section, (el) => {
            new Setting(el)
              .setName("专注时长")
              .setDesc("一个番茄的专注写作时长")
              .addSlider((slider) =>
                slider
                  .setLimits(5, 120, 5)
                  .setValue(this.wt.settings.pomodoroFocusMinutes)
                  .onChange(async (value) => {
                    this.wt.settings.pomodoroFocusMinutes = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("休息时长")
              .setDesc("番茄结束后的休息时长；设为 0 则不休息")
              .addSlider((slider) =>
                slider
                  .setLimits(0, 30, 1)
                  .setValue(this.wt.settings.pomodoroBreakMinutes)
                  .onChange(async (value) => {
                    this.wt.settings.pomodoroBreakMinutes = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("长休息间隔")
              .setDesc("每完成几个番茄后进入一次长休息")
              .addSlider((slider) =>
                slider
                  .setLimits(2, 8, 1)
                  .setValue(this.wt.settings.pomodoroLongBreakEvery)
                  .onChange(async (value) => {
                    this.wt.settings.pomodoroLongBreakEvery = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("长休息时长")
              .addSlider((slider) =>
                slider
                  .setLimits(5, 60, 5)
                  .setValue(this.wt.settings.pomodoroLongBreakMinutes)
                  .onChange(async (value) => {
                    this.wt.settings.pomodoroLongBreakMinutes = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("结束自动保存快照")
              .setDesc("每个番茄完成时自动保存一次当前草稿快照")
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.pomodoroAutoSnapshot)
                  .onChange(async (value) => {
                    this.wt.settings.pomodoroAutoSnapshot = value;
                    await this.wt.saveSettings();
                  })
              );
          });
        },
      },
      {
        title: "写作",
        build: (section) => {
          this.group("打字机", section, (el) => {
            new Setting(el)
              .setName("打字机模式")
              .setDesc("光标保持在上半屏，命令面板或快捷键切换")
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.typewriterMode)
                  .onChange(async (value) => {
                    this.wt.settings.typewriterMode = value;
                    this.wt.setTypewriterMode(value);
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("光标稳定位置")
              .setDesc("光标在编辑区中的垂直位置；40% 为默认上半屏位置")
              .addSlider((slider) =>
                slider
                  .setLimits(20, 70, 5)
                  .setValue(this.wt.settings.typewriterOffset * 100)
                  .onChange(async (value) => {
                    const offset = value / 100;
                    this.wt.settings.typewriterOffset = offset;
                    this.wt.setTypewriterOffset(offset);
                    await this.wt.saveSettings();
                  })
              );
          });

          this.group("编辑工具条", section, (el) => {
            new Setting(el)
              .setName("选中浮出格式工具条")
              .setDesc(
                "在编辑器里选中文字时浮出小工具条：加粗、斜体、下划线、删除线、高亮、字色。再点一次同一格式即取消；命令面板里也有对应的「格式：…」命令"
              )
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.formatToolbarEnabled)
                  .onChange(async (value) => {
                    this.wt.settings.formatToolbarEnabled = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("工具条生效范围")
              .setDesc(
                "「正文」指作品正文草稿目录里的章节。字色、下划线是 HTML 写法：阅读视图正常显示，实时预览里可能看到原始标签；默认不在正文中浮出，设定、章纲、资料等不受影响，随时可调"
              )
              .addDropdown((dd) => {
                dd.addOption("all", "全库所有文件");
                dd.addOption("all-except-chapters", "全库，排除正文（默认）");
                dd.addOption("library-only", "仅自己作品的文件与共用资料库");
                dd.setValue(this.wt.settings.formatToolbarScope);
                dd.onChange(async (val) => {
                  this.wt.settings.formatToolbarScope = val as FormatToolbarScope;
                  await this.wt.saveSettings();
                });
              });
          });

          this.group("批注", section, (el) => {
            new Setting(el)
              .setName("批注")
              .setDesc(
                "选中文字后可以加批注（气泡上的批注按钮，或右键「添加批注」）。批注存在同目录的「文档名.批注.md」文件里，正文一个字都不动；适合「Agent 写稿 → 你批注 → Agent 读批注文件改稿」的流程"
              )
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.commentsEnabled)
                  .onChange(async (value) => {
                    this.wt.settings.commentsEnabled = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("批注按钮全库可用")
              .setDesc(
                "批注按钮不受上面「工具条生效范围」限制：开启后正文里也能批注；关闭则和格式工具条的范围一致"
              )
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.commentBubbleEverywhere)
                  .onChange(async (value) => {
                    this.wt.settings.commentBubbleEverywhere = value;
                    await this.wt.saveSettings();
                  })
              );

          });

          // 沉浸与编辑辅助：收进一张卡
          const auxCard = this.card(section, "沉浸与辅助");
          new Setting(auxCard)
            .setName("沉浸模式")
            .setDesc("隐藏外围界面，按 esc 退出")
            .addToggle((toggle) =>
              toggle.setValue(this.wt.settings.immersiveMode).onChange(async (value) => {
                this.wt.settings.immersiveMode = value;
                this.wt.setImmersiveMode(value);
                await this.wt.saveSettings();
              })
            );

          new Setting(auxCard)
            .setName("高亮当前段落")
            .setDesc("突出显示当前编辑段落")
            .addToggle((toggle) =>
              toggle.setValue(this.wt.settings.immersiveParagraphHighlight).onChange(async (value) => {
                this.wt.settings.immersiveParagraphHighlight = value;
                this.wt.setParagraphHighlight(value);
                await this.wt.saveSettings();
              })
            );

          new Setting(auxCard)
            .setName("中文标点辅助")
            .setDesc("输入中文左引号、括号和书名号时自动补全；英文标点不受影响")
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.punctuationAssist)
                .onChange(async (value) => {
                  this.wt.settings.punctuationAssist = value;
                  this.wt.setPunctuationAssist(value);
                  await this.wt.saveSettings();
                })
            );

          new Setting(auxCard)
            .setName("回车即新段落")
            .setDesc("按一次回车直接插入段落分隔（空行），等同常规 Markdown 编辑器（如 Typora）的一次回车；Shift+Enter 仍为软换行，列表/标题/引用/代码块内保持 Obsidian 默认行为")
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.hardBreakOnEnter)
                .onChange(async (value) => {
                  this.wt.settings.hardBreakOnEnter = value;
                  this.wt.setHardBreakOnEnter(value);
                  await this.wt.saveSettings();
                })
            );

          new Setting(auxCard)
            .setName("信纸横线")
            .setDesc("编辑区按行显示虚线标线（像信纸），随行高对齐；空行即段落分隔处自动断开，内容显示不受影响")
            .addToggle((toggle) =>
              toggle
                .setValue(this.wt.settings.letterPaperMode)
                .onChange(async (value) => {
                  this.wt.settings.letterPaperMode = value;
                  await this.wt.saveSettings();
                })
            );

          new Setting(auxCard)
            .setName("海明威模式")
            .setDesc("锁定已有内容，只能向后追加写作，防回改；关闭后恢复自由编辑")
            .addToggle((toggle) =>
              toggle.setValue(this.wt.settings.hemingwayMode).onChange(async (value) => {
                this.wt.settings.hemingwayMode = value;
                this.wt.setHemingwayMode(value);
                await this.wt.saveSettings();
              })
            );

          this.group("排版", section, (el) => {
            new Setting(el)
              .setName("配色主题")
              .setDesc("暖纸保持原有的米色书房风格；极简冷淡为低饱和的冷灰与蓝灰；高对比度为白底黑字、边线分明")
              .addDropdown((dd) => {
                for (const [key, label] of Object.entries(THEME_TONE_LABELS)) {
                  dd.addOption(key, label);
                }
                dd.setValue(this.wt.settings.themeTone);
                dd.onChange(async (val) => {
                  this.wt.settings.themeTone = val as ThemeTone;
                  await this.wt.saveSettings();
                });
              });

            new Setting(el)
              .setName("行高")
              .setDesc("1.6 ~ 2.0 为中文舒适区间")
              .addSlider((slider) =>
                slider
                  .setLimits(1.2, 2.5, 0.1)
                  .setValue(this.wt.settings.lineHeight)
                  .onChange(async (value) => {
                    this.wt.settings.lineHeight = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("段间距")
              .setDesc("段落之间的额外间距，0.5em 较为适中")
              .addSlider((slider) =>
                slider
                  .setLimits(0, 1.5, 0.1)
                  .setValue(this.wt.settings.paragraphSpacing)
                  .onChange(async (value) => {
                    this.wt.settings.paragraphSpacing = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("段首缩进")
              .setDesc("正文段首缩进两字符（符合中文习惯）；纯视觉缩进，不向文档写入空格，不会被误删；标题/列表/引用/代码块不缩进")
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.paragraphIndent)
                  .onChange(async (value) => {
                    this.wt.settings.paragraphIndent = value;
                    await this.wt.saveSettings();
                  })
              );
          });
        },
      },
      {
        title: "快照",
        build: (section) => {
          this.group("自动快照", section, (el) => {
            new Setting(el)
              .setName("自动快照")
              .setDesc("写作会话结束、连续写作或停止输入时自动保存当前草稿快照")
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.snapshotEnabled)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotEnabled = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("快照文件夹")
              .setDesc("相对库根目录的文件夹；默认 .wt-snapshots（隐藏，不显示在侧栏），如需随坚果云同步请改为普通文件夹")
              .addText((text) =>
                text
                  .setValue(this.wt.settings.snapshotFolder)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotFolder = value.trim();
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("连续写作快照间隔")
              .setDesc("在同一文件连续写作超过该分钟数时自动保存一份")
              .addSlider((slider) =>
                slider
                  .setLimits(1, 60, 1)
                  .setValue(this.wt.settings.snapshotIntervalMinutes)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotIntervalMinutes = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("停止输入即保存")
              .setDesc("停止输入超过该分钟数视为本次写作会话结束，自动保存快照")
              .addSlider((slider) =>
                slider
                  .setLimits(1, 15, 1)
                  .setValue(this.wt.settings.snapshotIdleMinutes)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotIdleMinutes = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("每文件保留快照数")
              .setDesc("超出部分自动删除最旧快照；设为 0 表示不清理")
              .addSlider((slider) =>
                slider
                  .setLimits(0, 100, 5)
                  .setValue(this.wt.settings.snapshotMaxPerFile)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotMaxPerFile = value;
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("仅自动快照正文草稿")
              .setDesc("只对路径含「正文草稿」的文件自动快照；手动快照不受限制")
              .addToggle((toggle) =>
                toggle
                  .setValue(this.wt.settings.snapshotOnlyDrafts)
                  .onChange(async (value) => {
                    this.wt.settings.snapshotOnlyDrafts = value;
                    await this.wt.saveSettings();
                  })
              );
          });

          this.group("操作", section, (el) => {
            new Setting(el)
              .setName("立即保存")
              .setDesc("为当前打开的笔记保存一份快照（任意 Markdown 文件均可）")
              .addButton((button) =>
                button.setButtonText("保存当前快照").onClick(async () => {
                  await this.wt.saveSnapshotNow();
                })
              );

            new Setting(el)
              .setName("打开快照文件夹")
              .addButton((button) =>
                button.setButtonText("在系统文件管理器中打开").onClick(async () => {
                  await this.wt.openSnapshotFolder();
                })
              );
          });
        },
      },
      {
        title: "章纲",
        build: (section) => {
          this.group("章节识别", section, (el) => {
            new Setting(el)
              .setName("正文章节关键词")
              .setDesc("以逗号分隔。当打开路径或文件名包含这些词的 Markdown 文件时，侧栏章纲自动跟随；打开设定卡等其他文件时保留上一章内容。填 * 表示匹配所有笔记")
              .addText((text) =>
                text
                  .setPlaceholder("正文草稿, 正文, 章节, 草稿, 卷, draft, chapter")
                  .setValue(this.wt.settings.draftKeywords ?? "")
                  .onChange(async (val) => {
                    this.wt.settings.draftKeywords = val.trim();
                    await this.wt.saveSettings();
                  })
              );

            new Setting(el)
              .setName("不算章节的文件名")
              .setDesc("以逗号分隔。正文目录里的这些辅助文件（如 Agent.md）不会被当成章节，也不计入字数统计与章节列表；忽略大小写，.md 后缀可省略")
              .addText((text) =>
                text
                  .setPlaceholder(DEFAULT_CHAPTER_EXCLUDE_NAMES)
                  .setValue(this.wt.settings.chapterExcludeNames ?? "")
                  .onChange(async (val) => {
                    this.wt.settings.chapterExcludeNames = val.trim();
                    await this.wt.saveSettings();
                  })
              );
          });

          this.group("存储方式", section, (el) => {
            new Setting(el)
              .setName("章纲数据存放机制")
              .setDesc("推荐使用「独立伴生文件（sidecar）」，将章纲安全隔离存放在 .wt-outlines 目录，不修改任何正文 YAML，保护正文纯净")
              .addDropdown((dd) =>
                dd
                  .addOption("sidecar", "独立伴生文件（.wt-outlines，推荐）")
                  .addOption("frontmatter", "文档头部 frontmatter（传统方式）")
                  .setValue(this.wt.settings.outlineStorageMode ?? "sidecar")
                  .onChange(async (val) => {
                    this.wt.settings.outlineStorageMode = val as any;
                    await this.wt.saveSettings();
                  })
              );
          });
        },
      },
      {
        title: "作品",
        build: (section) => {
          this.group("新建作品", section, (el) => {
            new Setting(el)
              .setName("新作品位置")
              .setDesc("「新建作品」时统一创建在这个目录下（相对仓库根目录）")
              .addText((text) =>
                text
                  .setPlaceholder(DEFAULT_SETTINGS.newProjectFolder)
                  .setValue(this.wt.settings.newProjectFolder ?? "")
                  .onChange(async (val) => {
                    this.wt.settings.newProjectFolder =
                      val.trim() || DEFAULT_SETTINGS.newProjectFolder;
                    await this.wt.saveSettings();
                  })
              );
          });
          this.group("资料库", section, (el) => {
            new Setting(el)
              .setName("共用资料库位置")
              .setDesc("工作台「资料库」页展示的共用资料目录（相对仓库根目录）")
              .addText((text) =>
                text
                  .setPlaceholder(DEFAULT_SETTINGS.sharedLibraryFolder)
                  .setValue(this.wt.settings.sharedLibraryFolder ?? "")
                  .onChange(async (val) => {
                    this.wt.settings.sharedLibraryFolder =
                      val.trim() || DEFAULT_SETTINGS.sharedLibraryFolder;
                    await this.wt.saveSettings();
                  })
              );
          });
        },
      },
    ];

    sections.forEach((section, index) => {
      const tab = tabs.createEl("button", {
        cls: "wt-settings-tab",
        text: section.title,
      });
      tab.setAttr("type", "button");
      tab.addEventListener("click", () => this.activateTab(index));
      this.tabEls.push(tab);

      const panel = panels.createDiv({ cls: "wt-settings-panel" });
      this.panelEls.push(panel);
      section.build(panel);
    });

    this.activateTab(Math.min(this.activeTabIndex, sections.length - 1));
  }

  private activateTab(index: number): void {
    this.activeTabIndex = index;
    this.tabEls.forEach((tab, i) => tab.toggleClass("is-active", i === index));
    this.panelEls.forEach((panel, i) => panel.toggleClass("is-active", i === index));
  }
}

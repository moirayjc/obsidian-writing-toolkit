import type { WordCountMode } from "./wordcount";
import {
  DEFAULT_SNAPSHOT_SETTINGS,
  type SnapshotSettings,
} from "./snapshot";
import { DEFAULT_CHAPTER_EXCLUDE_NAMES } from "./outlineText";

export type DailyDisplayMode = "words" | "duration";

/** 配色主题：warm 暖纸（默认）/ cool 极简冷淡 / contrast 高对比度 */
export type ThemeTone = "warm" | "cool" | "contrast";

/** 编辑工具条的生效范围：全库 / 全库排除正文 / 仅自己作品与共用资料库 */
export type FormatToolbarScope =
  | "all"
  | "all-except-chapters"
  | "library-only";

export interface WritingToolkitSettings extends SnapshotSettings {
  themeTone: ThemeTone;
  lineHeight: number;
  paragraphSpacing: number;
  letterPaperMode: boolean;
  paragraphIndent: boolean;
  /** 标题样式：层级只靠字号/字重/间距，不用颜色（参照 Claude Design System） */
  headingStyle: boolean;
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
  /** 在手机和平板上也提供批注（批注页、工具条按钮、长按入口、正文痕迹） */
  commentsOnMobile: boolean;
  /**
   * 伴随数据（批注 / 快照 / 章纲）存放位置：hidden = `.wt-*` 隐藏目录；
   * visible = 库根 `_写作工具箱/`（Obsidian 官方同步不同步隐藏目录，用它的要选这个）。
   * 改它必须走插件的切换流程（会整体搬数据），不要直接赋值。
   */
  sidecarLocation: "hidden" | "visible";
  /** 「检测到可同步目录里已有数据，要切换吗？」点过「不再提示」 */
  sidecarLocationPromptDismissed: boolean;
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
  /** 写作计划看板文件（仓库相对路径）；空 = 「写作」文件夹根目录（共用资料库的上一级）的 写作看板.md */
  planBoardFile: string;
}

export const DEFAULT_SETTINGS: WritingToolkitSettings = {
  ...DEFAULT_SNAPSHOT_SETTINGS,
  themeTone: "warm",
  lineHeight: 1.8,
  paragraphSpacing: 0.5,
  letterPaperMode: true,
  paragraphIndent: true,
  headingStyle: true,
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
  commentsOnMobile: true,
  sidecarLocation: "hidden",
  sidecarLocationPromptDismissed: false,
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
  planBoardFile: "",
};

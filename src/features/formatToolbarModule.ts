import type { EditorView } from "@codemirror/view";
import type { FeatureModule } from "../host/pluginHost";
import { isInternalPath } from "../project";
import type { ProjectService } from "../services/projectIndexService";
import type {
  SettingsKey,
  SettingsService,
} from "../services/settingsService";
import { buildFormatToolbar } from "../formatToolbar";

const REFRESH_KEYS = [
  "formatToolbarEnabled",
  "formatToolbarScope",
] as const satisfies readonly SettingsKey[];

const REFRESH_KEY_SET = new Set<SettingsKey>(REFRESH_KEYS);

export interface FormatToolbarModuleOptions {
  onAddComment(view: EditorView): void;
}

/**
 * 编辑工具条的完整模块边界。
 *
 * 模块负责开关、生效范围、设置热更新与扩展注册。批注按钮的点击处理仍由
 * 未迁移的批注功能通过回调提供，避免格式工具条反向拥有批注业务。
 */
export interface FormatToolbarModule extends FeatureModule {
  isEnabled(): boolean;
  allowsPath(path: string | null): boolean;
}

export function createFormatToolbarModule(
  options: FormatToolbarModuleOptions
): FormatToolbarModule {
  let active = false;
  let settings: SettingsService | null = null;
  let project: ProjectService | null = null;
  let lastRefreshSignature = "";

  function refreshSignature(service: SettingsService): string {
    const current = service.get();
    return `${current.formatToolbarEnabled}|${current.formatToolbarScope}`;
  }

  return {
    id: "editor.format-toolbar",
    activate(context) {
      settings = context.services.settings;
      project = context.services.project;
      active = true;
      lastRefreshSignature = refreshSignature(settings);

      context.effects.add(() => {
        active = false;
        settings = null;
        project = null;
        lastRefreshSignature = "";
      });
      context.effects.add(
        settings.subscribe((change) => {
          if (
            !active ||
            !settings ||
            !change.keys.some((key) => REFRESH_KEY_SET.has(key))
          ) {
            return;
          }
          const signature = refreshSignature(settings);
          if (signature === lastRefreshSignature) return;
          lastRefreshSignature = signature;
          context.services.editor.refresh();
        })
      );

      context.registrations.registerEditorExtension(
        buildFormatToolbar({
          isEnabled: () => active && settings?.get().formatToolbarEnabled === true,
          allowsPath: (path) => this.allowsPath(path),
          commentsEnabled: () => settings?.get().commentsEnabled === true,
          commentBubbleEverywhere: () =>
            settings?.get().commentBubbleEverywhere === true,
          onAddComment: options.onAddComment,
          isWriteBlocked: (path) =>
            context.services.editor.writeBlockReason(path) !== null,
        })
      );
    },
    isEnabled() {
      return active && settings?.get().formatToolbarEnabled === true;
    },
    allowsPath(path) {
      if (!active || !settings || !project) return false;
      const current = settings.get();
      if (current.formatToolbarScope === "all") return true;
      if (!path || isInternalPath(path)) {
        return current.formatToolbarScope !== "library-only";
      }
      if (current.formatToolbarScope === "library-only") {
        if (project.projectRootForPath(path)) return true;
        const library = current.sharedLibraryFolder.replace(/\/+$/, "");
        return library !== "" && path.startsWith(library + "/");
      }
      return !project.chapterPaths().has(path);
    },
  };
}

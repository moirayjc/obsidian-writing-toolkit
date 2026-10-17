import type { FeatureModule } from "../host/pluginHost";
import type { EditorService } from "../services/editorService";
import { buildHemingwayExtensions, setHemingway } from "../hemingway";

/**
 * 海明威模式的完整模块边界。
 *
 * 模块自己读取并订阅 hemingwayMode、注册一次编辑器扩展，并在开关变化或
 * Host 回收 EffectScope 时向所有 Markdown 编辑器同步状态。main.ts 的旧
 * 方法只保留为 UI 迁移期的兼容桥。
 */
export interface HemingwayModule extends FeatureModule {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

export function createHemingwayModule(): HemingwayModule {
  let active = false;
  let enabled = false;
  let editorService: EditorService | null = null;

  function applyEnabled(next: boolean): boolean {
    if (enabled === next) return false;
    enabled = next;
    return true;
  }

  function syncExistingEditors(next: boolean): void {
    if (!editorService) return;
    for (const view of editorService.getMarkdownEditorViews()) {
      view.dispatch({ effects: setHemingway.of(next) });
    }
  }

  return {
    id: "editor.hemingway",
    activate(context) {
      enabled = context.services.settings.get().hemingwayMode;
      editorService = context.services.editor;
      active = true;

      context.effects.add(() => {
        active = false;
        enabled = false;
        syncExistingEditors(false);
        editorService = null;
      });
      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (
            !active ||
            !change.keys.includes("hemingwayMode") ||
            !applyEnabled(change.current.hemingwayMode)
          ) {
            return;
          }
          syncExistingEditors(enabled);
        })
      );
      context.registrations.registerEditorExtension(
        buildHemingwayExtensions(() => active && enabled)
      );
      context.services.editor.refresh();
      syncExistingEditors(enabled);
    },
    setEnabled(next) {
      if (!active || !applyEnabled(next)) return;
      syncExistingEditors(enabled);
    },
    isEnabled() {
      return active && enabled;
    },
  };
}

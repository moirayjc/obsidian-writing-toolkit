import type { FeatureModule } from "../host/pluginHost";
import {
  buildTypewriterExtensions,
  DEFAULT_TYPEWRITER_OFFSET,
  normalizeTypewriterOffset,
} from "../typewriter";

/**
 * 打字机、光标位置与当前段落高亮的完整模块边界。
 *
 * 模块自己读取并订阅三项设置、注册一次编辑器扩展，并在 Host 回收
 * EffectScope 时关闭状态、刷新现有编辑器。main.ts 的旧方法只保留为 UI
 * 迁移期的兼容桥。
 */
export interface TypewriterModule extends FeatureModule {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
  setOffset(offset: number): void;
  getOffset(): number;
  setParagraphHighlight(enabled: boolean): void;
  isParagraphHighlightEnabled(): boolean;
}

export function createTypewriterModule(): TypewriterModule {
  let active = false;
  let enabled = false;
  let offset = DEFAULT_TYPEWRITER_OFFSET;
  let paragraphHighlight = true;
  let refreshEditor: (() => void) | null = null;

  function refreshIfChanged(changed: boolean): void {
    if (changed && active) refreshEditor?.();
  }

  function applyEnabled(next: boolean): boolean {
    if (enabled === next) return false;
    enabled = next;
    return true;
  }

  function applyOffset(next: number): boolean {
    const normalized = normalizeTypewriterOffset(next);
    if (offset === normalized) return false;
    offset = normalized;
    return true;
  }

  function applyParagraphHighlight(next: boolean): boolean {
    if (paragraphHighlight === next) return false;
    paragraphHighlight = next;
    return true;
  }

  return {
    id: "editor.typewriter",
    activate(context) {
      const settings = context.services.settings.get();
      enabled = settings.typewriterMode;
      offset = normalizeTypewriterOffset(settings.typewriterOffset);
      paragraphHighlight = settings.immersiveParagraphHighlight;
      refreshEditor = () => context.services.editor.refresh();
      active = true;

      context.effects.add(() => {
        active = false;
        enabled = false;
        paragraphHighlight = false;
        refreshEditor?.();
        refreshEditor = null;
      });
      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (!active) return;
          let changed = false;
          if (change.keys.includes("typewriterMode")) {
            changed = applyEnabled(change.current.typewriterMode) || changed;
          }
          if (change.keys.includes("typewriterOffset")) {
            changed =
              applyOffset(change.current.typewriterOffset) || changed;
          }
          if (change.keys.includes("immersiveParagraphHighlight")) {
            changed =
              applyParagraphHighlight(
                change.current.immersiveParagraphHighlight
              ) || changed;
          }
          refreshIfChanged(changed);
        })
      );
      context.registrations.registerEditorExtension(
        buildTypewriterExtensions({
          isActive: () => active && enabled,
          getOffset: () => offset,
          isParagraphHighlightActive: () => active && paragraphHighlight,
        })
      );
    },
    setEnabled(next) {
      refreshIfChanged(active && applyEnabled(next));
    },
    isEnabled() {
      return active && enabled;
    },
    setOffset(next) {
      refreshIfChanged(active && applyOffset(next));
    },
    getOffset() {
      return active ? offset : DEFAULT_TYPEWRITER_OFFSET;
    },
    setParagraphHighlight(next) {
      refreshIfChanged(active && applyParagraphHighlight(next));
    },
    isParagraphHighlightEnabled() {
      return active && paragraphHighlight;
    },
  };
}

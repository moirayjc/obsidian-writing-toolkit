import type { FeatureModule } from "../host/pluginHost";
import { buildPunctuationExtensions } from "../punctuation";

/**
 * 中文标点辅助的完整模块边界。
 *
 * 模块自己读取并订阅 punctuationAssist 设置、注册编辑器扩展，并在 Host
 * 回收 EffectScope 时关闭状态。main.ts 的旧方法只保留为 UI 迁移期的兼容桥。
 */
export interface PunctuationModule extends FeatureModule {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

export function createPunctuationModule(): PunctuationModule {
  let enabled = true;
  let active = false;

  return {
    id: "editor.punctuation",
    activate(context) {
      enabled = context.services.settings.get().punctuationAssist;
      active = true;
      context.effects.add(() => {
        active = false;
        enabled = false;
      });
      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (change.keys.includes("punctuationAssist")) {
            enabled = change.current.punctuationAssist;
          }
        })
      );
      context.registrations.registerEditorExtension(
        buildPunctuationExtensions(() => active && enabled)
      );
    },
    setEnabled(next) {
      if (active) enabled = next;
    },
    isEnabled() {
      return active && enabled;
    },
  };
}

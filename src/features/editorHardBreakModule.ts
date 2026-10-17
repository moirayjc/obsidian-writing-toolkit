import type { FeatureModule } from "../host/pluginHost";
import { buildHardBreakExtensions } from "../hardBreak";

/**
 * 回车硬换行的完整模块边界。
 *
 * 模块自己读取并订阅 hardBreakOnEnter 设置、注册编辑器扩展，并在 Host
 * 回收 EffectScope 时关闭状态。main.ts 的旧方法只保留为 UI 迁移期的兼容桥。
 */
export interface HardBreakModule extends FeatureModule {
  setEnabled(enabled: boolean): void;
  isEnabled(): boolean;
}

export function createHardBreakModule(): HardBreakModule {
  let enabled = true;
  let active = false;

  return {
    id: "editor.hard-break",
    activate(context) {
      enabled = context.services.settings.get().hardBreakOnEnter;
      active = true;
      context.effects.add(() => {
        active = false;
        enabled = false;
      });
      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (change.keys.includes("hardBreakOnEnter")) {
            enabled = change.current.hardBreakOnEnter;
          }
        })
      );
      context.registrations.registerEditorExtension(
        buildHardBreakExtensions(() => active && enabled)
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

import type { App } from "obsidian";
import type { FeatureModule } from "../host/pluginHost";
import type {
  SettingsKey,
  SettingsService,
} from "../services/settingsService";
import {
  applyCachedThemeTone,
  injectTypography,
  removeTypography,
} from "../typography";
import { syncThemeSnippet } from "../themeSnippet";

const TYPOGRAPHY_KEYS = [
  "themeTone",
  "lineHeight",
  "paragraphSpacing",
  "letterPaperMode",
  "paragraphIndent",
  "headingStyle",
] as const satisfies readonly SettingsKey[];

const TYPOGRAPHY_KEY_SET = new Set<SettingsKey>(TYPOGRAPHY_KEYS);

/**
 * 排版与配色主题的完整模块边界。
 *
 * 启动前的缓存主题预热仍由 main.ts 同步调用；数据加载完成后，本模块负责
 * 应用实时设置、同步主题片段，并在设置变化或 Host 回收时更新/撤销 DOM。
 */
export interface TypographyModule extends FeatureModule {
  applyCachedThemeTone(): void;
}

export function createTypographyModule(): TypographyModule {
  let active = false;
  let app: App | null = null;
  let settings: SettingsService | null = null;

  function syncSnippet(): void {
    if (!app || !settings) return;
    void syncThemeSnippet(app, settings.get().themeTone);
  }

  function applyCurrent(): void {
    if (!settings) return;
    injectTypography(settings.get());
  }

  return {
    id: "appearance.typography",
    activate(context) {
      app = context.app;
      settings = context.services.settings;
      active = true;

      applyCurrent();
      syncSnippet();

      context.effects.add(() => {
        active = false;
        removeTypography();
        app = null;
        settings = null;
      });
      context.effects.add(
        settings.subscribe((change) => {
          if (
            !active ||
            !change.keys.some((key) => TYPOGRAPHY_KEY_SET.has(key))
          ) {
            return;
          }
          applyCurrent();
          if (change.keys.includes("themeTone")) syncSnippet();
        })
      );
    },
    applyCachedThemeTone() {
      applyCachedThemeTone();
    },
  };
}

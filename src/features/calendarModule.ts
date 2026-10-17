import {
  WritingCalendar,
  type CalendarDataProvider,
} from "../calendar";
import type { FeatureContext, FeatureModule } from "../host/pluginHost";
import type { CalendarHandle } from "../services/uiTypes";

export interface CalendarDataSources {
  allWords(): Record<string, number>;
  allDuration(): Record<string, number>;
  projectWords(key: string): Record<string, number>;
  projectDuration(key: string): Record<string, number>;
}

export type { CalendarHandle } from "../services/uiTypes";

export interface CalendarOperations {
  create(container: HTMLElement, initialYear?: number): CalendarHandle;
}

export interface CalendarModule extends FeatureModule {
  readonly operations: CalendarOperations;
}

type CalendarInstance = WritingCalendar;
type CalendarFactory = (
  container: HTMLElement,
  provider: CalendarDataProvider,
  initialYear?: number
) => CalendarInstance;

interface MountedCalendar {
  refresh(): void;
  destroy(): void;
}

function defaultFactory(
  container: HTMLElement,
  provider: CalendarDataProvider,
  initialYear?: number
): WritingCalendar {
  return new WritingCalendar(container, provider, initialYear);
}

/**
 * 写作日历模块：绑定统计快照、显示设置和实例生命周期。
 *
 * 日历本身没有第二套数据，渲染仍使用 `WritingCalendar`；模块只保证主页
 * 重建、设置热更新和插件卸载时不会遗留 ResizeObserver 或旧实例。
 */
export function createCalendarModule(
  sources: CalendarDataSources,
  factory: CalendarFactory = defaultFactory
): CalendarModule {
  let active = false;
  let context: FeatureContext | null = null;
  let operations: CalendarOperations | null = null;
  const mounted = new Set<MountedCalendar>();

  function requireContext(): FeatureContext {
    if (!active || !context) throw new Error("日历模块尚未激活");
    return context;
  }

  function providerFor(current: FeatureContext): CalendarDataProvider {
    return {
      history: () => sources.allWords(),
      durationHistory: () => sources.allDuration(),
      projectHistory: (key) => sources.projectWords(key),
      projectDurationHistory: (key) => sources.projectDuration(key),
      displayMode: () => current.services.settings.get().dailyDisplayMode,
      dailyGoal: () => current.services.settings.get().dailyGoal,
    };
  }

  function refreshMounted(): void {
    for (const instance of [...mounted]) {
      try {
        instance.refresh();
      } catch (error) {
        console.error("[Writing Toolkit:calendar] 刷新写作日历失败", error);
      }
    }
  }

  return {
    id: "calendar",
    activate(current) {
      active = true;
      context = current;
      operations = {
        create(container, initialYear) {
          const runtime = requireContext();
          const instance = factory(
            container,
            providerFor(runtime),
            initialYear
          );
          let destroyed = false;
          const record: MountedCalendar = {
            refresh: () => instance.refresh(),
            destroy: () => {
              if (destroyed) return;
              destroyed = true;
              mounted.delete(record);
              instance.destroy();
            },
          };
          mounted.add(record);
          return {
            getYear: () => instance.getYear(),
            setProject: (key) => instance.setProject(key),
            getProjectKey: () => instance.getProjectKey(),
            refresh: () => {
              if (!destroyed) instance.refresh();
            },
            destroy: () => record.destroy(),
          };
        },
      };

      context.effects.add(() => {
        active = false;
        for (const instance of [...mounted]) instance.destroy();
        mounted.clear();
        context = null;
        operations = null;
      });

      context.effects.add(
        context.services.settings.subscribe((change) => {
          if (
            change.keys.includes("dailyDisplayMode") ||
            change.keys.includes("dailyGoal")
          ) {
            refreshMounted();
          }
        })
      );
    },
    get operations() {
      if (!operations) throw new Error("日历模块尚未激活");
      return operations;
    },
  };
}

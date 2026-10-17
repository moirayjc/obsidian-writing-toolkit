/**
 * UI 层共享的窄类型。
 *
 * 这些类型不属于任何功能实现对 UI 的暴露，放在 Service 层避免 UI Shell 或
 * Host Context 反向 import Feature Module 的实现文件。
 */

/** 写作日历的窄句柄：只表达查询/刷新/销毁，不暴露 WritingCalendar 实现。 */
export interface CalendarHandle {
  getYear(): number;
  setProject(key: string | null): void;
  getProjectKey(): string | null;
  refresh(): void;
  destroy(): void;
}

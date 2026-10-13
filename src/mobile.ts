import { Menu, Platform } from "obsidian";

/** 手机版布局开关：真机（Obsidian 手机端）自动开启，桌面端可用命令手动预览。 */
export const MOBILE_CLASS = "wt-mobile";

/** 是否按手机版布局呈现（真机或桌面预览）。 */
export function isMobileUI(): boolean {
  return document.body.classList.contains(MOBILE_CLASS);
}

/** 当前设备是不是手机（老版本 Obsidian 没有 isPhone 时按 isMobile 兜底）。 */
export function isPhoneDevice(): boolean {
  if (typeof Platform.isPhone === "boolean") return Platform.isPhone;
  return Platform.isMobile && !Platform.isTablet;
}

/** 真机是手机时自动套用手机版布局。 */
export function applyPlatformMobileClass(): void {
  document.body.classList.toggle(MOBILE_CLASS, isPhoneDevice());
}

/** 切换桌面端的手机版布局预览，返回切换后的状态。 */
export function toggleMobilePreview(): boolean {
  const on = !document.body.classList.contains(MOBILE_CLASS);
  document.body.classList.toggle(MOBILE_CLASS, on);
  return on;
}

export interface MenuPoint {
  x: number;
  y: number;
}

/** 在指定坐标打开菜单：长按（触屏）与右键（桌面）共用。 */
export function showMenuAt(menu: Menu, pt: MenuPoint): void {
  menu.showAtPosition({ x: pt.x, y: pt.y });
}

// 长按出菜单后，抑制紧随其后的 click，避免「长按打开菜单又顺手打开了文件」。
let suppressClickWithin: HTMLElement | null = null;

/**
 * 全局 click 拦截器。必须由插件通过 registerDomEvent 注册，
 * 这样插件禁用/重载时会自动移除，不会留下旧的监听器。
 */
export function handleSuppressedClick(e: MouseEvent): void {
  if (!suppressClickWithin) return;
  const target = e.target as Node | null;
  if (target && suppressClickWithin.contains(target)) {
    e.preventDefault();
    e.stopPropagation();
  }
  suppressClickWithin = null;
}

/** 长按（触屏）触发回调；用于把桌面右键菜单搬到手机上。 */
export function bindLongPress(
  el: HTMLElement,
  onLongPress: (pt: MenuPoint) => void,
  delay = 450
): void {
  let timer = 0;
  let startX = 0;
  let startY = 0;
  const cancel = (): void => {
    if (timer) {
      window.clearTimeout(timer);
      timer = 0;
    }
  };
  el.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length !== 1) return;
      const t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      cancel();
      timer = window.setTimeout(() => {
        timer = 0;
        suppressClickWithin = el;
        onLongPress({ x: startX, y: startY });
      }, delay);
    },
    { passive: true }
  );
  el.addEventListener(
    "touchmove",
    (e) => {
      const t = e.touches[0];
      if (!t) return;
      if (
        Math.abs(t.clientX - startX) > 10 ||
        Math.abs(t.clientY - startY) > 10
      ) {
        cancel();
      }
    },
    { passive: true }
  );
  el.addEventListener("touchend", cancel, { passive: true });
  el.addEventListener("touchcancel", cancel, { passive: true });
}

/**
 * 统一的「右键菜单」入口：桌面端用 contextmenu，手机端用长按。
 * 回调里用 showMenuAt(menu, pt) 打开菜单即可。
 */
export function bindContextMenu(
  el: HTMLElement,
  onOpen: (pt: MenuPoint) => void
): void {
  if (Platform.isMobile) {
    bindLongPress(el, onOpen);
  } else {
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      onOpen({ x: e.clientX, y: e.clientY });
    });
  }
}

/**
 * 桌面端 Electron 模块的最小类型。
 * Obsidian 会把 electron 注入插件模块的 require，但它不是标准 Node 模块，
 * 这里集中声明实际用到的接口，避免各调用点拿到 any。
 */

export interface ElectronShell {
  /** 用系统默认程序打开路径；返回错误字符串（空串表示成功）。 */
  openPath(path: string): Promise<string>;
  /** 在系统文件管理器中选中该路径。 */
  showItemInFolder(fullPath: string): void;
}

export interface ElectronClipboard {
  writeText(text: string): void;
  readText(): string;
}

interface ElectronModule {
  shell: ElectronShell;
  clipboard: ElectronClipboard;
}

declare const require: (id: string) => unknown;

/** 只在桌面端调用（移动端没有 electron）。 */
export function getElectron(): ElectronModule {
  return require("electron") as ElectronModule;
}

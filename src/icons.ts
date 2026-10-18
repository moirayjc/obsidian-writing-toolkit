/**
 * 稿纸墨线图标（v1）。
 *
 * 设计：24 网格 / 2px 墨线 / 圆端圆角，核心语义图标全部自绘；
 * 关键处用实心「落墨点」，active 时才切朱砂色（由 CSS 控制 currentColor）。
 *
 * Obsidian 的 addIcon 自定义图标统一套 viewBox="0 0 100 100"，
 * 所以这里把 24 网格按 100/24 等比放大；线宽、圆点跟着缩放，观感不变。
 * 不要在业务代码里直接写 SVG —— 统一 setIcon(el, "wt-xxx")。
 */
import { addIcon } from "obsidian";

const SCALE = 4.1666667; // 100 / 24

function icon(body: string): string {
  return (
    `<g transform="scale(${SCALE})" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
    body +
    `</g>`
  );
}

export const WT_ICONS: Record<string, string> = {
  // ---- 导航 ----
  // 书桌：稿纸 + 搁在页边的笔
  "wt-desk": icon(
    `<path d="M4.5 3.8h8.5l4.2 4.2V19a1.3 1.3 0 0 1-1.3 1.3H5.8A1.3 1.3 0 0 1 4.5 19V5.1a1.3 1.3 0 0 1 1.3-1.3z"/>` +
    `<path d="M13 3.8v4.2h4.2"/>` +
    `<path d="M7.5 11h5.8"/>` +
    `<path d="M7.5 14h3.4"/>` +
    `<path d="M15.6 19.2 20.4 14.4"/>` +
    `<circle cx="20.7" cy="14.1" r="1.15" fill="currentColor" stroke="none"/>`,
  ),
  // 书架：三本书，一本斜倚
  "wt-shelf": icon(
    `<path d="M3.2 20.6h17.6"/>` +
    `<rect x="4.6" y="8.4" width="3.4" height="12.2" rx="1"/>` +
    `<rect x="9.2" y="5.2" width="3.4" height="15.4" rx="1"/>` +
    `<path d="M14.6 20.1 16.9 6.2l3.3.8-2.1 13.1"/>`,
  ),
  // 数据统计：坐标轴 + 折线 + 落墨点
  "wt-stats": icon(
    `<path d="M4.2 4.4v15.4h15.4"/>` +
    `<path d="M7.2 15.6 10.7 11 14.1 13.4 18 8"/>` +
    `<circle cx="18" cy="8" r="1.35" fill="currentColor" stroke="none"/>`,
  ),
  // 资料库：档案盒 + 三张目录片
  "wt-archive": icon(
    `<rect x="3.4" y="9.6" width="17.2" height="10.6" rx="1.6"/>` +
    `<path d="M6.6 9.6V7.4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1v2.2"/>` +
    `<path d="M10.6 9.6V6.6a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1v3"/>` +
    `<path d="M14.6 9.6V7.4a1 1 0 0 1 1-1h2.2a1 1 0 0 1 1 1v2.2"/>` +
    `<path d="M9 14.4h6.4"/>`,
  ),
  // 工具箱：笔筒里插着两支笔
  "wt-toolbox": icon(
    `<path d="M4.8 12.6h12.4l-1.2 7.4a1.6 1.6 0 0 1-1.6 1.4H7.6a1.6 1.6 0 0 1-1.6-1.4z"/>` +
    `<path d="M5.9 16.3h10.2"/>` +
    `<path d="M7.6 12.6 6.5 6.4"/>` +
    `<path d="M12 12.6V5.2"/>` +
    `<path d="M15 12.6l1.7-4.8"/>` +
    `<circle cx="6.2" cy="5.9" r="1.1" fill="currentColor" stroke="none"/>`,
  ),
  // 编辑台：活页夹 + 三行目录
  "wt-editor": icon(
    `<rect x="5.2" y="3.6" width="13.6" height="16.8" rx="1.8"/>` +
    `<circle cx="5.2" cy="7.6" r="1.15" fill="currentColor" stroke="none"/>` +
    `<circle cx="5.2" cy="12" r="1.15" fill="currentColor" stroke="none"/>` +
    `<circle cx="5.2" cy="16.4" r="1.15" fill="currentColor" stroke="none"/>` +
    `<path d="M8.6 8h7"/>` +
    `<path d="M8.6 12h7"/>` +
    `<path d="M8.6 16h4.6"/>`,
  ),
  // 主页：窗棂格 + 一点落墨
  "wt-home": icon(
    `<rect x="4" y="4" width="16" height="16" rx="1.6"/>` +
    `<path d="M12 4v16"/>` +
    `<path d="M4 12h16"/>` +
    `<circle cx="16.6" cy="7.4" r="1.15" fill="currentColor" stroke="none"/>`,
  ),

  // ---- 今日数据 ----
  // 连续写作：笔锋形的火苗 + 余烬
  "wt-streak": icon(
    `<path d="M12.2 3.6c.7 2.5 2.6 4.2 4 6.3 1.3 1.9 1.9 3.5 1.9 5.3a6.1 6.1 0 0 1-12.2 0c0-2.4 1.2-4.5 2.6-5.8.2 1.4.7 2.4 1.6 2.9-.3-3.3.4-6.1 2.1-8.7z"/>` +
    `<circle cx="12" cy="18.1" r="1.1" fill="currentColor" stroke="none"/>`,
  ),
  // 番茄：沙漏（一个专注时段）
  "wt-pomodoro": icon(
    `<path d="M6.8 3.6h10.4"/>` +
    `<path d="M6.8 20.4h10.4"/>` +
    `<path d="M17.2 3.6v3.2c0 2.6-2.3 4.1-5.2 5.2 2.9 1.1 5.2 2.6 5.2 5.2v3.2"/>` +
    `<path d="M6.8 3.6v3.2c0 2.6 2.3 4.1 5.2 5.2-2.9 1.1-5.2 2.6-5.2 5.2v3.2"/>` +
    `<circle cx="12" cy="16.2" r="1" fill="currentColor" stroke="none"/>`,
  ),
  // 写作时长：钟面 + 实心轴点
  "wt-clock": icon(
    `<circle cx="12" cy="12" r="8"/>` +
    `<path d="M12 7.4V12l3.4 2.1"/>` +
    `<circle cx="12" cy="12" r="1.15" fill="currentColor" stroke="none"/>`,
  ),
  // 平均时速：表盘 + 指针 + 刻度
  "wt-speed": icon(
    `<path d="M3.4 17a8.6 8.6 0 0 1 17.2 0"/>` +
    `<path d="M3.4 17h17.2"/>` +
    `<path d="M12 17l4.5-5.8"/>` +
    `<circle cx="12" cy="17" r="1.2" fill="currentColor" stroke="none"/>` +
    `<path d="M6.6 13.4l1.1.9"/>` +
    `<path d="M17.4 13.4l-1.1.9"/>`,
  ),

  // ---- 资料与常用操作 ----
  // 搜索：放大镜
  "wt-search": icon(
    `<circle cx="10.6" cy="10.6" r="6.1"/>` +
    `<path d="M15.2 15.2 20.5 20.5" stroke-width="2.2"/>`,
  ),
  // 封面网格：四格
  "wt-grid": icon(
    `<rect x="4" y="4" width="6.2" height="6.2" rx="1.2"/>` +
    `<rect x="13.8" y="4" width="6.2" height="6.2" rx="1.2"/>` +
    `<rect x="4" y="13.8" width="6.2" height="6.2" rx="1.2"/>` +
    `<rect x="13.8" y="13.8" width="6.2" height="6.2" rx="1.2"/>`,
  ),
  // 列表：墨点 + 三行
  "wt-list": icon(
    `<circle cx="5.5" cy="7" r="1.15" fill="currentColor" stroke="none"/>` +
    `<circle cx="5.5" cy="12" r="1.15" fill="currentColor" stroke="none"/>` +
    `<circle cx="5.5" cy="17" r="1.15" fill="currentColor" stroke="none"/>` +
    `<path d="M9.5 7h10.5"/>` +
    `<path d="M9.5 12h7.5"/>` +
    `<path d="M9.5 17h10.5"/>`,
  ),
  // 新建：两笔十字
  "wt-plus": icon(
    `<path d="M12 5.4v13.2"/>` +
    `<path d="M5.4 12h13.2"/>`,
  ),
  // 封面图片：画框 + 山 + 朱点
  "wt-image": icon(
    `<rect x="3.4" y="4.4" width="17.2" height="15.2" rx="2"/>` +
    `<circle cx="16.4" cy="9" r="1.35" fill="currentColor" stroke="none"/>` +
    `<path d="M4.4 16.2 9 11.6l3.2 3.2 2.3-2.3 5.1 5.1"/>`,
  ),
  // 从电脑导入：托盘 + 上箭头
  "wt-upload": icon(
    `<path d="M4 15.6v3a1.5 1.5 0 0 0 1.5 1.5h13a1.5 1.5 0 0 0 1.5-1.5v-3"/>` +
    `<path d="M12 15.2V4.2"/>` +
    `<path d="M7.6 8.6 12 4.2l4.4 4.4"/>`,
  ),
  // 恢复默认：回旋箭头
  "wt-reset": icon(
    `<path d="M3.6 12a8.4 8.4 0 1 0 8.4-8.4 9.1 9.1 0 0 0-6.2 2.5L3.6 8"/>` +
    `<path d="M3.6 3.6V8h4.4"/>`,
  ),
  // 显示：眼睛 + 实心瞳
  "wt-eye": icon(
    `<path d="M2.9 12S6.3 5.9 12 5.9 21.1 12 21.1 12 17.7 18.1 12 18.1 2.9 12 2.9 12z"/>` +
    `<circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/>`,
  ),
  // 隐藏：眼睛 + 斜杠
  "wt-eye-off": icon(
    `<path d="M2.9 12S6.3 5.9 12 5.9 21.1 12 21.1 12 17.7 18.1 12 18.1 2.9 12 2.9 12z"/>` +
    `<path d="M4.2 4.2 19.8 19.8" stroke-width="2.1"/>`,
  ),
  // 文档：折角稿纸 + 两行
  "wt-doc": icon(
    `<path d="M5.8 3.6h7.9l4.1 4.1V19a1.5 1.5 0 0 1-1.5 1.5H5.8A1.5 1.5 0 0 1 4.3 19V5.1a1.5 1.5 0 0 1 1.5-1.5z"/>` +
    `<path d="M13.7 3.6v4.1h4.1"/>` +
    `<path d="M7.8 12.4h6.6"/>` +
    `<path d="M7.8 15.9h4.6"/>`,
  ),
  // 所在文件夹：打开的文件夹
  "wt-folder": icon(
    `<path d="M3.4 7.4V6a1.5 1.5 0 0 1 1.5-1.5h4.4l2 2.6h6.8A1.5 1.5 0 0 1 19.6 8.6v1"/>` +
    `<path d="M3.4 8.4h17.2l-2 10.5a1.5 1.5 0 0 1-1.5 1.2H4.9a1.5 1.5 0 0 1-1.5-1.2z"/>`,
  ),
  // 设置：三根滑杆 + 实心钮
  "wt-settings": icon(
    `<path d="M3.6 7.2h16.8"/>` +
    `<circle cx="9.3" cy="7.2" r="1.75" fill="currentColor" stroke="none"/>` +
    `<path d="M3.6 12h16.8"/>` +
    `<circle cx="15" cy="12" r="1.75" fill="currentColor" stroke="none"/>` +
    `<path d="M3.6 16.8h16.8"/>` +
    `<circle cx="7.4" cy="16.8" r="1.75" fill="currentColor" stroke="none"/>`,
  ),

  // ---- 工作台 / 面板动作 ----
  // 复制正文：两张错叠的稿纸
  "wt-copy": icon(
    `<rect x="8.6" y="3.6" width="11.4" height="13.8" rx="1.4"/>` +
    `<rect x="4" y="6.8" width="11.4" height="13.8" rx="1.4"/>`,
  ),
  // 完成：对勾
  "wt-check": icon(`<path d="M4.8 12.4 9.3 17 19.4 6.6"/>`),
  // 清除：叉
  "wt-close": icon(
    `<path d="M5.8 5.8 18.2 18.2"/>` +
    `<path d="M18.2 5.8 5.8 18.2"/>`,
  ),
  // 提示：圆 + 点 + 竖
  "wt-info": icon(
    `<circle cx="12" cy="12" r="8.4"/>` +
    `<circle cx="12" cy="8" r="1.1" fill="currentColor" stroke="none"/>` +
    `<path d="M12 11.4V17"/>`,
  ),
  // 折叠：收起
  "wt-fold": icon(
    `<path d="M5 20h14"/>` +
    `<path d="M6.5 16 12 10.6 17.5 16"/>`,
  ),
  // 展开：张开
  "wt-unfold": icon(
    `<path d="M5 4h14"/>` +
    `<path d="M6.5 8 12 13.4 17.5 8"/>`,
  ),
  // 章节重编号：列表 + 排序箭头
  "wt-list-ordered": icon(
    `<path d="M4 7h9"/>` +
    `<path d="M4 12h9"/>` +
    `<path d="M4 17h6"/>` +
    `<path d="M18 5.8v12.4"/>` +
    `<path d="M15.8 8 18 5.8 20.2 8"/>` +
    `<path d="M15.8 16 18 18.2 20.2 16"/>`,
  ),
  // 删除：带盖纸篓
  "wt-trash": icon(
    `<path d="M5.4 7.2h13.2l-1.2 11.8a1.5 1.5 0 0 1-1.5 1.3H8.1a1.5 1.5 0 0 1-1.5-1.3z"/>` +
    `<path d="M3.7 7.2h16.6"/>` +
    `<path d="M9.4 7.2V4.6h5.2v2.6"/>` +
    `<path d="M10 11.2v5.6"/>` +
    `<path d="M14 11.2v5.6"/>`,
  ),
  // 新建笔记：稿纸 + 加号
  "wt-file-plus": icon(
    `<path d="M5.5 3.6h6.6l3.9 3.9V19a1.4 1.4 0 0 1-1.4 1.4H5.5A1.4 1.4 0 0 1 4.1 19V5a1.4 1.4 0 0 1 1.4-1.4z"/>` +
    `<path d="M12.1 3.6v3.9h3.9"/>` +
    `<path d="M7.4 11h5.6"/>` +
    `<path d="M7.4 14.4h3.6"/>` +
    `<path d="M18.3 15v5.2"/>` +
    `<path d="M15.7 17.6h5.2"/>`,
  ),
  // 放大浮窗：对角展开
  "wt-expand": icon(
    `<path d="M4 9V4h5"/>` +
    `<path d="M4 4l6 6"/>` +
    `<path d="M20 15v5h-5"/>` +
    `<path d="M20 20l-6-6"/>`,
  ),
  // 编辑：斜持的笔
  "wt-pencil": icon(
    `<path d="M4.6 19.4 5.9 14.6 15.3 5.2a2.2 2.2 0 0 1 3.1 3.1L9 17.9z"/>` +
    `<path d="M13.9 6.6l3.2 3.2"/>`,
  ),
  // 写作：蘸水笔：笔杆 + 笔尖 + 落墨
  "wt-write": icon(
    `<path d="M19.4 4.6 11.6 12.4"/>` +
    `<path d="M11.6 12.4 9.2 18.2 14.9 15.8z"/>` +
    `<path d="M11.6 12.4 11.2 15"/>` +
    `<circle cx="7.4" cy="20" r="1.15" fill="currentColor" stroke="none"/>`,
  ),
  // 快照历史：带回旋箭头的钟
  "wt-history": icon(
    `<path d="M3.6 12a8.4 8.4 0 1 0 8.4-8.4 9.1 9.1 0 0 0-6.2 2.5L3.6 8"/>` +
    `<path d="M3.6 3.6V8h4.4"/>` +
    `<path d="M12 7.4V12l3.4 2.1"/>`,
  ),
  // 保存快照：书签
  "wt-save": icon(`<path d="M6.7 4.2h10.6a1.3 1.3 0 0 1 1.3 1.3v14.9l-6.6-4.4-6.6 4.4V5.5a1.3 1.3 0 0 1 1.3-1.3z"/>`),
  // 批注：带两行字的对话框
  "wt-comment": icon(
    `<path d="M4 7.2a2.6 2.6 0 0 1 2.6-2.6h10.8A2.6 2.6 0 0 1 20 7.2v6.6a2.6 2.6 0 0 1-2.6 2.6H9.7L5.2 20v-3.6A2.6 2.6 0 0 1 4 13.8z"/>` +
    `<path d="M7.6 9.4h8.8"/>` +
    `<path d="M7.6 12.5h5.4"/>`,
  ),

  // ---- 方向 ----
  // 展开：向下
  "wt-chevron-down": icon(`<path d="M6.2 9.4 12 15l5.8-5.6"/>`),
  // 收起：向上
  "wt-chevron-up": icon(`<path d="M6.2 14.6 12 9l5.8 5.6"/>`),
  // 向右：向右
  "wt-chevron-right": icon(`<path d="M9.4 6 15 12l-5.6 5.8"/>`),
  // 向左：向左
  "wt-chevron-left": icon(`<path d="M14.6 6 9 12l5.6 5.8"/>`),

  // ---- 番茄 ----
  // 开始：实心播放三角
  "wt-play": icon(`<path d="M8.3 5.4 18.9 12 8.3 18.6z" fill="currentColor" stroke="none"/>`),
  // 暂停：双竖条
  "wt-pause": icon(
    `<rect x="6.4" y="5" width="3.4" height="14" rx="1.4" fill="currentColor" stroke="none"/>` +
    `<rect x="14.2" y="5" width="3.4" height="14" rx="1.4" fill="currentColor" stroke="none"/>`,
  ),
  // 跳过休息：三角 + 竖条
  "wt-skip": icon(
    `<path d="M5.6 5.4 15.5 12 5.6 18.6z" fill="currentColor" stroke="none"/>` +
    `<path d="M18.3 5.2v13.6" stroke-width="2.4"/>`,
  ),
  // 结束：圆角方块
  "wt-stop": icon(`<rect x="6.5" y="6.5" width="11" height="11" rx="2.4" fill="currentColor" stroke="none"/>`),

  // ---- 格式工具条 ----
  // 加粗：B
  "wt-bold": icon(
    `<path d="M8 5v14"/>` +
    `<path d="M8 5h4.2a3.6 3.6 0 0 1 0 7.2H8"/>` +
    `<path d="M8 12.2h5.1a3.4 3.4 0 0 1 0 6.8H8"/>`,
  ),
  // 斜体：斜 I
  "wt-italic": icon(
    `<path d="M15.2 5 10 19"/>` +
    `<path d="M8.2 5h6"/>` +
    `<path d="M7 19h6"/>`,
  ),
  // 下划线：U + 下划线
  "wt-underline": icon(
    `<path d="M7.2 4.8v6.5a4.8 4.8 0 0 0 9.6 0V4.8"/>` +
    `<path d="M6 20h12"/>`,
  ),
  // 删除线：S + 横线
  "wt-strike": icon(
    `<path d="M17 6.3C16.2 4.9 14.8 4 12.8 4 10.3 4 8.5 5.2 8.5 7.2c0 2.2 2 3 4.2 3.4 2.5.4 4.2 1.3 4.2 3.4 0 2-1.8 3.2-4.3 3.2-2 0-3.4-.9-4.2-2.3"/>` +
    `<path d="M5 12h14"/>`,
  ),
  // 高亮：记号笔 + 粗横
  "wt-highlight": icon(
    `<path d="M8.2 15.4 15.6 8a2.1 2.1 0 0 1 3 3l-7.4 7.4z"/>` +
    `<path d="M8.2 15.4 5.6 18v-3.4"/>` +
    `<path d="M4 20.8h6" stroke-width="3.2"/>`,
  ),
  // 字色：墨滴
  "wt-color": icon(
    `<path d="M12 3.8c3.4 4.3 5.8 7.2 5.8 10.4a5.8 5.8 0 0 1-11.6 0C6.2 11 8.6 8.1 12 3.8z"/>` +
    `<circle cx="12" cy="14.2" r="1.5" fill="currentColor" stroke="none"/>`,
  ),

};

/** 注册到 Obsidian 图标库；onload 里必须在任何 setIcon / ribbon 之前调用。 */
export function registerWtIcons(): void {
  for (const [id, content] of Object.entries(WT_ICONS)) {
    addIcon(id, content);
  }
}

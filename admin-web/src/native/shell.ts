/**
 * 原生壳（Capacitor）适配层。
 *
 * 这个文件是「Web 端跑在浏览器里」和「Web 端跑在 App 里」唯一的分叉点：
 * 浏览器里所有函数都直接 return，不加载任何插件代码（动态 import 也不会触发）。
 *
 * 目前只做一件事：把系统状态栏的深浅跟着 App 主题走。
 * 不做的话，浅色主题下是对的，一旦用户切到深色，状态栏还是浅底 + 深图标，
 * 顶上会留一条亮边。
 */

type ThemeMode = 'light' | 'dark';

/** 是否跑在 Capacitor 原生壳里（浏览器里 window.Capacitor 不存在） */
function isNative(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return Boolean(cap?.isNativePlatform?.());
}

/** 状态栏底色与图标颜色跟主题走：深色主题要浅色图标，反之亦然 */
export async function syncStatusBar(mode: ThemeMode): Promise<void> {
  if (!isNative()) return;
  try {
    // 动态 import：Web 端永远不会下载这两个 chunk
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    await StatusBar.setOverlaysWebView({ overlay: false });
    await StatusBar.setBackgroundColor({ color: mode === 'dark' ? '#0a0f12' : '#f2f4f7' });
    // Style.Dark = 深色图标（配浅底）；Style.Light = 浅色图标（配深底）
    await StatusBar.setStyle({ style: mode === 'dark' ? Style.Light : Style.Dark });
  } catch {
    // 插件缺失或系统不支持时静默降级：状态栏颜色不对不影响任何业务功能
  }
}

/** 启动时调一次：按当前主题初始化状态栏 */
export function initNativeShell(): void {
  if (!isNative()) return;
  const dark = document.documentElement.classList.contains('dark');
  void syncStatusBar(dark ? 'dark' : 'light');
}

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { syncStatusBar } from '@/native/shell';

export type ThemeMode = 'light' | 'dark';

const LS_KEY = 'ui_theme';

/**
 * 主题：浅色「雾白」为默认，深色「石墨」为夜间模式。
 *
 * 真正的 class 切换在 index.html 的内联脚本里完成（首帧前），
 * 这里只负责「当前是什么」以及切换时同步 <html>、meta、localStorage。
 * 两处读同一个 localStorage key，所以刷新后不会跳。
 */
export const useThemeStore = defineStore('theme', () => {
  const mode = ref<ThemeMode>(document.documentElement.classList.contains('dark') ? 'dark' : 'light');

  function apply(next: ThemeMode) {
    mode.value = next;
    const root = document.documentElement;
    root.classList.toggle('dark', next === 'dark');
    root.style.background = next === 'dark' ? '#0a0f12' : '#f2f4f7';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', next === 'dark' ? '#0a0f12' : '#f2f4f7');
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', next);
    // App 内同步系统状态栏；浏览器里这是个空操作
    void syncStatusBar(next);
    try {
      localStorage.setItem(LS_KEY, next);
    } catch {
      // 隐私模式下写不了，只影响「记住偏好」，不影响当次使用
    }
  }

  function toggle() {
    apply(mode.value === 'dark' ? 'light' : 'dark');
  }

  return { mode, apply, toggle };
});

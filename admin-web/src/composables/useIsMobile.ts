import { onBeforeUnmount, onMounted, ref } from 'vue';

/**
 * 是否为窄屏（手机 / 竖屏平板）。
 *
 * 只用于「结构上要换一种排法」的地方，例如：
 *   · 表格右侧固定列在手机上会盖住前面的内容 → 手机上取消 fixed
 *   · 订单/商品在手机上改卡片流，桌面仍是表格
 *
 * 纯样式差异不要用它，写 CSS 媒体查询即可 —— 少一次 re-render。
 */
const QUERY = '(max-width: 900px)';

export function useIsMobile() {
  const isMobile = ref(typeof window !== 'undefined' && window.matchMedia(QUERY).matches);
  let mql: MediaQueryList | null = null;
  const onChange = (e: MediaQueryListEvent) => {
    isMobile.value = e.matches;
  };

  onMounted(() => {
    mql = window.matchMedia(QUERY);
    isMobile.value = mql.matches;
    // Safari 14 以下只支持 addListener，这里两者都兜住
    if (mql.addEventListener) mql.addEventListener('change', onChange);
    else mql.addListener(onChange);
  });

  onBeforeUnmount(() => {
    if (!mql) return;
    if (mql.removeEventListener) mql.removeEventListener('change', onChange);
    else mql.removeListener(onChange);
  });

  return { isMobile };
}

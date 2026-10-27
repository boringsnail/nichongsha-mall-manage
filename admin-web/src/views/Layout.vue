<template>
  <div class="shell">
    <!-- ───────────────── 左侧调度栏（仅桌面；手机上换底部标签栏） ───────────────── -->
    <aside class="rail">
      <div class="brand">
        <div class="brand-mark">宠</div>
        <div class="brand-text">
          <div class="brand-name">你宠啥</div>
          <div class="label">商家调度台</div>
        </div>
      </div>

      <nav class="nav">
        <template v-for="group in NAV" :key="group.title">
          <!-- 分组头只写名字：菜单项已经有 01~10 的编号，再放一组数字会看串 -->
          <div class="nav-group">
            <span class="nav-group-name">{{ group.title }}</span>
          </div>
          <router-link
            v-for="item in group.items"
            :key="item.path"
            :to="item.path"
            class="nav-item"
            :class="{ active: isActive(item.path) }"
          >
            <span class="nav-idx mono">{{ item.idx }}</span>
            <span class="nav-label">{{ item.label }}</span>
            <span v-if="badgeOf(item)" class="nav-badge mono" :class="item.tone">{{ badgeOf(item) }}</span>
          </router-link>
        </template>
      </nav>

      <div class="rail-foot">
        <div class="sys">
          <span class="dot-live" :class="{ 'dot-dead': !store.connected }" />
          <span class="mono">{{ store.connected ? '服务在线' : '连接中断' }}</span>
        </div>
        <div class="label">线上 · 微信云托管</div>
      </div>
    </aside>

    <!-- ───────────────── 右侧主区 ───────────────── -->
    <div class="stage">
      <header class="topbar">
        <div class="topbar-left">
          <span class="label topbar-ops">运营</span>
          <span class="slash">/</span>
          <span class="page-title">{{ pageTitle }}</span>
        </div>

        <div class="topbar-right">
          <!-- 声音未解锁时常驻一个入口：浏览器要求用户手势后才能出声，藏在弹层里容易被忽略 -->
          <button v-if="!store.unlocked" class="unlock-chip" type="button" @click="enableSound">
            <span class="dot-live" />
            启用声音提醒
          </button>

          <!-- 提醒中心：未读 + 开关 + 试听，一个入口管完 -->
          <el-popover placement="bottom-end" :width="300" trigger="click" popper-class="alert-pop">
            <template #reference>
              <button
                class="icon-btn"
                type="button"
                :title="store.hasUnread ? `${store.unread} 条未读提醒` : '提醒设置'"
              >
                <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
                  <path
                    d="M8 1.6a3.9 3.9 0 0 0-3.9 3.9v2.3L2.9 10.2h10.2l-1.2-2.4V5.5A3.9 3.9 0 0 0 8 1.6Zm0 12.8a1.7 1.7 0 0 0 1.7-1.7H6.3A1.7 1.7 0 0 0 8 14.4Z"
                    fill="currentColor"
                  />
                </svg>
                <span v-if="store.hasUnread" class="badge mono">{{ store.unread }}</span>
                <span v-else class="dot-idle" />
              </button>
            </template>

            <div class="pop">
              <div class="pop-head">
                <span class="label">提醒中心</span>
                <span class="mono pop-time">{{ lastCheckText }}</span>
              </div>

              <div v-if="store.items.length" class="pop-list">
                <div v-for="it in store.items" :key="it.id" class="pop-item">
                  <span class="pop-dot" :class="it.kind" />
                  <div class="pop-body">
                    <div class="pop-title">{{ it.title }}</div>
                    <div class="mono pop-no">{{ it.no }}</div>
                    <div class="mono pop-meta">{{ it.meta }}</div>
                  </div>
                </div>
              </div>
              <div v-else class="pop-empty">当前没有新的待处理</div>

              <div class="pop-row">
                <span>提示音</span>
                <el-switch :model-value="store.soundOn" size="small" @change="onSoundChange" />
              </div>
              <div class="pop-row">
                <span>语音播报</span>
                <el-switch :model-value="store.voiceOn" size="small" @change="onVoiceChange" />
              </div>
              <div class="pop-row">
                <span>桌面通知</span>
                <el-switch :model-value="store.notifyOn" size="small" @change="onNotifyChange" />
              </div>

              <div class="pop-actions">
                <el-button size="small" @click="store.preview()">试听</el-button>
                <el-button size="small" :disabled="!store.hasUnread" @click="store.clearUnread()">
                  全部已知悉
                </el-button>
              </div>
              <p class="pop-hint">
                首次需点击页面才能播放声音；<br />
                若没有声音，点一下页面任意位置即可。
              </p>
            </div>
          </el-popover>

          <span class="clock mono">{{ clock }}</span>

          <!-- 主题切换：浅色「雾白」/ 深色「石墨」，偏好记在本地 -->
          <button
            class="icon-btn"
            type="button"
            :title="theme.mode === 'dark' ? '切到浅色（雾白）' : '切到深色（石墨）'"
            @click="theme.toggle()"
          >
            <svg v-if="theme.mode === 'dark'" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <path
                d="M8 2.2a5.8 5.8 0 1 0 5.6 7.4A4.6 4.6 0 0 1 8 2.2Z"
                fill="currentColor"
              />
            </svg>
            <svg v-else viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
              <circle cx="8" cy="8" r="3.1" fill="currentColor" />
              <g stroke="currentColor" stroke-width="1.2" stroke-linecap="round">
                <path d="M8 1v1.4M8 13.6V15M1 8h1.4M13.6 8H15M3 3l1 1M12 12l1 1M13 3l-1 1M4 12l-1 1" />
              </g>
            </svg>
          </button>

          <span class="divider" />

          <el-dropdown @command="onCommand">
            <span class="user">
              <span class="user-name">{{ merchantName }}</span>
              <span class="caret">▾</span>
            </span>
            <template #dropdown>
              <el-dropdown-menu>
                <el-dropdown-item command="logout">退出登录</el-dropdown-item>
              </el-dropdown-menu>
            </template>
          </el-dropdown>
        </div>
      </header>

      <main class="main">
        <router-view />
      </main>
    </div>

    <!-- 手机底部标签栏：App 里最常用的四个动作 + 更多，比抽屉少一次点击 -->
    <nav class="tabbar">
      <router-link
        v-for="t in TABS"
        :key="t.path"
        :to="t.path"
        class="tab"
        :class="{ active: tabActive(t) }"
      >
        <span class="tab-ico">
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden="true">
            <path :d="t.icon" fill="currentColor" />
          </svg>
          <span v-if="tabBadge(t)" class="tab-badge mono">{{ tabBadge(t) }}</span>
        </span>
        <span class="tab-text">{{ t.label }}</span>
      </router-link>
    </nav>

    <AlertCenter />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { useAlertStore } from '@/stores/alerts';
import { useThemeStore } from '@/stores/theme';
import AlertCenter from '@/components/AlertCenter.vue';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const store = useAlertStore();
const theme = useThemeStore();

interface NavItem {
  idx: string;
  path: string;
  label: string;
  /** 侧栏角标数据源：待发货 / 待处理售后 */
  badge?: 'ship' | 'sale';
  tone?: 'signal' | 'amber';
}
interface NavGroup {
  title: string;
  items: NavItem[];
}

/** 导航分三组：先干活（订单/售后），再维护（商品），最后看人（客户） */
const NAV: NavGroup[] = [
  {
    title: '运营',
    items: [
      { idx: '01', path: '/dashboard', label: '营业大盘' },
      { idx: '02', path: '/orders', label: '订单管理', badge: 'ship', tone: 'signal' },
      { idx: '03', path: '/after-sales', label: '售后管理', badge: 'sale', tone: 'amber' },
    ],
  },
  {
    title: '商品',
    items: [
      { idx: '04', path: '/products', label: '商品管理' },
      { idx: '05', path: '/products/import', label: '批量导入' },
      { idx: '06', path: '/categories', label: '分类管理' },
      { idx: '07', path: '/stock', label: '库存管理' },
    ],
  },
  {
    title: '客户',
    items: [
      { idx: '08', path: '/users', label: '用户管理' },
      { idx: '09', path: '/visits', label: '用户访问' },
    ],
  },
  {
    title: '设置',
    items: [{ idx: '10', path: '/settings', label: '配置管理' }],
  },
];

const pageTitle = computed(() => (route.meta.title as string) || '');
const merchantName = computed(() => auth.merchant?.nickname || auth.merchant?.username || '');

/**
 * 手机底部标签栏。
 *
 * 为什么不用抽屉：抽屉是「网页侧边栏收起来」的做法，还要先点汉堡再点菜单，
 * 在手机上等于两次点击才到得了页面。底部标签栏是 App 的通行形态，
 * 四个最常用的动作常驻可见，其余收进「更多」。
 */
interface NavTab {
  path: string;
  label: string;
  /** 20×20 viewBox 的实心图标路径 */
  icon: string;
  badge?: 'ship' | 'sale';
}

const TABS: NavTab[] = [
  {
    path: '/dashboard',
    label: '大盘',
    icon: 'M3 16.6h14v1.5H3zM4.7 9.2h2.3v6.3H4.7zM8.9 4.4h2.3v11.1H8.9zM13.1 11.4h2.3v4.1h-2.3z',
  },
  {
    path: '/orders',
    label: '订单',
    icon: 'M6.2 2.6h7.6A1.6 1.6 0 0 1 15.4 4.2v13.2L10 14.6l-5.4 2.8V4.2a1.6 1.6 0 0 1 1.6-1.6Zm.9 3.3v1.4h5.8V5.9H7.1Zm0 3.2v1.4h4.2V9.1H7.1Z',
    badge: 'ship',
  },
  {
    path: '/products',
    label: '商品',
    icon: 'M10 2 3.2 5.5v9L10 18l6.8-3.5v-9L10 2Zm0 2.4 4.4 2.3L10 9 5.6 6.7 10 4.4Z',
  },
  {
    path: '/after-sales',
    label: '售后',
    icon: 'M10 3.2a6.8 6.8 0 0 0-6 3.6V4.4H2.5v5.2h5.2V8.1H5.6A5.3 5.3 0 0 1 10 4.7 5.3 5.3 0 0 1 15.3 10h1.5A6.8 6.8 0 0 0 10 3.2Zm0 13.6a6.8 6.8 0 0 0 6-3.6v2.4h1.5v-5.2h-5.2v1.5h2.1a5.3 5.3 0 0 1-4.4 2.4 5.3 5.3 0 0 1-5.3-5.3H3.2a6.8 6.8 0 0 0 6.8 6.8Z',
    badge: 'sale',
  },
  {
    path: '/more',
    label: '更多',
    icon: 'M3.6 3.6h5v5h-5zm7.8 0h5v5h-5zM3.6 11.4h5v5h-5zm7.8 0h5v5h-5z',
  },
];

function matchPath(path: string): boolean {
  return route.path === path || route.path.startsWith(`${path}/`);
}

/** 「更多」在其它四个都不匹配时高亮，避免底部出现「什么都没选中」的空态 */
function tabActive(t: NavTab): boolean {
  if (t.path === '/more') return !TABS.some((x) => x.path !== '/more' && matchPath(x.path));
  return matchPath(t.path);
}

function tabBadge(t: NavTab): number {
  if (t.badge === 'ship') return store.pendingShipCount;
  if (t.badge === 'sale') return store.pendingAfterSaleCount;
  return 0;
}

function isActive(path: string): boolean {
  if (path === '/products') return route.path === '/products' || route.path.startsWith('/products/');
  return route.path === path || route.path.startsWith(`${path}/`);
}

function badgeOf(item: { badge?: 'ship' | 'sale' }): number {
  if (item.badge === 'ship') return store.pendingShipCount;
  if (item.badge === 'sale') return store.pendingAfterSaleCount;
  return 0;
}

// ---- 顶部时钟：秒级刷新，给「实时调度台」一点活气 ----
const clock = ref('');
let clockTimer: number | null = null;
function tickClock() {
  clock.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

const lastCheckText = computed(() => {
  if (!store.lastCheck) return '—';
  return new Date(store.lastCheck).toLocaleTimeString('zh-CN', { hour12: false });
});

async function onNotifyChange(v: string | number | boolean) {
  const ok = await store.setNotify(!!v);
  if (!ok) ElMessage.warning('浏览器未授权桌面通知，可在地址栏左侧的站点设置里开启');
}

function onSoundChange(v: string | number | boolean) {
  store.setSound(!!v);
}

function onVoiceChange(v: string | number | boolean) {
  store.setVoice(!!v);
}

/** 顶栏的「启用声音提醒」：一次手势同时解锁音频并试播，用户能立刻确认音量 */
function enableSound() {
  store.unlockAudio();
  store.preview();
}

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    store.stop();
    auth.logout();
    router.replace('/login');
  }
}

/** 首次点击任意位置解锁音频（浏览器自动播放策略） */
function unlockOnce() {
  store.unlockAudio();
  document.removeEventListener('pointerdown', unlockOnce);
}

onMounted(() => {
  tickClock();
  clockTimer = window.setInterval(tickClock, 1000);
  store.start();
  document.addEventListener('pointerdown', unlockOnce, { once: true });
});

onBeforeUnmount(() => {
  if (clockTimer !== null) clearInterval(clockTimer);
  document.removeEventListener('pointerdown', unlockOnce);
  store.stop();
});
</script>

<style scoped>
.shell {
  display: flex;
  height: 100vh;
  background: var(--ink-900);
}

/* ───────────────────────── 左栏 ───────────────────────── */
.rail {
  width: var(--rail-w);
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--ink-880);
  border-right: 1px solid var(--line-1);
}

.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  height: var(--head-h);
  padding: 0 14px;
  border-bottom: 1px solid var(--line-1);
}
/* 品牌标记：方章 + 单字，比圆角 logo 更有工业感 */
.brand-mark {
  width: 26px;
  height: 26px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--signal-border);
  color: var(--signal);
  font-size: 13px;
  font-weight: 600;
  line-height: 1;
}
.brand-text {
  min-width: 0;
}
.brand-name {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.08em;
  color: var(--text-hi);
  line-height: 1.2;
}
.brand-text .label {
  font-size: 9px;
  letter-spacing: 0.14em;
}

.nav {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0 16px;
}
.nav-group {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 12px 14px 6px;
}
.nav-group-name {
  font-size: 11px;
  color: var(--text-mid);
  letter-spacing: 0.1em;
}

.nav-item {
  position: relative;
  display: flex;
  align-items: center;
  gap: 10px;
  height: 34px;
  padding: 0 14px 0 13px;
  color: var(--text-mid);
  text-decoration: none;
  font-size: 13px;
  transition: color var(--dur-1) var(--ease), background var(--dur-1) var(--ease);
}
/* 活跃态：左侧 2px 信号条 + 极淡横向渐变，不做整块高亮 */
.nav-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 2px;
  background: transparent;
  transition: background var(--dur-1) var(--ease);
}
.nav-item:hover {
  color: var(--text-hi);
  background: var(--hover);
}
.nav-item.active {
  color: var(--text-hi);
  background: linear-gradient(90deg, var(--signal-soft), transparent 78%);
}
.nav-item.active::before {
  background: var(--signal);
}
.nav-idx {
  font-size: 10px;
  color: var(--text-lo);
  letter-spacing: 0.04em;
  transition: color var(--dur-1) var(--ease);
}
.nav-item.active .nav-idx {
  color: var(--signal);
}
.nav-label {
  flex: 1;
}
.nav-badge {
  min-width: 18px;
  height: 16px;
  padding: 0 5px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 1;
}
.nav-badge.signal {
  color: var(--signal);
  background: var(--signal-soft);
  border: 1px solid var(--signal-border);
}
.nav-badge.amber {
  color: var(--amber);
  background: var(--amber-soft);
  border: 1px solid var(--amber-border);
}

.rail-foot {
  padding: 12px 14px;
  border-top: 1px solid var(--line-1);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.sys {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-mid);
}

/* ───────────────────────── 主区 ───────────────────────── */
.stage {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.topbar {
  height: var(--head-h);
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px 0 18px;
  border-bottom: 1px solid var(--line-1);
  background: var(--ink-900);
}
.topbar-left {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.slash {
  color: var(--line-3);
  font-family: var(--font-mono);
  font-size: 11px;
}
.page-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.06em;
  color: var(--text-hi);
  white-space: nowrap;
}

.topbar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}

.icon-btn {
  position: relative;
  width: 28px;
  height: 28px;
  display: grid;
  place-items: center;
  background: transparent;
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  color: var(--text-mid);
  cursor: pointer;
  transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease),
    background var(--dur-1) var(--ease);
}
.icon-btn:hover {
  color: var(--text-hi);
  border-color: var(--line-3);
  background: var(--ink-820);
}

/* 启用声音：低干扰的描边胶囊，解锁后自动消失 */
.unlock-chip {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 26px;
  padding: 0 10px;
  background: transparent;
  border: 1px solid var(--signal-border);
  border-radius: var(--r-pill);
  color: var(--signal);
  font-size: 11px;
  letter-spacing: 0.04em;
  cursor: pointer;
  transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.unlock-chip:hover {
  background: var(--signal-soft);
  border-color: var(--signal);
}
.badge {
  position: absolute;
  top: -5px;
  right: -5px;
  min-width: 15px;
  height: 15px;
  padding: 0 3px;
  display: grid;
  place-items: center;
  border-radius: var(--r-pill);
  background: var(--red);
  color: var(--red-ink);
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
}
.dot-idle {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--line-3);
}

.clock {
  font-size: 12px;
  letter-spacing: 0.06em;
  color: var(--text-mid);
  padding-left: 4px;
}
.divider {
  width: 1px;
  height: 16px;
  background: var(--line-2);
}
.user {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: var(--text-mid);
  font-size: 12.5px;
  outline: none;
}
.user:hover {
  color: var(--text-hi);
}
.caret {
  font-size: 10px;
  color: var(--text-lo);
}

.main {
  flex: 1;
  overflow: auto;
  padding: 18px;
  background: var(--ink-900);
}

/* ───────────────────── 提醒弹层（popover 内容） ───────────────────── */
.pop {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.pop-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.pop-time {
  font-size: 10px;
  color: var(--text-lo);
}
.pop-list {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--line-1);
}
.pop-item {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--line-1);
}
.pop-item:last-child {
  border-bottom: none;
}
.pop-dot {
  width: 5px;
  height: 5px;
  margin-top: 6px;
  flex: none;
  border-radius: 50%;
  background: var(--signal);
}
.pop-dot.after-sale {
  background: var(--amber);
}
.pop-body {
  flex: 1 1 auto;
  min-width: 0;
}
.pop-title {
  font-size: 12px;
  color: var(--text-hi);
}
/* 单号与次要信息分两行：单号等宽不折行，次要信息超长省略，避免「·」孤零零挂在行尾 */
.pop-no {
  margin-top: 3px;
  font-size: 10px;
  letter-spacing: 0.02em;
  color: var(--text-mid);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pop-meta {
  margin-top: 1px;
  font-size: 10px;
  color: var(--text-lo);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pop-empty {
  padding: 14px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-lo);
}
.pop-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--text-mid);
  padding: 2px 0;
}
.pop-actions {
  display: flex;
  gap: 6px;
}
.pop-hint {
  margin: 2px 0 0;
  font-size: 10.5px;
  line-height: 1.6;
  color: var(--text-lo);
}

/* ───────────────── 手机端：底部标签栏 ───────────────── */
/* 标签栏只在窄屏出现；桌面端保持左侧常驻侧栏 */
.tabbar {
  display: none;
}

@media (max-width: 900px) {
  /* dvh：手机浏览器地址栏收起/展开时 100vh 会跳，dvh 不会 */
  .shell {
    height: 100dvh;
  }
  /* 手机上不再有侧栏：导航全部走底部标签栏 + 「更多」页 */
  .rail {
    display: none;
  }
  .topbar {
    height: 48px;
    padding: 0 12px;
    padding-top: env(safe-area-inset-top);
    gap: 8px;
  }
  .topbar-left {
    gap: 6px;
  }
  .main {
    /* 底部要给标签栏让位，否则最后一屏内容会被挡住 */
    padding: 10px 10px calc(64px + env(safe-area-inset-bottom));
    -webkit-overflow-scrolling: touch;
  }
  /* 手机顶栏只留「标题 / 提醒 / 主题 / 头像」，前缀与时钟先让位 */
  .clock,
  .divider,
  .slash,
  .topbar-ops {
    display: none;
  }
  .topbar-right {
    gap: 6px;
  }
  .unlock-chip {
    height: 24px;
    padding: 0 8px;
    font-size: 10px;
  }
  .unlock-chip .dot-live {
    display: none;
  }
  .user-name {
    max-width: 76px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tabbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 60;
    display: flex;
    align-items: stretch;
    height: calc(56px + env(safe-area-inset-bottom));
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--ink-880);
    border-top: 1px solid var(--line-1);
    /* 顶边一道极淡的投影，滚动时和内容分得开 */
    box-shadow: 0 -6px 18px -12px rgb(0 0 0 / 0.5);
  }
  .tab {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    text-decoration: none;
    color: var(--text-lo);
    /* 44px 是手指能稳稳点中的最小高度，这里 56 更宽裕 */
    -webkit-tap-highlight-color: transparent;
    transition: color var(--dur-1) var(--ease);
  }
  .tab:active {
    background: var(--hover);
  }
  .tab.active {
    color: var(--signal);
  }
  .tab-ico {
    position: relative;
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
  }
  .tab-text {
    font-size: 10.5px;
    letter-spacing: 0.02em;
    line-height: 1;
  }
  .tab-badge {
    position: absolute;
    top: -4px;
    right: -8px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    display: grid;
    place-items: center;
    border-radius: var(--r-pill);
    background: var(--red);
    color: var(--red-ink);
    font-size: 9px;
    font-weight: 700;
    line-height: 1;
  }
}

@media (max-width: 420px) {
  .unlock-chip {
    display: none;
  }
  .page-title {
    font-size: 12.5px;
  }
  .tab-text {
    font-size: 10px;
  }
}
</style>

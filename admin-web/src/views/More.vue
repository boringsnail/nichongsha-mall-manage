<template>
  <div class="more">
    <!-- 顶部：当前登录的商家，兼作退出入口 -->
    <section class="me">
      <div class="me-mark">宠</div>
      <div class="me-body">
        <div class="me-name">{{ merchantName }}</div>
        <div class="me-sub">你宠啥 · 商家调度台</div>
      </div>
      <el-button size="small" @click="logout">退出</el-button>
    </section>

    <section v-for="g in GROUPS" :key="g.title" class="group">
      <div class="group-hd">
        <span class="group-name">{{ g.title }}</span>
      </div>
      <router-link v-for="it in g.items" :key="it.path" :to="it.path" class="row">
        <span class="row-idx mono">{{ it.idx }}</span>
        <span class="row-body">
          <span class="row-label">{{ it.label }}</span>
          <span class="row-desc">{{ it.desc }}</span>
        </span>
        <span v-if="badgeOf(it)" class="row-badge mono" :class="it.tone">{{ badgeOf(it) }}</span>
        <span class="row-arrow">›</span>
      </router-link>
    </section>

    <p class="foot">
      你宠啥商家端 v{{ version }}<br />
      <span class="foot-dim">线上 · 微信云托管 · {{ store.connected ? '服务在线' : '连接中断' }}</span>
    </p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';
import { useAlertStore } from '@/stores/alerts';

/**
 * 「更多」：手机底部标签栏装不下的功能都收在这里。
 *
 * 桌面端不需要这个页面（左侧栏一直可见），但它不会碍事 ——
 * 手机上它是「其余全部功能」的唯一入口，所以必须一个不漏。
 */
interface MoreItem {
  idx: string;
  path: string;
  label: string;
  desc: string;
  badge?: 'ship' | 'sale';
  tone?: 'signal' | 'amber';
}
interface MoreGroup {
  title: string;
  items: MoreItem[];
}

const GROUPS: MoreGroup[] = [
  {
    title: '运营',
    items: [
      { idx: '03', path: '/after-sales', label: '售后管理', desc: '退款 / 退货处理', badge: 'sale', tone: 'amber' },
      { idx: '02', path: '/orders', label: '订单管理', desc: '发货 / 配送成本', badge: 'ship', tone: 'signal' },
    ],
  },
  {
    title: '商品',
    items: [
      { idx: '04', path: '/products', label: '商品管理', desc: '上下架 / 编辑' },
      { idx: '05', path: '/products/import', label: '批量导入', desc: 'CSV 一次性录多规格' },
      { idx: '06', path: '/categories', label: '分类管理', desc: '重命名 / 排序' },
      { idx: '07', path: '/stock', label: '库存管理', desc: '按 SKU 改库存' },
    ],
  },
  {
    title: '客户',
    items: [
      { idx: '08', path: '/users', label: '用户管理', desc: '消费 / 成交单数' },
      { idx: '09', path: '/visits', label: '用户访问', desc: '浏览 / 登录 / 购物车' },
    ],
  },
  {
    title: '设置',
    items: [{ idx: '10', path: '/settings', label: '配置管理', desc: '公告 / 退款规则' }],
  },
];

const router = useRouter();
const auth = useAuthStore();
const store = useAlertStore();

const merchantName = computed(() => auth.merchant?.nickname || auth.merchant?.username || '商家');
// 版本号跟 android/app/build.gradle 的 versionName 对齐，装错包时能一眼看出来
const version = '1.0.0';

function badgeOf(it: MoreItem): number {
  if (it.badge === 'ship') return store.pendingShipCount;
  if (it.badge === 'sale') return store.pendingAfterSaleCount;
  return 0;
}

function logout() {
  store.stop();
  auth.logout();
  router.replace('/login');
}
</script>

<style scoped>
.more {
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-width: 640px;
  margin: 0 auto;
}

/* ─────────── 账号卡 ─────────── */
.me {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
}
.me-mark {
  width: 40px;
  height: 40px;
  flex: none;
  display: grid;
  place-items: center;
  border: 1px solid var(--signal-border);
  border-radius: var(--r-1);
  color: var(--signal);
  font-size: 17px;
  font-weight: 600;
}
.me-body {
  flex: 1;
  min-width: 0;
}
.me-name {
  font-size: 15px;
  color: var(--text-hi);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.me-sub {
  margin-top: 2px;
  font-size: 11px;
  color: var(--text-lo);
}

/* ─────────── 分组 ─────────── */
.group {
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
  overflow: hidden;
}
.group-hd {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--line-1);
}
.group-name {
  font-size: 12px;
  color: var(--text-mid);
  letter-spacing: 0.08em;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  /* 列表行统一 52px，手指点哪一行都不会点到隔壁 */
  min-height: 52px;
  padding: 9px 14px;
  text-decoration: none;
  border-bottom: 1px solid var(--line-1);
  transition: background var(--dur-1) var(--ease);
}
.row:last-child {
  border-bottom: none;
}
.row:active {
  background: var(--hover);
}
.row-idx {
  flex: none;
  width: 22px;
  font-size: 10.5px;
  color: var(--text-lo);
}
.row-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.row-label {
  font-size: 14px;
  color: var(--text-hi);
}
.row-desc {
  font-size: 11px;
  color: var(--text-lo);
}
.row-badge {
  flex: none;
  min-width: 18px;
  height: 17px;
  padding: 0 5px;
  display: inline-grid;
  place-items: center;
  border-radius: var(--r-pill);
  font-size: 10px;
  line-height: 1;
}
.row-badge.signal {
  color: var(--signal);
  background: var(--signal-soft);
  border: 1px solid var(--signal-border);
}
.row-badge.amber {
  color: var(--amber);
  background: var(--amber-soft);
  border: 1px solid var(--amber-border);
}
.row-arrow {
  flex: none;
  font-size: 16px;
  color: var(--line-3);
  line-height: 1;
}

.foot {
  margin: 6px 0 10px;
  text-align: center;
  font-size: 11px;
  line-height: 1.8;
  color: var(--text-lo);
}
.foot-dim {
  color: var(--text-lo);
  opacity: 0.75;
}
</style>

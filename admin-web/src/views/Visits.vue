<template>
  <div class="visits">
    <!-- 工具条：时间窗只作用于「浏览 / 登录」两条流水，购物车是实时快照 -->
    <div class="bar">
      <div class="bar-left">
        <span class="label">range</span>
        <el-radio-group v-model="days" size="small" @change="reloadAll">
          <el-radio-button :value="7">近 7 天</el-radio-button>
          <el-radio-button :value="30">近 30 天</el-radio-button>
          <el-radio-button :value="90">近 90 天</el-radio-button>
        </el-radio-group>
        <span class="scope-note">浏览 / 登录按此窗口 · 购物车为实时快照</span>
      </div>
      <div class="bar-right">
        <span class="mono stamp">数据截至 {{ updatedText }}</span>
        <el-button size="small" :loading="overviewLoading" @click="reloadAll">刷新</el-button>
      </div>
    </div>

    <!-- 仪表读数 -->
    <section class="panel kpi-panel">
      <div v-for="card in statCards" :key="card.label" class="kpi" :class="card.tone">
        <div class="label">{{ card.label }}</div>
        <div class="kpi-val">
          <span class="num">{{ card.value }}</span>
          <span class="unit">{{ card.unit }}</span>
        </div>
        <div class="kpi-sub">{{ card.sub }}</div>
      </div>
    </section>

    <!-- 明细：三个 tab 共用一块面板，切换只换表体 -->
    <section class="panel">
      <div class="panel-hd">
        <div class="tabs">
          <button
            v-for="t in TABS"
            :key="t.key"
            type="button"
            class="tab-btn"
            :class="{ active: tab === t.key }"
            @click="switchTab(t.key)"
          >
            {{ t.label }}
            <span class="mono tab-count">{{ t.count }}</span>
          </button>
        </div>
        <div class="hd-tools">
          <span v-if="filterUser" class="user-chip">
            只看 <b>{{ filterUser.label }}</b>
            <button type="button" class="chip-x" title="取消筛选" @click="clearUser">×</button>
          </span>
          <span class="label">{{ tabHint }}</span>
        </div>
      </div>

      <!-- 浏览记录 -->
      <template v-if="tab === 'views'">
        <el-table v-loading="views.loading" :data="views.rows" class="tbl" empty-text="该时间窗内还没有浏览记录">
          <el-table-column label="时间" width="176" class-name="num-cell">
            <template #default="{ row }"><span class="mono">{{ formatTime(row.createdAt) }}</span></template>
          </el-table-column>
          <el-table-column label="访客" min-width="180">
            <template #default="{ row }">
              <template v-if="row.user">
                <div>{{ row.user.nickname || '微信用户' }}</div>
                <div class="muted uid" :title="row.user.openid">{{ shortOpenid(row.user.openid) }}</div>
              </template>
              <template v-else>
                <el-tag size="small" type="info">游客</el-tag>
              </template>
            </template>
          </el-table-column>
          <el-table-column label="浏览商品" min-width="300">
            <template #default="{ row }">
              <div v-if="row.product" class="prod-cell">
                <el-image v-if="row.product.coverImage" :src="row.product.coverImage" fit="cover" class="cover" />
                <div v-else class="cover ph">无图</div>
                <div class="prod-meta">
                  <div class="prod-name" :title="row.product.name">{{ row.product.name }}</div>
                  <div class="muted">
                    ¥{{ fenToYuan(row.product.minPrice) }} 起
                    <span v-if="row.product.status === 'OFF'" class="off">· 已下架</span>
                  </div>
                </div>
              </div>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
          <!-- 会话列：同一个 sessionId 下的浏览属于同一次到访，能把游客的轨迹串起来 -->
          <el-table-column v-if="!isMobile" label="会话" width="210">
            <template #default="{ row }">
              <span class="mono muted" :title="row.sessionId || ''">{{ row.sessionId || '—' }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="96" :fixed="isMobile ? false : 'right'">
            <template #default="{ row }">
              <el-button v-if="row.user" link type="primary" @click="focusUser(row.user.id, row.user.nickname || '微信用户')">
                只看他
              </el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          class="pager"
          layout="total, prev, pager, next"
          :total="views.total"
          :page-size="views.size"
          :current-page="views.page"
          @current-change="(p: number) => turn('views', p)"
        />
      </template>

      <!-- 登录记录 -->
      <template v-else-if="tab === 'logins'">
        <el-table v-loading="logins.loading" :data="logins.rows" class="tbl" empty-text="该时间窗内还没有登录记录">
          <el-table-column label="时间" width="176" class-name="num-cell">
            <template #default="{ row }"><span class="mono">{{ formatTime(row.createdAt) }}</span></template>
          </el-table-column>
          <el-table-column label="用户" min-width="200">
            <template #default="{ row }">
              <div class="user-line">
                <span>{{ row.user?.nickname || '微信用户' }}</span>
                <el-tag v-if="row.isNewUser" size="small" type="success">新客</el-tag>
              </div>
              <div class="muted uid" :title="row.openid">{{ shortOpenid(row.openid) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="方式" width="120">
            <template #default="{ row }">
              <el-tag size="small" effect="plain">{{ viaText(row.via) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="IP" width="130" class-name="num-cell">
            <template #default="{ row }"><span class="mono muted">{{ row.ip || '—' }}</span></template>
          </el-table-column>
          <el-table-column label="设备" min-width="150">
            <template #default="{ row }">
              <span :title="row.userAgent || ''">{{ deviceText(row.userAgent) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="操作" width="96" :fixed="isMobile ? false : 'right'">
            <template #default="{ row }">
              <el-button v-if="row.user" link type="primary" @click="focusUser(row.user.id, row.user.nickname || '微信用户')">
                只看他
              </el-button>
              <span v-else class="muted">—</span>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          class="pager"
          layout="total, prev, pager, next"
          :total="logins.total"
          :page-size="logins.size"
          :current-page="logins.page"
          @current-change="(p: number) => turn('logins', p)"
        />
      </template>

      <!-- 购物车 -->
      <template v-else>
        <el-table v-loading="carts.loading" :data="carts.rows" class="tbl" empty-text="当前没有待结算的购物车">
          <el-table-column label="用户" min-width="180">
            <template #default="{ row }">
              <div>{{ row.user.nickname || '微信用户' }}</div>
              <div class="muted uid" :title="row.user.openid">{{ shortOpenid(row.user.openid) }}</div>
            </template>
          </el-table-column>
          <el-table-column label="商品" min-width="260">
            <template #default="{ row }">
              <div class="prod-cell">
                <el-image v-if="row.product.coverImage" :src="row.product.coverImage" fit="cover" class="cover" />
                <div v-else class="cover ph">无图</div>
                <div class="prod-meta">
                  <div class="prod-name" :title="row.product.name">{{ row.product.name }}</div>
                  <div class="muted">
                    {{ row.specName }}
                    <span v-if="row.product.status === 'OFF'" class="off">· 已下架</span>
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="单价" width="100" align="right" header-align="right" class-name="num-cell">
            <template #default="{ row }"><span class="mono">{{ fenToYuan(row.price) }}</span></template>
          </el-table-column>
          <el-table-column label="数量" width="80" align="right" header-align="right" class-name="num-cell">
            <template #default="{ row }"><span class="mono">{{ row.quantity }}</span></template>
          </el-table-column>
          <el-table-column label="小计" width="110" align="right" header-align="right" class-name="num-cell">
            <template #default="{ row }">
              <span class="mono sub">{{ fenToYuan(row.subtotal) }}</span>
            </template>
          </el-table-column>
          <el-table-column label="结算" width="86">
            <template #default="{ row }">
              <el-tag size="small" :type="row.checked ? 'success' : 'info'" effect="plain">
                {{ row.checked ? '已勾选' : '未勾选' }}
              </el-tag>
            </template>
          </el-table-column>
          <el-table-column label="加入时间" width="176" class-name="num-cell">
            <template #default="{ row }"><span class="mono">{{ formatTime(row.createdAt) }}</span></template>
          </el-table-column>
          <el-table-column label="操作" width="96" :fixed="isMobile ? false : 'right'">
            <template #default="{ row }">
              <el-button link type="primary" @click="focusUser(row.user.id, row.user.nickname || '微信用户')">
                只看他
              </el-button>
            </template>
          </el-table-column>
        </el-table>
        <el-pagination
          class="pager"
          layout="total, prev, pager, next"
          :total="carts.total"
          :page-size="carts.size"
          :current-page="carts.page"
          @current-change="(p: number) => turn('carts', p)"
        />
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import {
  adminCarts,
  adminLoginLogs,
  adminViewLogs,
  adminVisitOverview,
  type CartRow,
  type LoginLogRow,
  type ViewLogRow,
  type VisitOverview,
} from '@/api/visits';
import { fenToYuan } from '@/utils/money';

const { isMobile } = useIsMobile();
/* ------------------------------------------------------------ 状态 */
const days = ref(30);
const overview = ref<VisitOverview | null>(null);
const overviewLoading = ref(false);
const updatedText = ref('—');

type TabKey = 'views' | 'logins' | 'carts';
const tab = ref<TabKey>('views');

interface Pane<T> {
  rows: T[];
  total: number;
  page: number;
  size: number;
  loading: boolean;
  loaded: boolean;
}
const pane = <T,>(): Pane<T> => ({ rows: [], total: 0, page: 1, size: 20, loading: false, loaded: false });

const views = reactive(pane<ViewLogRow>());
const logins = reactive(pane<LoginLogRow>());
const carts = reactive(pane<CartRow>());

/** 点「只看他」后锁定某个用户；切 tab 也保留，方便把一个人的浏览+登录+购物车串起来看 */
const filterUser = ref<{ id: number; label: string } | null>(null);

const TABS = computed(() => [
  { key: 'views' as const, label: '浏览记录', count: views.total },
  { key: 'logins' as const, label: '登录记录', count: logins.total },
  { key: 'carts' as const, label: '购物车', count: carts.total },
]);

const tabHint = computed(() => {
  // chip 在明细面板头部，说明筛选只作用于下面的表；顶部概览始终是全店口径
  const scope = filterUser.value ? '仅该用户' : '';
  if (tab.value === 'carts') return [scope, '实时快照 · 下单后对应行会被移除'].filter(Boolean).join(' · ');
  return [scope, `近 ${days.value} 天`].filter(Boolean).join(' · ');
});

/* ------------------------------------------------------------ 概览 */
const statCards = computed(() => {
  const o = overview.value;
  const v = o?.views;
  const l = o?.logins;
  const c = o?.cart;
  const perDay = l && days.value > 0 ? (l.count / days.value).toFixed(1) : '—';
  return [
    {
      label: '商品浏览量',
      value: v ? v.pv : '—',
      unit: '次',
      sub: v ? `游客 ${v.guestViews} 次 · 占 ${v.guestRate}%` : '',
      tone: '',
    },
    {
      label: '浏览人数',
      value: v ? v.uv : '—',
      unit: '人',
      sub: v ? `涉及 ${v.productCount} 个商品` : '',
      tone: '',
    },
    {
      label: '登录次数',
      value: l ? l.count : '—',
      unit: '次',
      sub: `日均 ${perDay} 次`,
      tone: '',
    },
    {
      label: '登录人数',
      value: l ? l.users : '—',
      unit: '人',
      sub: l ? `其中新客 ${l.newUsers} 人` : '',
      tone: '',
    },
    {
      label: '购物车条目',
      value: c ? c.items : '—',
      unit: '条',
      sub: c ? `${c.users} 人还在挑 · 实时` : '',
      tone: '',
    },
    {
      label: '待结算金额',
      value: c ? fenToYuan(c.amount) : '—',
      unit: '元',
      // 加购超 24 小时没动静，基本就是弃购，用琥珀色提醒
      sub: c ? (c.stale > 0 ? `超 24h 未结算 ${c.stale} 条` : '暂无滞留') : '',
      tone: c && c.stale > 0 ? 'warn' : '',
    },
  ];
});

/* ------------------------------------------------------------ 加载 */
async function loadOverview() {
  overviewLoading.value = true;
  try {
    overview.value = await adminVisitOverview(days.value);
    updatedText.value = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    // 还没点开过的 tab 先用概览里的同口径总数占位，
    // 否则标签页上会显示「登录记录 0」，看着像没数据
    if (!views.loaded) views.total = overview.value.views.pv;
    if (!logins.loaded) logins.total = overview.value.logins.count;
    if (!carts.loaded) carts.total = overview.value.cart.items;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载概览失败');
  } finally {
    overviewLoading.value = false;
  }
}

async function loadPane(key: TabKey) {
  const p = key === 'views' ? views : key === 'logins' ? logins : carts;
  p.loading = true;
  try {
    const userId = filterUser.value?.id;
    if (key === 'views') {
      const r = await adminViewLogs({ days: days.value, userId, page: p.page, size: p.size });
      views.rows = r.list;
      views.total = r.total;
    } else if (key === 'logins') {
      const r = await adminLoginLogs({ days: days.value, userId, page: p.page, size: p.size });
      logins.rows = r.list;
      logins.total = r.total;
    } else {
      // 购物车没有时间窗：它是「此刻还没结算的东西」
      const r = await adminCarts({ userId, page: p.page, size: p.size });
      carts.rows = r.list;
      carts.total = r.total;
    }
    p.loaded = true;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    p.loading = false;
  }
}

function reloadAll() {
  for (const p of [views, logins, carts]) p.page = 1;
  loadOverview();
  loadPane(tab.value);
}

/**
 * 切 tab 一律重新拉：筛选条件（用户 / 天数）可能在别的 tab 里改过，
 * 缓存着不刷会出现「chip 写着只看某人、表里却是全店数据」的错位。
 */
function switchTab(key: TabKey) {
  tab.value = key;
  loadPane(key);
}

function turn(key: TabKey, page: number) {
  const p = key === 'views' ? views : key === 'logins' ? logins : carts;
  p.page = page;
  loadPane(key);
}

function focusUser(id: number, label: string) {
  filterUser.value = { id, label };
  for (const p of [views, logins, carts]) p.page = 1;
  loadPane(tab.value);
}

function clearUser() {
  filterUser.value = null;
  for (const p of [views, logins, carts]) p.page = 1;
  loadPane(tab.value);
}

/* ------------------------------------------------------------ 展示辅助 */
const formatTime = (t: string | null) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '—');
const shortOpenid = (o: string) => (o.length > 16 ? `${o.slice(0, 10)}…${o.slice(-4)}` : o);

const VIA_TEXT: Record<string, string> = {
  cloud: '云托管注入',
  code: 'code2Session',
  dev: '开发期 mock',
};
const viaText = (via: string | null) => (via ? (VIA_TEXT[via] ?? via) : '未知');

/** 从 UA 里抠出「微信 · iOS」这种人话，原始 UA 放 title */
function deviceText(ua: string | null): string {
  if (!ua) return '—';
  const wechat = /MicroMessenger/i.test(ua);
  const os = /iPhone|iPad|iPod/i.test(ua)
    ? 'iOS'
    : /Android/i.test(ua)
      ? 'Android'
      : /Mac OS X/i.test(ua)
        ? 'macOS'
        : /Windows/i.test(ua)
          ? 'Windows'
          : '';
  if (wechat) return os ? `微信 · ${os}` : '微信';
  if (/curl|python|node|axios|okhttp/i.test(ua)) return '接口调用';
  return os || '其他';
}

onMounted(() => {
  loadOverview();
  loadPane('views');
});
</script>

<style scoped>
.visits {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ─────────── 工具条 ─────────── */
.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.bar-left,
.bar-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.scope-note {
  font-size: 10.5px;
  letter-spacing: 0.04em;
  color: var(--text-lo);
}
.stamp {
  font-size: 10.5px;
  letter-spacing: 0.06em;
  color: var(--text-lo);
}

/* ─────────── 仪表读数 ─────────── */
.kpi-panel {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
}
.kpi {
  padding: 14px 16px 15px;
  border-right: 1px solid var(--line-1);
  min-width: 0;
}
.kpi:last-child {
  border-right: none;
}
.kpi-val {
  display: flex;
  align-items: baseline;
  gap: 5px;
  margin-top: 8px;
}
.kpi-val .num {
  font-size: 24px;
  font-weight: 500;
  line-height: 1.1;
  color: var(--text-hi);
  font-variant-numeric: tabular-nums;
}
.unit {
  font-size: 10px;
  letter-spacing: 0.08em;
  color: var(--text-lo);
}
.kpi-sub {
  margin-top: 5px;
  font-size: 10.5px;
  line-height: 1.4;
  color: var(--text-lo);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.kpi.warn .kpi-val .num {
  color: var(--amber);
}
.kpi.signal .kpi-val .num {
  color: var(--signal);
}

/* ─────────── 自绘 tab：比 el-tabs 更贴这套「调度台」的骨头 ─────────── */
.tabs {
  display: flex;
  align-items: stretch;
  gap: 2px;
  height: 100%;
}
.tab-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  font-family: var(--font-sans);
  font-size: 12px;
  color: var(--text-mid);
  cursor: pointer;
  transition:
    color var(--dur-1) var(--ease),
    border-color var(--dur-1) var(--ease);
}
.tab-btn:hover {
  color: var(--text-hi);
}
.tab-btn.active {
  color: var(--text-hi);
  border-bottom-color: var(--signal);
}
.tab-count {
  font-size: 10px;
  letter-spacing: 0.04em;
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
}
.tab-btn.active .tab-count {
  color: var(--signal);
}
.hd-tools {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.user-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 22px;
  padding: 0 6px 0 8px;
  border: 1px solid var(--signal-border);
  border-radius: var(--r-1);
  background: var(--signal-soft);
  font-size: 11px;
  color: var(--signal);
  max-width: 240px;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.user-chip b {
  font-weight: 600;
}
.chip-x {
  border: none;
  background: none;
  padding: 0 2px;
  font-size: 13px;
  line-height: 1;
  color: var(--signal);
  cursor: pointer;
  opacity: 0.75;
}
.chip-x:hover {
  opacity: 1;
}

/* ─────────── 表格 ─────────── */
.tbl :deep(.num-cell .cell) {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.prod-cell {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.cover {
  width: 34px;
  height: 34px;
  flex: none;
  border-radius: var(--r-1);
  border: 1px solid var(--line-1);
}
.cover.ph {
  display: flex;
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--line-3);
  font-size: 9px;
  letter-spacing: 0.06em;
  color: var(--text-lo);
}
.prod-meta {
  min-width: 0;
}
.prod-name {
  font-size: 12.5px;
  color: var(--text-hi);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 340px;
}
.user-line {
  display: flex;
  align-items: center;
  gap: 6px;
}
.uid {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.muted {
  color: var(--text-lo);
  font-size: 11.5px;
}
.off {
  color: var(--amber);
}
.sub {
  color: var(--text-hi);
  font-weight: 500;
}
.pager {
  margin: 14px 16px 14px;
  justify-content: flex-end;
}

@media (max-width: 1280px) {
  .kpi-panel {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .kpi:nth-child(3n) {
    border-right: none;
  }
  .kpi:nth-child(-n + 3) {
    border-bottom: 1px solid var(--line-1);
  }
}
/* 手机：六格读数 2×3，标签页横向可滑，筛选 chip 独占一行 */
@media (max-width: 900px) {
  .kpi-panel {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .kpi {
    padding: 11px 12px 12px;
    border-right: 1px solid var(--line-1);
    border-bottom: 1px solid var(--line-1);
  }
  .kpi:nth-child(2n) {
    border-right: none;
  }
  .kpi:nth-last-child(-n + 2) {
    border-bottom: none;
  }
  .kpi-val .num {
    font-size: 20px;
  }
  .tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
    max-width: 100%;
  }
  .tab-btn {
    flex: none;
    height: 38px;
    padding: 0 10px;
  }
  .hd-tools {
    flex-wrap: wrap;
  }
  .user-chip {
    max-width: 100%;
  }
  .pager {
    margin: 10px 12px;
    justify-content: center;
  }
}
</style>
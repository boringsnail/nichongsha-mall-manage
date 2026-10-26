<template>
  <div>
    <div class="cmdbar">
      <div class="cmd-left">
        <span class="label">filter</span>
        <el-select v-model="status" placeholder="全部状态" clearable style="width: 150px" @change="onStatusChange">
          <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-button type="primary" @click="onQuery">查询</el-button>
      </div>
      <div class="cmd-right">
        <!-- 自动同步：默认开，5 秒一轮，服务端对单笔订单做 30 秒节流，不会打爆微信接口 -->
        <div
          class="auto-pill"
          :class="{ off: !autoSync, warn: autoSync && !autoOk }"
          :title="autoSync ? '每 5 秒自动拉取一次微信侧最新状态' : '已暂停自动同步'"
        >
          <span class="auto-dot" />
          <span class="mono">自动同步 5s</span>
          <span v-if="lastSyncText" class="mono auto-time">{{ lastSyncText }}</span>
          <el-switch v-model="autoSync" size="small" />
        </div>
        <el-button :loading="syncing" @click="syncAll">立即全量同步</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" class="order-table" :row-class-name="rowClass">
      <el-table-column prop="orderNo" label="订单号" width="190" />
      <!-- 用户列用 min-width：宽屏时它吸收剩余宽度，操作列才会贴住右边缘，
           否则表格右侧会空出一条白带（fixed 列没有溢出可贴） -->
      <el-table-column label="用户" min-width="168">
        <template #default="{ row }">
          <div>{{ row.user.nickname || '微信用户' }}</div>
          <div class="muted uid" :title="row.user.openid">{{ row.user.openid }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额（元）" width="110" align="right" header-align="right" class-name="num-cell">
        <template #default="{ row }">{{ fenToYuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column prop="itemCount" label="件数" width="72" align="right" header-align="right" class-name="num-cell" />
      <!-- 配送成本：我们付给骑手/快递的钱，和顾客付的运费是两个方向，所以单独一列。
           没录入时显示「+ 录入」的虚线占位，商家扫一眼就知道哪几单还没算成本 -->
      <el-table-column label="配送成本" width="132" align="right" header-align="right" class-name="num-cell">
        <template #default="{ row }">
          <div v-if="editingNo === row.orderNo" class="cost-edit">
            <el-input-number
              ref="costInputRef"
              v-model="editYuan"
              :min="0"
              :max="10000"
              :precision="2"
              :step="1"
              size="small"
              placeholder="0.00"
              controls-position="right"
              :disabled="savingCost === row.orderNo"
              @keyup.enter="commitCost(row)"
              @keyup.esc="cancelEditCost"
              @blur="commitCost(row)"
            />
          </div>
          <button
            v-else-if="row.status !== 'CANCELLED'"
            type="button"
            class="cost-btn"
            :class="{ empty: !row.deliveryCost }"
            :title="row.deliveryCost ? '点击修改配送成本' : '点击录入配送成本（我们付给骑手/快递的钱）'"
            @click="startEditCost(row)"
          >
            {{ row.deliveryCost ? fenToYuan(row.deliveryCost) : '+ 录入' }}
          </button>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="状态" width="168">
        <template #default="{ row }">
          <!-- 两个标签并排：竖排会把行高从 52 撑到 61，整张表高低不齐 -->
          <div class="tag-row">
            <el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
            <el-tag v-if="row.afterSaleStatus" size="small" :type="afterSaleTag(row.afterSaleStatus)">
              {{ afterSaleText(row.afterSaleStatus) }}
            </el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="170" class-name="num-cell">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="200" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.orderNo)">详情</el-button>
          <el-button v-if="row.status === 'PAID'" link type="success" @click="openShip(row.orderNo)">发货</el-button>
          <el-button v-if="row.status === 'PAID' || row.status === 'SHIPPED'" link type="warning" @click="syncOne(row.orderNo)">
            同步
          </el-button>
          <el-button v-if="row.afterSaleStatus" link type="danger" @click="openAfterSale(row.orderNo)">
            售后
          </el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      class="pager"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="size"
      :current-page="page"
      @current-change="onPage"
    />

    <!-- 详情弹窗 -->
    <el-dialog v-model="detailVisible" title="订单详情" width="640px">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="2" border size="small" label-width="88">
          <el-descriptions-item label="订单号">{{ detail.orderNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
          <el-descriptions-item label="用户">{{ detail.user.nickname || detail.user.openid }}</el-descriptions-item>
          <el-descriptions-item label="总金额">{{ fenToYuan(detail.totalAmount) }} 元</el-descriptions-item>
          <!-- 营收三件套：顾客付的运费是收入侧（已含在总金额里），配送成本是成本侧，退款要扣掉 -->
          <el-descriptions-item label="运费收入">{{ fenToYuan(detail.freight) }} 元</el-descriptions-item>
          <el-descriptions-item label="配送成本">
            <span v-if="detail.deliveryCost">{{ fenToYuan(detail.deliveryCost) }} 元</span>
            <span v-else class="muted">未录入</span>
          </el-descriptions-item>
          <el-descriptions-item label="已退款">{{ fenToYuan(detail.refundedAmount) }} 元</el-descriptions-item>
          <el-descriptions-item label="本单净额">
            <span class="net-amt">{{ fenToYuan(netOf(detail)) }} 元</span>
          </el-descriptions-item>
          <el-descriptions-item label="收货人">{{ detail.address.receiverName }} {{ detail.address.phone }}</el-descriptions-item>
          <el-descriptions-item label="收货地址">{{ detail.address.province }}{{ detail.address.city }}{{ detail.address.district }}{{ detail.address.detail }}</el-descriptions-item>
          <el-descriptions-item label="发货方式" :span="2">
            <template v-if="!detail.shippedAt">未发货</template>
            <template v-else>
              <el-tag size="small" effect="plain">{{ logisticsTypeText(detail.logisticsType) }}</el-tag>
              <span v-if="detail.logisticsType === 1 && detail.trackingNo" class="logi-text">
                {{ detail.logisticsCompany }} / {{ detail.trackingNo }}
              </span>
              <span v-else-if="detail.trackingNo" class="logi-text">单号：{{ detail.trackingNo }}</span>
              <span v-else class="muted logi-text">无快递单号</span>
            </template>
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.remark" label="备注" :span="2">{{ detail.remark }}</el-descriptions-item>
        </el-descriptions>
        <div class="net-hint">
          运费收入已含在总金额里；本单净额 = 总金额 {{ fenToYuan(detail.totalAmount) }} − 退款
          {{ fenToYuan(detail.refundedAmount) }} − 配送成本 {{ fenToYuan(detail.deliveryCost) }}
          <template v-if="!detail.deliveryCost">（未录入配送成本，录入后会同步到营业大盘）</template>
        </div>
        <el-table :data="detail.items" border size="small" class="item-table">
          <el-table-column label="商品">
            <template #default="{ row }">
              <div class="prod-cell">
                <!-- 没封面时 el-image 会渲染「加载失败」把 38px 的框撑破 -->
                <el-image v-if="row.coverImage" :src="row.coverImage" fit="cover" class="cover" />
                <div v-else class="cover ph">无图</div>
                <div>
                  <div>{{ row.productName }}</div>
                  <div class="muted">{{ row.specName }}</div>
                </div>
              </div>
            </template>
          </el-table-column>
          <el-table-column label="单价" width="90">
            <template #default="{ row }">{{ fenToYuan(row.price) }}</template>
          </el-table-column>
          <el-table-column prop="quantity" label="数量" width="70" />
        </el-table>
      </div>
    </el-dialog>

    <!-- 发货弹窗 -->
    <el-dialog v-model="shipVisible" title="订单发货" width="480px">
      <el-form :model="shipForm" label-width="90px">
        <el-form-item label="发货方式" required>
          <el-radio-group v-model="shipForm.logisticsType">
            <el-radio-button :value="1">快递发货</el-radio-button>
            <el-radio-button :value="2">同城配送</el-radio-button>
            <el-radio-button :value="4">用户自提</el-radio-button>
          </el-radio-group>
        </el-form-item>

        <!-- 快递：物流公司 + 单号都必填 -->
        <template v-if="shipForm.logisticsType === 1">
          <el-form-item label="物流公司" required>
            <el-input v-model="shipForm.logisticsCompany" placeholder="如：顺丰速运" />
          </el-form-item>
          <el-form-item label="物流单号" required>
            <el-input v-model="shipForm.trackingNo" placeholder="如：SF1234567890" />
          </el-form-item>
        </template>

        <!-- 同城配送：没有快递单号，单号选填（跑腿/骑手单号） -->
        <template v-else-if="shipForm.logisticsType === 2">
          <el-form-item label="配送单号">
            <el-input v-model="shipForm.trackingNo" placeholder="选填，如跑腿/骑手单号" />
          </el-form-item>
          <el-alert
            class="ship-tip"
            type="info"
            :closable="false"
            show-icon
            title="同城配送无需快递单号，发货后用户会收到配送通知"
          />
        </template>

        <!-- 用户自提：没有快递单号，可填提货码 -->
        <template v-else>
          <el-form-item label="提货码">
            <el-input v-model="shipForm.trackingNo" placeholder="选填，用户凭此码到店自提" />
          </el-form-item>
          <el-alert
            class="ship-tip"
            type="info"
            :closable="false"
            show-icon
            title="用户自提无需快递单号，请把提货码与提货门店告知用户"
          />
        </template>
      </el-form>
      <template #footer>
        <el-button @click="shipVisible = false">取消</el-button>
        <el-button type="primary" :loading="shipping" @click="submitShip">确认发货</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  adminListOrders,
  adminGetOrder,
  adminShipOrder,
  adminSetDeliveryCost,
  adminSyncOrderFromWechat,
  adminSyncOrdersFromWechat,
  LOGISTICS_TYPE,
  type AdminOrderDetail,
  type AdminOrderRow,
  type OrderStatus,
} from '@/api/orders';
import { fenToYuan, yuanToFen } from '@/utils/money';

const statusOptions: { label: string; value: OrderStatus }[] = [
  { label: '待支付', value: 'PENDING_PAYMENT' },
  { label: '已支付', value: 'PAID' },
  { label: '已发货', value: 'SHIPPED' },
  { label: '已完成', value: 'COMPLETED' },
  { label: '已取消', value: 'CANCELLED' },
];

const statusText = (s: OrderStatus) => statusOptions.find((o) => o.value === s)?.label || s;

/** 发货方式文案（1 快递 / 2 同城配送 / 3 虚拟商品 / 4 用户自提） */
const LOGISTICS_TYPE_TEXT: Record<number, string> = {
  1: '快递发货',
  2: '同城配送',
  3: '虚拟商品',
  4: '用户自提',
};
const logisticsTypeText = (t: number | null | undefined) => LOGISTICS_TYPE_TEXT[t ?? 1] ?? '快递发货';

/** 微信侧 order_state 文案（1待发货 2已发货 3确认收货 4交易完成 5已退款 6已关闭） */
const WX_STATE_TEXT: Record<number, string> = {
  1: '待发货',
  2: '已发货',
  3: '已确认收货',
  4: '交易完成',
  5: '已退款',
  6: '已关闭',
};
const wxStateText = (state: number | null) =>
  state === null ? '未知状态' : (WX_STATE_TEXT[state] ?? `状态 ${state}`);

type TagType = 'success' | 'warning' | 'info' | 'primary' | 'danger';
const STATUS_TAG: Record<OrderStatus, TagType> = {
  PENDING_PAYMENT: 'warning',
  PAID: 'primary',
  SHIPPED: 'success',
  COMPLETED: 'info',
  CANCELLED: 'danger',
};
const statusTag = (s: OrderStatus): TagType => STATUS_TAG[s];

/** 售后角标：一眼看出这单有售后、到哪一步了 */
const AFTER_SALE_TEXT: Record<string, string> = {
  PENDING: '售后待处理',
  AGREED: '售后已同意',
  WAIT_RETURN: '待买家退货',
  RETURNING: '退货中',
  REFUNDING: '退款中',
  COMPLETED: '已退款',
  REJECTED: '售后被拒',
  CANCELLED: '售后已撤销',
};
const AFTER_SALE_TAG: Record<string, TagType> = {
  PENDING: 'warning',
  AGREED: 'info',
  WAIT_RETURN: 'warning',
  RETURNING: 'primary',
  REFUNDING: 'primary',
  COMPLETED: 'success',
  REJECTED: 'danger',
  CANCELLED: 'info',
};
const afterSaleText = (s: string) => AFTER_SALE_TEXT[s] ?? s;
const afterSaleTag = (s: string): TagType => AFTER_SALE_TAG[s] ?? 'info';

const formatTime = (t: string) => new Date(t).toLocaleString('zh-CN', { hour12: false });

/** 单笔净额 = 总金额 − 退款 − 配送成本，和大盘净营业额同一个口径 */
const netOf = (o: { totalAmount: number; refundedAmount: number; deliveryCost: number }) =>
  o.totalAmount - o.refundedAmount - o.deliveryCost;

const router = useRouter();
const route = useRoute();

/** 跳到售后管理页并按订单号过滤，省得商家再手输一遍 */
function openAfterSale(orderNo: string) {
  router.push({ path: '/after-sales', query: { orderNo } });
}

const loading = ref(false);
const rows = ref<AdminOrderRow[]>([]);
const status = ref<OrderStatus | ''>('');
const page = ref(1);
const size = ref(10);
const total = ref(0);

/* ------------------------------------------------------------------ 自动同步
 * 商家最怕「微信那边已经退款/已发货，后台还显示旧状态」，所以列表默认每 5 秒
 * 主动对一次账。服务端 syncFulfillmentQuietly 对单笔订单有 30 秒节流，一页 10 单
 * 折下来约 0.33 QPS，不会把微信接口打爆；同时只同步 PAID/SHIPPED 这类活跃单。
 */
const AUTO_SYNC_KEY = 'order_auto_sync';
const AUTO_SYNC_MS = 5000;

function readAutoSync(): boolean {
  try {
    return localStorage.getItem(AUTO_SYNC_KEY) !== '0';
  } catch {
    // 隐私模式下 localStorage 会抛错，默认开着即可
    return true;
  }
}

const autoSync = ref(readAutoSync());
/** 最近一次同步的时钟（优先用服务端时间，避免本机时区/时间不准） */
const lastSyncText = ref('');
/** 静默轮询失败时把指示点变琥珀色，但不弹 toast —— 网络抖一下就弹会被烦死 */
const autoOk = ref(true);
/** 刚发生状态变化的订单号，用来给整行做一次高亮 */
const flash = ref<Set<string>>(new Set());
let flashTimer: number | undefined;
let timer: number | undefined;
let ticking = false;

function clockText(iso?: string): string {
  const d = iso ? new Date(iso) : new Date();
  const t = Number.isNaN(d.getTime()) ? new Date() : d;
  return t.toLocaleTimeString('zh-CN', { hour12: false });
}

/** 对比上一轮数据，把「状态或售后状态变了」的订单挑出来闪一下 */
function markChanged(next: AdminOrderRow[]) {
  if (!rows.value.length) return;
  const prev = new Map(rows.value.map((r) => [r.orderNo, r]));
  const changed: string[] = [];
  for (const r of next) {
    const old = prev.get(r.orderNo);
    if (!old) continue;
    if (old.status !== r.status || old.afterSaleStatus !== r.afterSaleStatus) changed.push(r.orderNo);
  }
  if (!changed.length) return;
  flash.value = new Set(changed);
  window.clearTimeout(flashTimer);
  flashTimer = window.setTimeout(() => {
    flash.value = new Set();
  }, 2600);
}

/** el-table 的行 class 钩子：刚变过状态的行给 2.6 秒高亮，让商家一眼看到变化 */
function rowClass({ row }: { row: AdminOrderRow }): string {
  return flash.value.has(row.orderNo) ? 'row-flash' : '';
}

async function load(opts: { silent?: boolean; withSync?: boolean } = {}) {
  const { silent = false, withSync = false } = opts;
  if (!silent) loading.value = true;
  try {
    const data = await adminListOrders({
      page: page.value,
      size: size.value,
      status: status.value || undefined,
      ...(withSync ? { autoSync: 1 as const } : {}),
    });
    if (withSync) markChanged(data.list);
    rows.value = data.list;
    total.value = data.total;
    lastSyncText.value = clockText(data.serverTime);
    autoOk.value = true;
  } catch (e) {
    autoOk.value = false;
    if (!silent) ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    if (!silent) loading.value = false;
  }
}

/** 一轮自动同步：切到后台标签页、弹窗开着、或正在录配送成本时跳过，别和用户抢内容 */
async function tick() {
  if (!autoSync.value || ticking) return;
  if (document.hidden) return;
  if (detailVisible.value || shipVisible.value) return;
  if (editingNo.value) return;
  ticking = true;
  try {
    await load({ silent: true, withSync: true });
  } finally {
    ticking = false;
  }
}

function startTimer() {
  if (timer) return;
  timer = window.setInterval(tick, AUTO_SYNC_MS);
}
function stopTimer() {
  if (!timer) return;
  window.clearInterval(timer);
  timer = undefined;
}

watch(autoSync, (on) => {
  try {
    localStorage.setItem(AUTO_SYNC_KEY, on ? '1' : '0');
  } catch {
    /* 存不了就算了，不影响本次会话 */
  }
  if (on) {
    startTimer();
    tick(); // 刚打开就立刻对一次，不用等 5 秒
  } else {
    stopTimer();
  }
});

/** 从后台切回来时立刻补一次，避免商家看到几分钟前的旧状态 */
function onVisible() {
  if (!document.hidden && autoSync.value) tick();
}

function onStatusChange() {
  page.value = 1;
  load();
}
function onQuery() {
  load();
}

function onPage(p: number) {
  page.value = p;
  load();
}

const syncing = ref(false);

/** 批量对账：商家在微信后台录的发货、微信 T+10 自动确认收货，都要靠这里拉回来 */
async function syncAll() {
  syncing.value = true;
  try {
    const r = await adminSyncOrdersFromWechat();
    if (r.updated > 0) ElMessage.success(`已核对 ${r.checked} 笔，更新 ${r.updated} 笔`);
    else ElMessage.info(`已核对 ${r.checked} 笔，状态均为最新${r.failed ? `（${r.failed} 笔拉取失败）` : ''}`);
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步失败');
  } finally {
    syncing.value = false;
  }
}

/** 单笔对账：点一下立刻看到微信侧最新状态 */
async function syncOne(orderNo: string) {
  try {
    const r = await adminSyncOrderFromWechat(orderNo);
    if (r.changed) {
      ElMessage.success(`已同步：${statusText(r.before)} → ${statusText(r.status)}`);
    } else if (r.wxState && !r.wxState.ok) {
      // 拉取失败时把微信返回的原因直接摆出来，别让用户以为按钮坏了
      ElMessage.warning(`拉取微信状态失败：${r.wxState.error ?? '未知原因'}`);
    } else if (r.wxState) {
      ElMessage.info(
        `微信侧为「${wxStateText(r.wxState.orderState)}」，本地仍为${statusText(r.status)}`,
      );
    } else {
      ElMessage.info(`状态无变化（本地仍为${statusText(r.status)}）`);
    }
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '同步失败');
  }
}

/* ------------------------------------------------------------ 配送成本录入
 * 商家通常等快递/骑手结完账才知道这单花了多少运费，所以放在列表里就地改：
 * 点数字 → 变输入框 → 回车/失焦保存。只写 deliveryCost 一列，不动订单金额。
 */
const editingNo = ref('');
/** 编辑中的值（元）；undefined 表示还没输入 */
const editYuan = ref<number | undefined>(undefined);
/** 正在保存的订单号，用来禁用输入框防重复提交 */
const savingCost = ref('');
/** 输入框实例，点开就聚焦，省一次点击 */
const costInputRef = ref<{ focus: () => void } | null>(null);

function startEditCost(row: AdminOrderRow) {
  editingNo.value = row.orderNo;
  // 已录入过就带出来，方便微调；没录过留空，避免误以为默认 0 元
  editYuan.value = row.deliveryCost > 0 ? row.deliveryCost / 100 : undefined;
  nextTick(() => costInputRef.value?.focus());
}

function cancelEditCost() {
  editingNo.value = '';
  editYuan.value = undefined;
}

async function commitCost(row: AdminOrderRow) {
  // 回车与失焦都会触发，靠这一行把第二次调用挡掉
  if (editingNo.value !== row.orderNo || savingCost.value) return;
  const yuan = editYuan.value;
  if (yuan === undefined || yuan === null || Number.isNaN(yuan)) {
    cancelEditCost();
    return;
  }
  const fen = yuanToFen(yuan);
  if (fen === row.deliveryCost) {
    cancelEditCost();
    return;
  }
  savingCost.value = row.orderNo;
  try {
    const r = await adminSetDeliveryCost(row.orderNo, fen);
    // 就地改行数据而不是整表刷新：5 秒轮询刚好在打字时把行换掉会很难受
    row.deliveryCost = r.deliveryCost;
    ElMessage.success(`配送成本已记为 ${fenToYuan(r.deliveryCost)} 元`);
    cancelEditCost();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    savingCost.value = '';
  }
}

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<AdminOrderDetail | null>(null);

async function openDetail(orderNo: string) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await adminGetOrder(orderNo);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    detailLoading.value = false;
  }
}

const shipVisible = ref(false);
const shipping = ref(false);
const shipOrderNo = ref('');
// logisticsType 默认快递，和绝大多数订单一致；改成同城/自提时不再要求填快递单号
const shipForm = reactive({ logisticsType: 1, logisticsCompany: '', trackingNo: '' });

function openShip(orderNo: string) {
  shipOrderNo.value = orderNo;
  shipForm.logisticsType = LOGISTICS_TYPE.EXPRESS;
  shipForm.logisticsCompany = '';
  shipForm.trackingNo = '';
  shipVisible.value = true;
}

async function submitShip() {
  const isExpress = shipForm.logisticsType === LOGISTICS_TYPE.EXPRESS;
  if (isExpress && (!shipForm.logisticsCompany.trim() || !shipForm.trackingNo.trim())) {
    ElMessage.warning('快递发货需要填写物流公司与物流单号');
    return;
  }
  shipping.value = true;
  try {
    await adminShipOrder(shipOrderNo.value, {
      logisticsType: shipForm.logisticsType,
      // 非快递模式后端会把物流公司写成「同城配送」/「用户自提」，这里不传公司
      logisticsCompany: isExpress ? shipForm.logisticsCompany.trim() : undefined,
      trackingNo: shipForm.trackingNo.trim() || undefined,
    });
    shipVisible.value = false;
    ElMessage.success(`已发货（${LOGISTICS_TYPE_TEXT[shipForm.logisticsType]}）`);
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '发货失败');
  } finally {
    shipping.value = false;
  }
}

// 告警卡片的「去处理」会带 ?orderNo=xxx 跳进来，直接打开详情，省一次手动搜索
onMounted(async () => {
  await load({ withSync: true });
  const target = typeof route.query.orderNo === 'string' ? route.query.orderNo : '';
  if (target) openDetail(target);
  startTimer();
  document.addEventListener('visibilitychange', onVisible);
});

onBeforeUnmount(() => {
  stopTimer();
  window.clearTimeout(flashTimer);
  document.removeEventListener('visibilitychange', onVisible);
});
</script>

<style scoped>
.cmdbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.cmd-left,
.cmd-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
/* 自动同步指示条：形状跟按钮同高，切换开关放在最右，扫一眼就知道现在同没同步 */
.auto-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 32px;
  padding: 0 8px 0 10px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-1);
  background: var(--ink-850);
  font-size: 11px;
  letter-spacing: 0.04em;
  color: var(--text-mid);
  user-select: none;
  transition:
    border-color var(--dur-1) var(--ease),
    background-color var(--dur-1) var(--ease);
}
.auto-pill:hover {
  border-color: var(--line-3);
}
.auto-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--signal);
  box-shadow: 0 0 0 3px var(--signal-soft);
  animation: breathe 2.6s var(--ease) infinite;
  flex-shrink: 0;
}
.auto-pill.off .auto-dot {
  background: var(--text-lo);
  box-shadow: none;
  animation: none;
}
.auto-pill.off {
  color: var(--text-lo);
}
.auto-pill.warn .auto-dot {
  background: var(--amber);
  box-shadow: 0 0 0 3px var(--amber-soft);
  animation: none;
}
.auto-time {
  color: var(--text-lo);
  font-variant-numeric: tabular-nums;
}
/* 用小圆点把「周期」和「上次同步时刻」分开，挤在一起像一串数字 */
.auto-time::before {
  content: '·';
  margin-right: 5px;
  color: var(--line-3);
}

/* 状态刚变的行闪一下：底色 + 左侧信号色竖条，只染背景不动文字，
   避免整表在眼前跳；2.6s 后自己褪掉 */
.order-table :deep(.row-flash > td.el-table__cell) {
  animation: row-flash 2.4s var(--ease);
}
.order-table :deep(.row-flash > td.el-table__cell:first-child) {
  box-shadow: inset 2px 0 0 var(--signal);
}
@keyframes row-flash {
  0%,
  45% {
    background-color: var(--signal-flash);
  }
  100% {
    background-color: transparent;
  }
}

.order-table :deep(.num-cell .cell) {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}

/* 配送成本：平时是「隐形」的纯数字，hover 才浮出可点的框，表格不至于全是控件；
   没录入时用虚线占位，一眼看出哪几单还缺成本 */
.cost-btn {
  padding: 2px 6px;
  border: 1px solid transparent;
  border-radius: var(--r-1);
  background: none;
  color: var(--text-hi);
  font-family: var(--font-mono);
  font-size: 12.5px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition:
    border-color var(--dur-1) var(--ease),
    background-color var(--dur-1) var(--ease),
    color var(--dur-1) var(--ease);
}
.cost-btn:hover {
  border-color: var(--signal-border);
  background: var(--signal-soft);
  color: var(--signal);
}
.cost-btn.empty {
  border-style: dashed;
  border-color: var(--line-3);
  color: var(--text-lo);
  font-family: var(--font-sans);
  font-size: 11.5px;
}
.cost-btn.empty:hover {
  border-style: solid;
  border-color: var(--signal-border);
  color: var(--signal);
}
.cost-edit :deep(.el-input-number) {
  width: 108px;
}
.cost-edit :deep(.el-input__inner) {
  text-align: right;
  font-family: var(--font-mono);
}
.net-amt {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--signal);
  font-weight: 600;
}
/* 详情里的净额算式：把口径写死给商家看，省得反复解释 */
.net-hint {
  margin-top: 8px;
  font-size: 11.5px;
  line-height: 1.6;
  color: var(--text-lo);
}

.pager {
  margin-top: 14px;
  justify-content: flex-end;
}
.muted {
  color: var(--text-lo);
  font-size: 11.5px;
}
/* openid 有 28 位，不截断会把行高撑到三行；单行省略 + title 悬浮看全量 */
.uid {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ship-tip {
  margin-bottom: 8px;
}
.logi-text {
  margin-left: 8px;
  font-family: var(--font-mono);
}
.tag-row {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.item-table {
  margin-top: 12px;
}
.prod-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cover {
  width: 38px;
  height: 38px;
  border-radius: var(--r-1);
  flex-shrink: 0;
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

/* 动效敏感的人：呼吸灯和高亮直接关掉，状态本身仍然在更新 */
@media (prefers-reduced-motion: reduce) {
  .auto-dot {
    animation: none;
  }
  .order-table :deep(.row-flash > td.el-table__cell) {
    animation: none;
  }
}
</style>

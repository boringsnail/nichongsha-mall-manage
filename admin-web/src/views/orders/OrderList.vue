<template>
  <div>
    <div class="cmdbar">
      <div class="cmd-left">
        <span class="label">filter</span>
        <el-select v-model="status" placeholder="全部状态" clearable style="width: 150px" @change="load">
          <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
        </el-select>
        <el-button type="primary" @click="load">查询</el-button>
      </div>
      <div class="cmd-right">
        <span class="mono sync-tip">微信后台录的发货不会回调本系统，需手动拉取</span>
        <el-button :loading="syncing" @click="syncAll">同步微信状态</el-button>
      </div>
    </div>

    <el-table v-loading="loading" :data="rows" class="order-table">
      <el-table-column prop="orderNo" label="订单号" width="190" />
      <el-table-column label="用户" width="168">
        <template #default="{ row }">
          <div>{{ row.user.nickname || '微信用户' }}</div>
          <div class="muted uid" :title="row.user.openid">{{ row.user.openid }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额（元）" width="110" align="right" header-align="right" class-name="num-cell">
        <template #default="{ row }">{{ fenToYuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column prop="itemCount" label="件数" width="72" align="right" header-align="right" class-name="num-cell" />
      <el-table-column label="状态" width="160">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
          <div v-if="row.afterSaleStatus" class="as-tag">
            <el-tag size="small" :type="afterSaleTag(row.afterSaleStatus)">
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
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="订单号">{{ detail.orderNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">{{ statusText(detail.status) }}</el-descriptions-item>
          <el-descriptions-item label="用户">{{ detail.user.nickname || detail.user.openid }}</el-descriptions-item>
          <el-descriptions-item label="总金额">{{ fenToYuan(detail.totalAmount) }} 元</el-descriptions-item>
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
        <el-table :data="detail.items" border size="small" class="item-table">
          <el-table-column label="商品">
            <template #default="{ row }">
              <div class="prod-cell">
                <el-image :src="row.coverImage" fit="cover" class="cover" />
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
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import {
  adminListOrders,
  adminGetOrder,
  adminShipOrder,
  adminSyncOrderFromWechat,
  adminSyncOrdersFromWechat,
  LOGISTICS_TYPE,
  type AdminOrderDetail,
  type AdminOrderRow,
  type OrderStatus,
} from '@/api/orders';
import { fenToYuan } from '@/utils/money';

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

async function load() {
  loading.value = true;
  try {
    const data = await adminListOrders({ page: page.value, size: size.value, status: status.value || undefined });
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
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
  await load();
  const target = typeof route.query.orderNo === 'string' ? route.query.orderNo : '';
  if (target) openDetail(target);
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
.sync-tip {
  font-size: 10.5px;
  color: var(--text-lo);
  letter-spacing: 0.04em;
}

.order-table :deep(.num-cell .cell) {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
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
.as-tag {
  margin-top: 4px;
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
</style>

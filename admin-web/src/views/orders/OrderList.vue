<template>
  <div>
    <div class="toolbar">
      <el-select v-model="status" placeholder="全部状态" clearable style="width: 160px" @change="load">
        <el-option v-for="s in statusOptions" :key="s.value" :label="s.label" :value="s.value" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="orderNo" label="订单号" width="190" />
      <el-table-column label="用户" width="150">
        <template #default="{ row }">
          <div>{{ row.user.nickname || '微信用户' }}</div>
          <div class="muted">{{ row.user.openid }}</div>
        </template>
      </el-table-column>
      <el-table-column label="金额（元）" width="110">
        <template #default="{ row }">{{ fenToYuan(row.totalAmount) }}</template>
      </el-table-column>
      <el-table-column prop="itemCount" label="商品数" width="80" />
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="150" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.orderNo)">详情</el-button>
          <el-button v-if="row.status === 'PAID'" link type="success" @click="openShip(row.orderNo)">发货</el-button>
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
          <el-descriptions-item label="物流" :span="2">
            {{ detail.logisticsCompany ? `${detail.logisticsCompany} / ${detail.trackingNo}` : '未发货' }}
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
    <el-dialog v-model="shipVisible" title="订单发货" width="420px">
      <el-form :model="shipForm" label-width="80px">
        <el-form-item label="物流公司" required>
          <el-input v-model="shipForm.logisticsCompany" placeholder="如：顺丰速运" />
        </el-form-item>
        <el-form-item label="物流单号" required>
          <el-input v-model="shipForm.trackingNo" placeholder="如：SF1234567890" />
        </el-form-item>
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
import { ElMessage } from 'element-plus';
import {
  adminListOrders,
  adminGetOrder,
  adminShipOrder,
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

type TagType = 'success' | 'warning' | 'info' | 'primary' | 'danger';
const STATUS_TAG: Record<OrderStatus, TagType> = {
  PENDING_PAYMENT: 'warning',
  PAID: 'primary',
  SHIPPED: 'success',
  COMPLETED: 'info',
  CANCELLED: 'danger',
};
const statusTag = (s: OrderStatus): TagType => STATUS_TAG[s];

const formatTime = (t: string) => new Date(t).toLocaleString('zh-CN', { hour12: false });

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
const shipForm = reactive({ logisticsCompany: '', trackingNo: '' });

function openShip(orderNo: string) {
  shipOrderNo.value = orderNo;
  shipForm.logisticsCompany = '';
  shipForm.trackingNo = '';
  shipVisible.value = true;
}

async function submitShip() {
  if (!shipForm.logisticsCompany.trim() || !shipForm.trackingNo.trim()) {
    ElMessage.warning('请填写物流公司与单号');
    return;
  }
  shipping.value = true;
  try {
    await adminShipOrder(shipOrderNo.value, {
      logisticsCompany: shipForm.logisticsCompany.trim(),
      trackingNo: shipForm.trackingNo.trim(),
    });
    shipVisible.value = false;
    ElMessage.success('已发货');
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '发货失败');
  } finally {
    shipping.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 16px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.muted {
  color: #999;
  font-size: 12px;
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
  width: 40px;
  height: 40px;
  border-radius: 4px;
  flex-shrink: 0;
}
</style>

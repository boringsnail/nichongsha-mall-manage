<template>
  <div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索昵称 / 手机号 / openid"
        style="width: 260px"
        clearable
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-select v-model="sort" style="width: 150px" @change="reload">
        <el-option label="按注册时间" value="recent" />
        <el-option label="按消费额" value="spend" />
      </el-select>
      <el-button type="primary" @click="reload">查询</el-button>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column v-if="!isMobile" prop="id" label="ID" width="70" />
      <el-table-column label="用户" min-width="180">
        <template #default="{ row }">
          <div class="user-cell">
            <el-avatar :size="32" :src="row.avatarUrl || undefined">
              {{ (row.nickname || '微')[0] }}
            </el-avatar>
            <div>
              <div>{{ row.nickname || '微信用户' }}</div>
              <div class="muted">{{ shortOpenid(row.openid) }}</div>
              <!-- 手机上「累计消费 / 成交单数 / 最近成交」三列放不下，压成一行塞进用户格 -->
              <div v-if="isMobile" class="muted u-stat">
                消费 {{ fenToYuan(row.totalSpent) }} · {{ row.paidOrderCount }} 单
              </div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="手机号" width="130">
        <template #default="{ row }">{{ row.phone || '-' }}</template>
      </el-table-column>
      <el-table-column v-if="!isMobile" label="累计消费" width="110">
        <template #default="{ row }">{{ fenToYuan(row.totalSpent) }}</template>
      </el-table-column>
      <el-table-column v-if="!isMobile" label="成交单数" width="100">
        <template #default="{ row }">{{ row.paidOrderCount }} / {{ row.orderCount }}</template>
      </el-table-column>
      <el-table-column v-if="!isMobile" label="最近成交" width="170">
        <template #default="{ row }">{{ row.lastPaidAt ? formatTime(row.lastPaidAt) : '-' }}</template>
      </el-table-column>
      <el-table-column v-if="!isMobile" label="注册时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="90" :fixed="isMobile ? false : 'right'">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.id)">详情</el-button>
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

    <el-dialog v-model="detailVisible" title="用户详情" width="760px">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="3" border size="small">
          <el-descriptions-item label="用户">
            {{ detail.nickname || '微信用户' }}
          </el-descriptions-item>
          <el-descriptions-item label="手机号">{{ detail.phone || '-' }}</el-descriptions-item>
          <el-descriptions-item label="注册时间">{{ formatTime(detail.createdAt) }}</el-descriptions-item>
          <el-descriptions-item label="累计消费">{{ fenToYuan(detail.totalSpent) }} 元</el-descriptions-item>
          <el-descriptions-item label="成交 / 总单">
            {{ detail.paidOrderCount }} / {{ detail.orderCount }}
          </el-descriptions-item>
          <el-descriptions-item label="客单价">{{ fenToYuan(detail.avgOrderValue) }} 元</el-descriptions-item>
          <el-descriptions-item label="openid" :span="3">{{ detail.openid }}</el-descriptions-item>
        </el-descriptions>

        <h4 class="section-title">收货地址（{{ detail.addresses.length }}）</h4>
        <el-table :data="detail.addresses" border size="small">
          <el-table-column label="收货人" width="110">
            <template #default="{ row }">
              {{ row.receiverName }}
              <el-tag v-if="row.isDefault" size="small" type="success">默认</el-tag>
            </template>
          </el-table-column>
          <el-table-column prop="phone" label="电话" width="130" />
          <el-table-column label="地址">
            <template #default="{ row }">
              {{ row.province }}{{ row.city }}{{ row.district }}{{ row.detail }}
            </template>
          </el-table-column>
        </el-table>

        <h4 class="section-title">最近订单（{{ detail.recentOrders.length }}）</h4>
        <el-table :data="detail.recentOrders" border size="small">
          <el-table-column prop="orderNo" label="订单号" width="190" />
          <el-table-column label="商品" min-width="160">
            <template #default="{ row }">{{ row.goodsSummary || '-' }}</template>
          </el-table-column>
          <el-table-column label="金额" width="100">
            <template #default="{ row }">{{ fenToYuan(row.totalAmount) }}</template>
          </el-table-column>
          <el-table-column label="状态" width="100">
            <template #default="{ row }">
              <el-tag :type="statusTag(row.status)" size="small">{{ statusText(row.status) }}</el-tag>
            </template>
          </el-table-column>
          <el-table-column label="下单时间" width="170">
            <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
          </el-table-column>
        </el-table>
      </div>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import { adminListUsers, adminGetUser, type AdminUserDetail, type AdminUserRow } from '@/api/users';
import { fenToYuan } from '@/utils/money';

const { isMobile } = useIsMobile();
type TagType = 'success' | 'warning' | 'info' | 'primary' | 'danger';

const STATUS_MAP: Record<string, { label: string; tag: TagType }> = {
  PENDING_PAYMENT: { label: '待支付', tag: 'warning' },
  PAID: { label: '已支付', tag: 'primary' },
  SHIPPED: { label: '已发货', tag: 'success' },
  COMPLETED: { label: '已完成', tag: 'info' },
  CANCELLED: { label: '已取消', tag: 'danger' },
};
const statusText = (s: string) => STATUS_MAP[s]?.label || s;
const statusTag = (s: string): TagType => STATUS_MAP[s]?.tag || 'info';

const formatTime = (t: string | null) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }) : '-');
const shortOpenid = (o: string) => (o.length > 14 ? `${o.slice(0, 8)}…${o.slice(-4)}` : o);

const loading = ref(false);
const rows = ref<AdminUserRow[]>([]);
const keyword = ref('');
const sort = ref<'recent' | 'spend'>('recent');
const page = ref(1);
const size = ref(20);
const total = ref(0);

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<AdminUserDetail | null>(null);

async function load() {
  loading.value = true;
  try {
    const data = await adminListUsers({
      keyword: keyword.value.trim() || undefined,
      sort: sort.value,
      page: page.value,
      size: size.value,
    });
    rows.value = data.list;
    total.value = data.total;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function reload() {
  page.value = 1;
  load();
}

function onPage(p: number) {
  page.value = p;
  load();
}

async function openDetail(id: number) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await adminGetUser(id);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    detailLoading.value = false;
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
.user-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.muted {
  color: var(--text-mid);
  font-size: 12px;
}
.section-title {
  margin: 20px 0 10px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-hi);
}
</style>

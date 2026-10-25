<template>
  <div>
    <!-- 状态筛选 + 搜索 -->
    <div class="toolbar">
      <el-radio-group v-model="status" @change="reload">
        <el-radio-button value="ALL">全部</el-radio-button>
        <el-radio-button v-for="s in STATUS_LIST" :key="s.value" :value="s.value">
          {{ s.label }}<span v-if="counts[s.value]" class="count">{{ counts[s.value] }}</span>
        </el-radio-button>
      </el-radio-group>
    </div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="售后单号 / 订单号"
        style="width: 240px"
        clearable
        @keyup.enter="reload"
        @clear="reload"
      />
      <el-button type="primary" @click="reload">查询</el-button>
      <span class="muted tip">
        待处理超过 {{ reviewHours }} 小时会标红提醒，但<strong>不会自动同意/退款</strong>，需你确认；
        <template v-if="returnDays > 0">买家超过 {{ returnDays }} 天未寄回将自动关闭</template>
        <template v-else>买家未寄回不会自动关闭</template>
      </span>
      <el-tag v-if="overdueCount > 0" type="danger" effect="dark">
        {{ overdueCount }} 笔已超时待处理
      </el-tag>
      <el-tag v-if="autoApprove" type="danger" effect="plain">
        已开启超时自动退款（AFTER_SALE_AUTO_APPROVE=1）
      </el-tag>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="afterSaleNo" label="售后单号" width="180" />
      <el-table-column prop="orderNo" label="订单号" width="180" />
      <el-table-column label="用户" width="140">
        <template #default="{ row }">
          <div>{{ row.user?.nickname || '微信用户' }}</div>
          <div class="muted">{{ row.user?.openid }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="100">
        <template #default="{ row }">
          <el-tag :type="row.type === 'REFUND_ONLY' ? 'warning' : 'primary'" effect="plain">
            {{ row.type === 'REFUND_ONLY' ? '仅退款' : '退货退款' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reasonText" label="原因" width="150" show-overflow-tooltip />
      <el-table-column label="退款金额" width="110">
        <template #default="{ row }">{{ fenToYuan(row.refundAmount) }} 元</template>
      </el-table-column>
      <el-table-column label="状态" width="130">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
          <div v-if="row.status === 'PENDING' && rowOverdue(row)" class="overdue">
            已超时，待你确认
          </div>
        </template>
      </el-table-column>
      <el-table-column label="申请时间" width="170">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="190" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row.afterSaleNo)">详情</el-button>
          <template v-if="row.status === 'PENDING'">
            <el-button link type="success" @click="approve(row)">同意</el-button>
            <el-button link type="danger" @click="openReject(row)">拒绝</el-button>
          </template>
          <el-button
            v-if="row.status === 'RETURNING'"
            link
            type="success"
            @click="receive(row)"
          >
            确认收货并退款
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
    <el-dialog v-model="detailVisible" title="售后详情" width="720px">
      <div v-if="detail" v-loading="detailLoading">
        <el-descriptions :column="2" border size="small">
          <el-descriptions-item label="售后单号">{{ detail.afterSaleNo }}</el-descriptions-item>
          <el-descriptions-item label="状态">
            <el-tag :type="statusTag(detail.status)">{{ statusText(detail.status) }}</el-tag>
            <el-tag v-if="detail.status === 'PENDING' && rowOverdue(detail)" type="danger" class="ml">
              已超时
            </el-tag>
          </el-descriptions-item>
          <el-descriptions-item label="订单号">{{ detail.orderNo }}</el-descriptions-item>
          <el-descriptions-item label="用户">
            {{ detail.user?.nickname || detail.user?.openid }}
          </el-descriptions-item>
          <el-descriptions-item label="类型">
            {{ detail.type === 'REFUND_ONLY' ? '仅退款' : '退货退款' }}
          </el-descriptions-item>
          <el-descriptions-item label="原因">{{ detail.reasonText }}</el-descriptions-item>
          <el-descriptions-item label="申请退款">
            {{ fenToYuan(detail.refundAmount) }} 元
            <span class="muted">（订单实付 {{ fenToYuan(detail.orderTotal ?? 0) }} 元）</span>
          </el-descriptions-item>
          <el-descriptions-item label="已退金额">
            {{ fenToYuan(detail.refundedAmount) }} 元
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.refundNo" label="微信退款单号" :span="2">
            {{ detail.refundNo }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.returnTrackingNo" label="退货物流" :span="2">
            {{ detail.returnLogisticsCompany }} / {{ detail.returnTrackingNo }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.rejectReason" label="拒绝原因" :span="2">
            {{ detail.rejectReason }}
          </el-descriptions-item>
          <el-descriptions-item label="买家说明" :span="2">
            {{ detail.description || '—' }}
          </el-descriptions-item>
        </el-descriptions>

        <div v-if="detail.images.length" class="block">
          <div class="block-title">买家凭证</div>
          <div class="images">
            <el-image
              v-for="(img, i) in detail.images"
              :key="i"
              :src="img"
              :preview-src-list="detail.images"
              :initial-index="i"
              fit="cover"
              class="thumb"
              preview-teleported
            />
          </div>
        </div>

        <div v-if="detail.items?.length" class="block">
          <div class="block-title">商品</div>
          <el-table :data="detail.items" border size="small">
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

        <div class="block">
          <div class="block-title">处理进度</div>
          <el-timeline>
            <el-timeline-item
              v-for="(e, i) in timeline(detail)"
              :key="i"
              :timestamp="formatTime(e.at)"
              placement="top"
            >
              {{ e.text }}
            </el-timeline-item>
          </el-timeline>
        </div>
      </div>
      <template #footer>
        <template v-if="detail?.status === 'PENDING'">
          <el-button type="danger" plain @click="openReject(detail)">拒绝</el-button>
          <el-button type="success" @click="approve(detail)">同意</el-button>
        </template>
        <el-button
          v-else-if="detail?.status === 'RETURNING'"
          type="success"
          @click="receive(detail)"
        >
          确认收货并退款
        </el-button>
        <el-button @click="detailVisible = false">关闭</el-button>
      </template>
    </el-dialog>

    <!-- 拒绝原因 -->
    <el-dialog v-model="rejectVisible" title="拒绝售后" width="440px">
      <el-form label-width="80px">
        <el-form-item label="拒绝原因" required>
          <el-input
            v-model="rejectReason"
            type="textarea"
            :rows="3"
            maxlength="200"
            show-word-limit
            placeholder="例如：商品已签收且无质量问题，不符合退货条件"
          />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="rejectVisible = false">取消</el-button>
        <el-button type="danger" :loading="submitting" @click="submitReject">确认拒绝</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import {
  adminListAfterSales,
  adminGetAfterSale,
  adminApproveAfterSale,
  adminRejectAfterSale,
  adminReceiveAfterSale,
  type AfterSaleRow,
  type AfterSaleStatus,
} from '@/api/afterSales';
import { fenToYuan } from '@/utils/money';

type TagType = 'success' | 'warning' | 'info' | 'primary' | 'danger';

const STATUS_LIST: { label: string; value: AfterSaleStatus; tag: TagType }[] = [
  { label: '待处理', value: 'PENDING', tag: 'warning' },
  { label: '待买家退货', value: 'WAIT_RETURN', tag: 'warning' },
  { label: '退货中', value: 'RETURNING', tag: 'primary' },
  { label: '退款中', value: 'REFUNDING', tag: 'primary' },
  { label: '已同意', value: 'AGREED', tag: 'info' },
  { label: '已完成', value: 'COMPLETED', tag: 'success' },
  { label: '已拒绝', value: 'REJECTED', tag: 'danger' },
  { label: '已撤销', value: 'CANCELLED', tag: 'info' },
];

const STATUS_MAP = new Map(STATUS_LIST.map((s) => [s.value, s]));
const statusText = (s: AfterSaleStatus) => STATUS_MAP.get(s)?.label ?? s;
const statusTag = (s: AfterSaleStatus): TagType => STATUS_MAP.get(s)?.tag ?? 'info';

const formatTime = (t: string) => new Date(t).toLocaleString('zh-CN', { hour12: false });

const loading = ref(false);
const rows = ref<AfterSaleRow[]>([]);
// 'ALL' 表示不筛选（用空串做 radio 值容易和「未选中」混淆）
const status = ref<AfterSaleStatus | 'ALL'>('ALL');
const keyword = ref('');
const page = ref(1);
const size = ref(20);
const total = ref(0);
const counts = ref<Partial<Record<AfterSaleStatus, number>>>({});
const reviewHours = ref(48);
const returnDays = ref(7);
/** 待处理中已超时的笔数（仅提醒，不会自动退款） */
const overdueCount = ref(0);
/** 后端是否开启了「超时自动同意退款」，默认 false；开启时界面要显眼告警 */
const autoApprove = ref(false);

/**
 * 是否已超过商家处理时限。
 * 后端会直接下发 overdue，前端只在拿不到时（如详情接口旧版本）按 reviewHours 兜底计算。
 * 注意：超时只是提醒，后端不会自动同意、更不会自动退款。
 */
function rowOverdue(row: AfterSaleRow): boolean {
  if (typeof row.overdue === 'boolean') return row.overdue;
  return Date.now() - new Date(row.createdAt).getTime() > reviewHours.value * 60 * 60 * 1000;
}

async function load() {
  loading.value = true;
  try {
    const data = await adminListAfterSales({
      page: page.value,
      size: size.value,
      status: status.value === 'ALL' ? undefined : status.value,
      keyword: keyword.value.trim() || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
    counts.value = data.counts ?? {};
    reviewHours.value = data.reviewHours ?? 48;
    returnDays.value = data.returnDays ?? 7;
    overdueCount.value = data.overdueCount ?? 0;
    autoApprove.value = data.autoApprove ?? false;
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

const detailVisible = ref(false);
const detailLoading = ref(false);
const detail = ref<AfterSaleRow | null>(null);

async function openDetail(afterSaleNo: string) {
  detailVisible.value = true;
  detailLoading.value = true;
  detail.value = null;
  try {
    detail.value = await adminGetAfterSale(afterSaleNo);
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
    detailVisible.value = false;
  } finally {
    detailLoading.value = false;
  }
}

/** 时间轴：只放真实发生过的节点，避免出现空行 */
function timeline(row: AfterSaleRow): { at: string; text: string }[] {
  const events: { at: string; text: string }[] = [{ at: row.createdAt, text: '买家提交售后申请' }];
  if (row.agreedAt) events.push({ at: row.agreedAt, text: '商家同意售后' });
  if (row.returnedAt) events.push({ at: row.returnedAt, text: '买家已寄回商品' });
  if (row.receivedAt) events.push({ at: row.receivedAt, text: '商家确认收到退货' });
  if (row.refundedAt) events.push({ at: row.refundedAt, text: '退款成功' });
  if (row.rejectedAt) events.push({ at: row.rejectedAt, text: `商家拒绝：${row.rejectReason ?? ''}` });
  if (row.cancelledAt) events.push({ at: row.cancelledAt, text: '售后已撤销/关闭' });
  return events.sort((a, b) => +new Date(a.at) - +new Date(b.at));
}

const submitting = ref(false);

async function approve(row: AfterSaleRow) {
  const tip =
    row.type === 'REFUND_ONLY'
      ? `同意后将立即向买家原路退款 ¥${fenToYuan(row.refundAmount)}，确定吗？`
      : '同意后买家需要把商品寄回，收到货再确认退款。确定同意吗？';
  try {
    await ElMessageBox.confirm(tip, '同意售后', { type: 'warning' });
  } catch {
    return;
  }
  submitting.value = true;
  try {
    const updated = await adminApproveAfterSale(row.afterSaleNo);
    // 仅退款同意即退款，返回的状态可能已经是「退款中/已完成」，按实际结果提示
    ElMessage.success(
      row.type === 'REFUND_ONLY' ? `已同意，退款${statusText(updated.status)}` : '已同意，等待买家寄回',
    );
    detail.value = updated;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  } finally {
    submitting.value = false;
  }
}

async function receive(row: AfterSaleRow) {
  try {
    await ElMessageBox.confirm(
      `确认收到退货后，将立即向买家退款 ¥${fenToYuan(row.refundAmount)}。请确保已验货。`,
      '确认收货并退款',
      { type: 'warning' },
    );
  } catch {
    return;
  }
  submitting.value = true;
  try {
    const updated = await adminReceiveAfterSale(row.afterSaleNo);
    ElMessage.success(`已确认收货，退款${statusText(updated.status)}`);
    detail.value = updated;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  } finally {
    submitting.value = false;
  }
}

const rejectVisible = ref(false);
const rejectReason = ref('');
const rejectTarget = ref<AfterSaleRow | null>(null);

function openReject(row: AfterSaleRow) {
  rejectTarget.value = row;
  rejectReason.value = '';
  rejectVisible.value = true;
}

async function submitReject() {
  const text = rejectReason.value.trim();
  if (!text) {
    ElMessage.warning('请填写拒绝原因');
    return;
  }
  const target = rejectTarget.value;
  if (!target) return;
  submitting.value = true;
  try {
    const updated = await adminRejectAfterSale(target.afterSaleNo, text);
    rejectVisible.value = false;
    ElMessage.success('已拒绝');
    if (detail.value?.afterSaleNo === updated.afterSaleNo) detail.value = updated;
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  } finally {
    submitting.value = false;
  }
}

// 订单页跳过来时会带 ?orderNo=xxx，直接按订单号过滤，省得商家再手输一遍
const route = useRoute();

onMounted(() => {
  const q = route.query.orderNo;
  if (typeof q === 'string' && q.trim()) keyword.value = q.trim();
  load();
});
</script>

<style scoped>
.toolbar {
  display: flex;
  gap: 12px;
  margin-bottom: 12px;
  align-items: center;
  flex-wrap: wrap;
}
.tip {
  align-self: center;
}
.count {
  margin-left: 4px;
  font-weight: 600;
}
.overdue {
  color: #f56c6c;
  font-size: 12px;
  margin-top: 2px;
}
.ml {
  margin-left: 6px;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}
.muted {
  color: #999;
  font-size: 12px;
}
.block {
  margin-top: 16px;
}
.block-title {
  font-weight: 600;
  margin-bottom: 8px;
}
.images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.thumb {
  width: 72px;
  height: 72px;
  border-radius: 4px;
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

<template>
  <div>
    <!-- 升级横幅：超过升级阈值仍无人处理。只是提醒，不会自动退款 -->
    <el-alert
      v-if="escalatedCount > 0 && !escalatedOnly"
      type="error"
      :closable="false"
      show-icon
      class="banner"
    >
      <template #title>
        有 <strong>{{ escalatedCount }}</strong> 笔售后已超过 {{ escalateDays }} 天未处理，系统每天会推送一次汇总提醒
      </template>
      <div class="banner-body">
        系统不会自动同意，也不会自动退款，需你在这里确认。
        <el-button link type="primary" @click="showEscalated">只看这些</el-button>
      </div>
    </el-alert>

    <!-- 状态筛选 + 搜索 -->
    <div class="cmdbar">
      <div class="cmd-left">
        <el-radio-group v-model="status" :disabled="escalatedOnly" @change="reload">
          <el-radio-button value="ALL">全部</el-radio-button>
          <el-radio-button v-for="s in STATUS_LIST" :key="s.value" :value="s.value">
            {{ s.label }}<span v-if="counts[s.value]" class="count">{{ counts[s.value] }}</span>
          </el-radio-button>
        </el-radio-group>
        <el-tag v-if="escalatedOnly" type="danger" closable @close="clearEscalated">
          只看已升级
        </el-tag>
      </div>
    </div>
    <div class="cmdbar">
      <div class="cmd-left">
        <span class="label">search</span>
        <el-input
          v-model="keyword"
          placeholder="售后单号 / 订单号"
          style="width: 240px"
          clearable
          @keyup.enter="reload"
          @clear="reload"
        />
        <el-button type="primary" @click="reload">查询</el-button>
        <el-tag v-if="overdueCount > 0" type="danger">
          {{ overdueCount }} 笔已超时待处理
        </el-tag>
        <el-tag v-if="autoApprove" type="danger">
          已开启超时自动退款（AFTER_SALE_AUTO_APPROVE=1）
        </el-tag>
      </div>
      <span class="mono rule-tip">
        超时 {{ reviewHours }}h 只标红，不会自动退款；<template v-if="returnDays > 0">买家 {{ returnDays }} 天未寄回自动关闭</template><template v-else>买家未寄回不自动关闭</template>
      </span>
    </div>

    <!-- 手机：9 列横滑看不到操作 → 卡片流，金额与「同意/拒绝」都在一屏内 -->
    <div v-if="isMobile" v-loading="loading" class="as-list">
      <article v-for="row in rows" :key="row.afterSaleNo" class="as-card">
        <div class="as-hd">
          <span class="mono as-no">{{ row.afterSaleNo }}</span>
          <el-tag size="small" :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
        </div>

        <div class="as-mid">
          <div class="as-info">
            <div class="as-user">{{ row.user?.nickname || '微信用户' }}</div>
            <div class="as-reason">{{ row.reasonText }}</div>
            <div class="mono as-sub">订单 {{ row.orderNo }}</div>
          </div>
          <div class="as-amt">
            <div>
              <span class="as-num mono">{{ fenToYuan(row.refundAmount) }}</span>
              <span class="as-unit">元</span>
            </div>
            <el-tag size="small" :type="row.type === 'REFUND_ONLY' ? 'warning' : 'primary'">
              {{ row.type === 'REFUND_ONLY' ? '仅退款' : '退货退款' }}
            </el-tag>
          </div>
        </div>

        <div v-if="row.status === 'PENDING' && rowEscalated(row)" class="as-warn">
          已升级，{{ daysPending(row.createdAt) }} 天未处理
        </div>
        <div v-else-if="row.status === 'PENDING' && rowOverdue(row)" class="as-warn amber">
          已超时，待你确认
        </div>

        <div class="as-foot">
          <span class="mono as-time">{{ formatTime(row.createdAt) }}</span>
          <div class="as-acts">
            <el-button size="small" @click="openDetail(row.afterSaleNo)">详情</el-button>
            <template v-if="row.status === 'PENDING'">
              <el-button size="small" type="success" plain @click="approve(row)">同意</el-button>
              <el-button size="small" type="danger" plain @click="openReject(row)">拒绝</el-button>
            </template>
            <el-button v-if="row.status === 'RETURNING'" size="small" type="success" @click="receive(row)">
              确认收货退款
            </el-button>
          </div>
        </div>
      </article>
      <el-empty v-if="!loading && !rows.length" description="没有售后单" />
    </div>

    <el-table v-else v-loading="loading" :data="rows" class="as-table">
      <el-table-column prop="afterSaleNo" label="售后单号" width="170" />
      <el-table-column prop="orderNo" label="订单号" width="170" />
      <el-table-column label="用户" width="140">
        <template #default="{ row }">
          <div>{{ row.user?.nickname || '微信用户' }}</div>
          <div class="muted uid" :title="row.user?.openid">{{ row.user?.openid }}</div>
        </template>
      </el-table-column>
      <el-table-column label="类型" width="92">
        <template #default="{ row }">
          <el-tag :type="row.type === 'REFUND_ONLY' ? 'warning' : 'primary'">
            {{ row.type === 'REFUND_ONLY' ? '仅退款' : '退货退款' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column prop="reasonText" label="原因" min-width="110" show-overflow-tooltip />
      <el-table-column label="退款金额" width="100" align="right" header-align="right" class-name="num-cell">
        <template #default="{ row }">{{ fenToYuan(row.refundAmount) }} 元</template>
      </el-table-column>
      <el-table-column label="状态" width="138">
        <template #default="{ row }">
          <el-tag :type="statusTag(row.status)">{{ statusText(row.status) }}</el-tag>
          <div v-if="row.status === 'PENDING' && rowEscalated(row)" class="escalated">
            已升级，{{ daysPending(row.createdAt) }} 天未处理
          </div>
          <div v-else-if="row.status === 'PENDING' && rowOverdue(row)" class="overdue">
            已超时，待你确认
          </div>
        </template>
      </el-table-column>
      <el-table-column label="申请时间" width="170" class-name="num-cell time-cell">
        <template #default="{ row }">{{ formatTime(row.createdAt) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="190" :fixed="isMobile ? false : 'right'">
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
            <el-tag v-if="detail.status === 'PENDING' && rowEscalated(detail)" type="danger" class="ml">
              已升级
            </el-tag>
            <el-tag
              v-else-if="detail.status === 'PENDING' && rowOverdue(detail)"
              type="warning"
              class="ml"
            >
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
import { useIsMobile } from '@/composables/useIsMobile';
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

const { isMobile } = useIsMobile();
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
/** 已升级（超过升级阈值仍待处理）的笔数 */
const escalatedCount = ref(0);
/** 升级阈值（天），0 表示不升级 */
const escalateDays = ref(3);
/** 是否只看已升级 */
const escalatedOnly = ref(false);
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

/** 是否已升级（拖过按天计的阈值）。同样是纯提醒语义 */
function rowEscalated(row: AfterSaleRow): boolean {
  if (escalateDays.value <= 0) return false;
  if (typeof row.escalated === 'boolean') return row.escalated;
  return Date.now() - new Date(row.createdAt).getTime() > escalateDays.value * 24 * 60 * 60 * 1000;
}

/** 已挂多少天（向下取整） */
function daysPending(createdAt: string): number {
  return Math.floor((Date.now() - new Date(createdAt).getTime()) / (24 * 60 * 60 * 1000));
}

function showEscalated() {
  escalatedOnly.value = true;
  status.value = 'ALL';
  reload();
}

function clearEscalated() {
  escalatedOnly.value = false;
  reload();
}

async function load() {
  loading.value = true;
  try {
    const data = await adminListAfterSales({
      page: page.value,
      size: size.value,
      status: escalatedOnly.value || status.value === 'ALL' ? undefined : status.value,
      keyword: keyword.value.trim() || undefined,
      escalatedOnly: escalatedOnly.value || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
    counts.value = data.counts ?? {};
    reviewHours.value = data.reviewHours ?? 48;
    returnDays.value = data.returnDays ?? 7;
    overdueCount.value = data.overdueCount ?? 0;
    escalatedCount.value = data.escalatedCount ?? 0;
    escalateDays.value = data.escalateDays ?? 3;
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
.banner {
  margin-bottom: 12px;
}
.banner-body {
  margin-top: 2px;
  font-size: 12px;
}
.cmdbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}
.cmd-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.rule-tip {
  font-size: 10.5px;
  color: var(--text-lo);
  letter-spacing: 0.04em;
}
.as-table :deep(.time-cell .cell) {
  white-space: nowrap;
}
.as-table :deep(.num-cell .cell) {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
}
.count {
  margin-left: 4px;
  font-weight: 600;
}
.overdue {
  color: var(--red);
  font-size: 11px;
  margin-top: 3px;
}
.escalated {
  color: var(--red);
  font-size: 11px;
  font-weight: 600;
  margin-top: 3px;
}
.ml {
  margin-left: 6px;
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
.block {
  margin-top: 16px;
}
.block-title {
  font-weight: 600;
  margin-bottom: 8px;
  font-size: 12px;
  letter-spacing: 0.04em;
  color: var(--text-hi);
}
.images {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.thumb {
  width: 72px;
  height: 72px;
  border-radius: var(--r-1);
  border: 1px solid var(--line-1);
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
  border: 1px solid var(--line-1);
  flex-shrink: 0;
}
/* ─────────── 手机卡片流 ─────────── */
.as-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 120px;
}
.as-card {
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
  padding: 12px;
}
.as-hd {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.as-no {
  font-size: 12px;
  color: var(--text-hi);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as-mid {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-top: 9px;
}
.as-info {
  min-width: 0;
  flex: 1;
}
.as-user {
  font-size: 13.5px;
  color: var(--text-hi);
}
.as-reason {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-mid);
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.as-sub {
  margin-top: 4px;
  font-size: 10.5px;
  color: var(--text-lo);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.as-amt {
  flex: none;
  text-align: right;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.as-num {
  font-size: 17px;
  color: var(--text-hi);
}
.as-unit {
  margin-left: 3px;
  font-size: 10.5px;
  color: var(--text-lo);
}
.as-warn {
  margin-top: 9px;
  padding: 6px 8px;
  font-size: 11px;
  color: var(--red);
  background: var(--red-soft);
  border-left: 2px solid var(--red);
}
.as-warn.amber {
  color: var(--amber);
  background: var(--amber-soft);
  border-left-color: var(--amber);
}
.as-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.as-time {
  font-size: 10.5px;
  color: var(--text-lo);
  flex: none;
}
.as-acts {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.as-acts .el-button {
  margin-left: 0;
}
</style>
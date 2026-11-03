<template>
  <div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索商品名称/副标题"
        clearable
        style="width: 240px"
        @keyup.enter="load"
        @clear="load"
      />
      <el-select v-model="status" placeholder="全部状态" clearable style="width: 140px" @change="load">
        <el-option label="上架" value="ON" />
        <el-option label="下架" value="OFF" />
      </el-select>
      <el-button type="primary" @click="load">查询</el-button>
      <el-button type="success" @click="goCreate">+ 录入商品</el-button>
      <el-button @click="goImport">批量导入</el-button>
      <!-- 桌面：勾表格左侧的选择列后点这里；手机：点它进入多选态 -->
      <el-button
        v-if="isMobile"
        :type="selectMode ? 'info' : 'danger'"
        plain
        @click="toggleSelectMode"
      >
        {{ selectMode ? '退出多选' : '批量删除' }}
      </el-button>
      <el-button
        v-else
        type="danger"
        plain
        :disabled="!selectedIds.length || removing"
        :loading="removing"
        @click="doBatchRemove(selectedIds)"
      >
        批量删除{{ selectedIds.length ? `（${selectedIds.length}）` : '' }}
      </el-button>
    </div>

    <!-- 手机：表格 6 列在 390px 下必然横滑，改成卡片流，一屏一张、动作直接点 -->
    <div v-if="isMobile" v-loading="loading" class="p-list" :class="{ 'has-batchbar': selectMode }">
      <article
        v-for="row in rows"
        :key="row.id"
        class="p-card"
        :class="{ picked: selectMode && isPicked(row.id) }"
        @click="selectMode && togglePick(row.id)"
      >
        <div class="p-hd">
          <!-- 多选态：左边多一个勾选圈，点整张卡也能切换，不用精确点中小方块 -->
          <span v-if="selectMode" class="p-check" :class="{ on: isPicked(row.id) }">
            {{ isPicked(row.id) ? '✓' : '' }}
          </span>
          <img v-if="row.coverImage" :src="mediaSrc(row.coverImage)" class="p-cover" :alt="row.name" />
          <div v-else class="p-cover ph">无图</div>
          <div class="p-info">
            <div class="p-name">{{ row.name }}</div>
            <div v-if="row.subtitle" class="p-sub">{{ row.subtitle }}</div>
            <div class="p-meta mono">
              ¥{{ priceText(row) }} · 库存 {{ totalStock(row) }} · 销 {{ row.salesCount }}
            </div>
          </div>
          <el-tag size="small" :type="row.status === 'ON' ? 'success' : 'info'">
            {{ row.status === 'ON' ? '上架' : '下架' }}
          </el-tag>
        </div>
        <!-- 多选态下收起逐条动作，避免想勾选却点成「删除」 -->
        <div v-if="!selectMode" class="p-acts">
          <el-button size="small" @click="goEdit(row.id)">编辑</el-button>
          <el-button v-if="row.status === 'ON'" size="small" @click="toggle(row, 'OFF')">下架</el-button>
          <el-button v-else size="small" type="success" plain @click="toggle(row, 'ON')">上架</el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </div>
      </article>
      <el-empty v-if="!loading && !rows.length" description="没有商品" />

      <!-- 多选操作条：贴住底部标签栏上方，勾完直接删，不用滚回顶部 -->
      <div v-if="selectMode" class="p-batchbar">
        <span class="mono p-batchinfo">已选 {{ picked.length }}</span>
        <el-button size="small" @click="togglePickAll">{{ allPicked ? '取消全选' : '全选本页' }}</el-button>
        <el-button
          size="small"
          type="danger"
          :disabled="!picked.length || removing"
          :loading="removing"
          @click="doBatchRemove(picked)"
        >
          删除
        </el-button>
      </div>
    </div>

    <el-table
      v-else
      ref="tableRef"
      v-loading="loading"
      :data="rows"
      row-key="id"
      border
      stripe
      @selection-change="onSelectionChange"
    >
      <el-table-column type="selection" width="44" :selectable="() => true" />
      <el-table-column label="商品" min-width="300">
        <template #default="{ row }">
          <div class="prod-cell">
            <img v-if="row.coverImage" :src="mediaSrc(row.coverImage)" class="cover" :alt="row.name" />
            <div v-else class="cover ph">无图</div>
            <div>
              <div class="name">{{ row.name }}</div>
              <div v-if="row.subtitle" class="subtitle">{{ row.subtitle }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="价格区间（元）" width="150">
        <template #default="{ row }">
          <span v-if="row.skus.length">
            {{ fenToYuan(row.skus[0].price) }} ~ {{ fenToYuan(row.skus[row.skus.length - 1].price) }}
          </span>
          <span v-else class="muted">无 SKU</span>
        </template>
      </el-table-column>
      <el-table-column label="总库存" width="90">
        <template #default="{ row }">{{ totalStock(row) }}</template>
      </el-table-column>
      <el-table-column prop="salesCount" label="销量" width="80" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'ON' ? 'success' : 'info'">
            {{ row.status === 'ON' ? '上架' : '下架' }}
          </el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="190" :fixed="isMobile ? false : 'right'">
        <template #default="{ row }">
          <el-button link type="primary" @click="goEdit(row.id)">编辑</el-button>
          <el-button v-if="row.status === 'ON'" link type="warning" @click="toggle(row, 'OFF')">下架</el-button>
          <el-button v-else link type="success" @click="toggle(row, 'ON')">上架</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
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
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import type { TableInstance } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import { mediaSrc } from '@/api/media';
import {
  adminBatchDeleteProducts,
  adminDeleteProduct,
  adminListProducts,
  adminSetProductStatus,
  type ProductRow,
} from '@/api/products';
import { fenToYuan } from '@/utils/money';

const { isMobile } = useIsMobile();
const router = useRouter();
const loading = ref(false);
const rows = ref<ProductRow[]>([]);
const keyword = ref('');
const status = ref<'ON' | 'OFF' | ''>('');
const page = ref(1);
const size = ref(10);
const total = ref(0);

/* ------------------------------------------------------------------ 批量删除
 * 两套 UI 两套选择态：
 *   - 桌面走 el-table 的 selection 列，selectedIds 由表格回传
 *   - 手机没有表格，自己维护 picked（点整张卡片切换），底部出操作条
 * 两者最终都走同一个 doBatchRemove()，语义与单条删除一致：软删 = 下架。
 */
const tableRef = ref<TableInstance>();
const selectedIds = ref<number[]>([]);
const selectMode = ref(false);
const picked = ref<number[]>([]);
const removing = ref(false);

const allPicked = computed(() => rows.value.length > 0 && picked.value.length === rows.value.length);
const isPicked = (id: number) => picked.value.includes(id);

function onSelectionChange(selected: ProductRow[]) {
  selectedIds.value = selected.map((r) => r.id);
}

function toggleSelectMode() {
  selectMode.value = !selectMode.value;
  if (!selectMode.value) picked.value = [];
}

function togglePick(id: number) {
  const i = picked.value.indexOf(id);
  if (i >= 0) picked.value.splice(i, 1);
  else picked.value.push(id);
}

function togglePickAll() {
  picked.value = allPicked.value ? [] : rows.value.map((r) => r.id);
}

/** 清掉两套选择态，删完/翻页/重新查询后都调一次，避免选中已不在列表里的 id */
function resetSelection() {
  picked.value = [];
  selectedIds.value = [];
  tableRef.value?.clearSelection();
}

async function doBatchRemove(ids: number[]) {
  if (!ids.length || removing.value) return;
  try {
    await ElMessageBox.confirm(
      `确认删除选中的 ${ids.length} 件商品？\n删除即下架并从 C 端隐藏，之后重新上架即可找回。`,
      '批量删除',
      { type: 'warning', confirmButtonText: '删除', cancelButtonText: '取消' },
    );
  } catch {
    return; // 取消不提示
  }
  removing.value = true;
  try {
    const r = await adminBatchDeleteProducts(ids);
    const skipped = r.requested - r.affected;
    ElMessage.success(skipped > 0 ? `已删除 ${r.affected} 件，${skipped} 件不存在已跳过` : `已删除 ${r.affected} 件商品`);
    selectMode.value = false;
    resetSelection();
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '批量删除失败');
  } finally {
    removing.value = false;
  }
}

function totalStock(row: ProductRow) {
  return row.skus.reduce((sum, s) => sum + s.stock, 0);
}

/** 卡片上的价格：单 SKU 就一个价，多 SKU 显示区间 */
function priceText(row: ProductRow) {
  if (!row.skus.length) return '—';
  const first = fenToYuan(row.skus[0].price);
  const last = fenToYuan(row.skus[row.skus.length - 1].price);
  return first === last ? first : `${first}~${last}`;
}

async function load() {
  loading.value = true;
  try {
    const data = await adminListProducts({
      page: page.value,
      size: size.value,
      keyword: keyword.value || undefined,
      status: status.value || undefined,
    });
    rows.value = data.list;
    total.value = data.total;
    // 换页/换筛选条件后旧的选择已经不在列表里，一起清掉
    resetSelection();
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

function goCreate() {
  router.push('/products/create');
}

function goImport() {
  router.push('/products/import');
}

function goEdit(id: number) {
  router.push(`/products/${id}/edit`);
}

async function toggle(row: ProductRow, next: 'ON' | 'OFF') {
  try {
    await adminSetProductStatus(row.id, next);
    ElMessage.success(next === 'ON' ? '已上架' : '已下架');
    load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '操作失败');
  }
}

async function remove(row: ProductRow) {
  try {
    await ElMessageBox.confirm(`确认删除「${row.name}」？删除即下架并从 C 端隐藏。`, '删除确认', {
      type: 'warning',
    });
    await adminDeleteProduct(row.id);
    ElMessage.success('已删除');
    load();
  } catch (e) {
    // 取消不提示
  }
}

onMounted(load);
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 16px;
}
.prod-cell {
  display: flex;
  align-items: center;
  gap: 10px;
}
.cover {
  width: 48px;
  height: 48px;
  border-radius: 4px;
  flex-shrink: 0;
}
.name {
  font-weight: 500;
}
.subtitle {
  color: var(--text-mid);
  font-size: 12px;
}
.muted {
  color: var(--text-lo);
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
}

/* ─────────── 手机卡片流 ─────────── */
.p-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 120px;
}
/* 多选态底部多出一条操作条，末尾补等高的内边距，别让最后一张卡被盖住 */
.p-list.has-batchbar {
  padding-bottom: 56px;
}
.p-card {
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
  padding: 12px;
}
/* 多选态：整张卡可点，选中后描边高亮，一眼看出勾了哪几张 */
.p-card.picked {
  border-color: var(--el-color-danger);
  box-shadow: 0 0 0 1px var(--el-color-danger) inset;
}
.p-check {
  width: 20px;
  height: 20px;
  flex: none;
  margin-top: 18px;
  border-radius: 50%;
  border: 1.5px solid var(--line-3);
  display: grid;
  place-items: center;
  font-size: 12px;
  line-height: 1;
  color: #fff;
  background: transparent;
}
.p-check.on {
  border-color: var(--el-color-danger);
  background: var(--el-color-danger);
}
.p-hd {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.p-cover {
  width: 56px;
  height: 56px;
  flex: none;
  border-radius: var(--r-1);
  border: 1px solid var(--line-1);
}
.p-cover.ph {
  display: grid;
  place-items: center;
  border-style: dashed;
  border-color: var(--line-3);
  font-size: 10px;
  color: var(--text-lo);
}
.p-info {
  flex: 1;
  min-width: 0;
}
.p-name {
  font-size: 13.5px;
  font-weight: 500;
  line-height: 1.45;
  color: var(--text-hi);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.p-sub {
  margin-top: 2px;
  font-size: 11.5px;
  color: var(--text-mid);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.p-meta {
  margin-top: 5px;
  font-size: 11.5px;
  color: var(--text-lo);
}
.p-acts {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.p-acts .el-button {
  flex: 1;
  margin-left: 0;
}

/* 多选操作条：压在底部标签栏（56px + 安全区）之上，别盖住导航 */
.p-batchbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: calc(56px + env(safe-area-inset-bottom));
  z-index: 20;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: var(--ink-850);
  border-top: 1px solid var(--line-1);
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.08);
}
.p-batchbar .el-button {
  margin-left: 0;
}
.p-batchinfo {
  flex: 1;
  font-size: 12.5px;
  color: var(--text-hi);
}
</style>

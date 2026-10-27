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
    </div>

    <!-- 手机：表格 6 列在 390px 下必然横滑，改成卡片流，一屏一张、动作直接点 -->
    <div v-if="isMobile" v-loading="loading" class="p-list">
      <article v-for="row in rows" :key="row.id" class="p-card">
        <div class="p-hd">
          <el-image v-if="row.coverImage" :src="row.coverImage" fit="cover" class="p-cover" />
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
        <div class="p-acts">
          <el-button size="small" @click="goEdit(row.id)">编辑</el-button>
          <el-button v-if="row.status === 'ON'" size="small" @click="toggle(row, 'OFF')">下架</el-button>
          <el-button v-else size="small" type="success" plain @click="toggle(row, 'ON')">上架</el-button>
          <el-button size="small" type="danger" plain @click="remove(row)">删除</el-button>
        </div>
      </article>
      <el-empty v-if="!loading && !rows.length" description="没有商品" />
    </div>

    <el-table v-else v-loading="loading" :data="rows" border stripe>
      <el-table-column label="商品" min-width="300">
        <template #default="{ row }">
          <div class="prod-cell">
            <el-image :src="row.coverImage" fit="cover" class="cover" :preview-src-list="[row.coverImage]" />
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
import { onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage, ElMessageBox } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import { adminDeleteProduct, adminListProducts, adminSetProductStatus, type ProductRow } from '@/api/products';
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
.p-card {
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
  padding: 12px;
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
</style>

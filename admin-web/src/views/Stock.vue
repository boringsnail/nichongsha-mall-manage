<template>
  <div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索商品"
        clearable
        class="search"
        @keyup.enter="load(1)"
        @clear="load(1)"
      />
      <el-button type="primary" @click="load(1)">查询</el-button>
      <el-tag type="warning" class="hint">库存 ≤ 10 为低库存预警</el-tag>
    </div>

    <!-- 手机：一张 SKU 一张卡，改库存不用横向拖表格 -->
    <div v-if="isMobile" v-loading="loading" class="s-list">
      <div v-for="row in rows" :key="row.skuId" class="s-card">
        <div class="s-hd">
          <img v-if="row.coverImage" :src="mediaSrc(row.coverImage)" class="s-cover" :alt="row.productName" />
          <div v-else class="s-cover ph">无图</div>
          <div class="s-info">
            <div class="s-name">{{ row.productName }}</div>
            <div class="s-meta">
              <span class="s-spec">{{ row.specName }}</span>
              <span class="s-dot">·</span>
              <span class="mono">{{ fenToYuan(row.price) }} 元</span>
            </div>
          </div>
          <el-tag v-if="row.status !== 'ON'" type="info" size="small" class="s-off">已下架</el-tag>
        </div>
        <div class="s-edit">
          <span class="label">库存</span>
          <el-input-number
            v-model="row.stock"
            :min="0"
            :max="999999"
            size="small"
            controls-position="right"
            class="s-num"
          />
          <el-tag v-if="row.stock <= 10" type="danger" size="small" class="s-low">低</el-tag>
          <el-button type="primary" size="small" :loading="row._saving" class="s-save" @click="save(row)">
            保存
          </el-button>
        </div>
      </div>
      <div v-if="!loading && !rows.length" class="empty">没有匹配的规格</div>
    </div>

    <el-table v-else v-loading="loading" :data="rows" border stripe>
      <el-table-column label="商品" min-width="200">
        <template #default="{ row }">
          <div class="prod-cell">
            <img v-if="row.coverImage" :src="mediaSrc(row.coverImage)" class="cover" :alt="row.productName" />
            <div v-else class="cover ph">无图</div>
            <div>
              <div>{{ row.productName }}</div>
              <div class="muted">{{ row.status === 'ON' ? '在售' : '已下架' }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column prop="specName" label="规格" width="140" />
      <el-table-column label="单价（元）" width="110">
        <template #default="{ row }">{{ fenToYuan(row.price) }}</template>
      </el-table-column>
      <el-table-column label="当前库存" width="196">
        <template #default="{ row }">
          <div class="stock-cell">
            <el-input-number v-model="row.stock" :min="0" :max="999999" size="small" controls-position="right" style="width: 132px" />
            <el-tag v-if="row.stock <= 10" type="danger" size="small">低</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110">
        <template #default="{ row }">
          <el-button link type="primary" :loading="row._saving" @click="save(row)">保存</el-button>
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
import { ElMessage } from 'element-plus';
import { useIsMobile } from '@/composables/useIsMobile';
import { adminListSkus, adminSetSkuStock, type StockSku } from '@/api/products';
import { mediaSrc } from '@/api/media';
import { fenToYuan } from '@/utils/money';

const { isMobile } = useIsMobile();
const loading = ref(false);
const rows = ref<StockSku[]>([]);
const keyword = ref('');
const page = ref(1);
const size = ref(10);
const total = ref(0);

async function load(p = page.value) {
  loading.value = true;
  try {
    // SKU 行级分页：total 即 SKU 总数，页大小与行对齐
    const data = await adminListSkus({ page: p, size: size.value, keyword: keyword.value || undefined });
    rows.value = data.list;
    total.value = data.total;
    page.value = p;
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function onPage(p: number) {
  load(p);
}

async function save(row: StockSku) {
  row._saving = true;
  const originalStock = row.stock;
  try {
    await adminSetSkuStock(row.skuId, row.stock);
    ElMessage.success(`${row.productName} ${row.specName} 库存已更新`);
  } catch (e) {
    // 保存失败时回滚到原始值，防止 UI 显示错误数据
    row.stock = originalStock;
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    row._saving = false;
  }
}

onMounted(() => load(1));
</script>

<style scoped>
.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.search {
  width: 220px;
}
.hint {
  margin-left: auto;
}
.pager {
  margin-top: 16px;
  justify-content: flex-end;
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
  object-fit: cover;
}
.cover.ph {
  display: grid;
  place-items: center;
  font-size: 10px;
  color: var(--text-lo);
  border: 1px dashed var(--line-2);
}
.muted {
  color: var(--text-mid);
  font-size: 12px;
}
.stock-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* ─────────── 手机卡片流 ─────────── */
.s-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 120px;
}
.s-card {
  padding: 12px;
  border: 1px solid var(--line-1);
  border-radius: var(--r-1);
  background: var(--ink-850);
}
.s-hd {
  display: flex;
  align-items: flex-start;
  gap: 10px;
}
.s-cover {
  width: 46px;
  height: 46px;
  flex: none;
  object-fit: cover;
  border-radius: var(--r-1);
  background: var(--ink-820);
}
.s-cover.ph {
  display: grid;
  place-items: center;
  font-size: 10px;
  color: var(--text-lo);
  border: 1px dashed var(--line-2);
}
.s-info {
  flex: 1;
  min-width: 0;
}
.s-name {
  font-size: 13.5px;
  line-height: 1.4;
  color: var(--text-hi);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.s-meta {
  margin-top: 3px;
  font-size: 11.5px;
  color: var(--text-lo);
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
}
.s-spec {
  color: var(--text-mid);
}
.s-dot {
  color: var(--line-3);
}
.s-off {
  flex: none;
}
.s-edit {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--line-1);
}
.s-edit .label {
  flex: none;
}
.s-num {
  width: 112px;
  flex: none;
}
.s-low {
  flex: none;
}
.s-save {
  margin-left: auto;
  flex: none;
}
.empty {
  padding: 28px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-lo);
}

@media (max-width: 900px) {
  .toolbar {
    gap: 8px;
  }
  .search {
    flex: 1;
    width: auto;
    min-width: 0;
  }
  .hint {
    margin-left: 0;
    order: 3;
    width: 100%;
    text-align: center;
  }
  .pager {
    justify-content: center;
    margin-top: 12px;
  }
}
</style>

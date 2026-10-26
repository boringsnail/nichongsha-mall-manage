<template>
  <div>
    <div class="toolbar">
      <el-input
        v-model="keyword"
        placeholder="搜索商品"
        clearable
        style="width: 220px"
        @keyup.enter="load(1)"
        @clear="load(1)"
      />
      <el-button type="primary" @click="load(1)">查询</el-button>
      <el-tag type="warning" class="hint">库存 ≤ 10 为低库存预警</el-tag>
    </div>

    <el-table v-loading="loading" :data="rows" border stripe>
      <el-table-column label="商品" min-width="200">
        <template #default="{ row }">
          <div class="prod-cell">
            <el-image :src="row.coverImage" fit="cover" class="cover" />
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
      <el-table-column label="当前库存" width="180">
        <template #default="{ row }">
          <div class="stock-cell">
            <el-input-number v-model="row.stock" :min="0" :max="999999" size="small" controls-position="right" style="width: 140px" />
            <el-tag v-if="row.stock <= 10" type="danger" size="small">低</el-tag>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="110" fixed="right">
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
import { adminListSkus, adminSetSkuStock, type StockSku } from '@/api/products';
import { fenToYuan } from '@/utils/money';

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
</style>
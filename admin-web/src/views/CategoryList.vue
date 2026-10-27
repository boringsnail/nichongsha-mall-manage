<template>
  <el-card>
    <template #header>
      <div class="card-header">
        <span>分类管理</span>
        <el-button type="primary" size="small" @click="onAdd">+ 新增分类</el-button>
      </div>
    </template>

    <!-- 手机：4 列表格只剩一条缝，改成「分类名 + 操作」的列表行 -->
    <div v-if="isMobile" v-loading="loading" class="c-list">
      <div v-for="row in rows" :key="row.id" class="c-row">
        <span class="c-idx mono">{{ row.sortOrder }}</span>
        <div class="c-body">
          <el-input
            v-if="editingId === row.id"
            v-model="editingName"
            size="small"
            @keyup.enter="save(row)"
          />
          <span v-else class="c-name">{{ row.name }}</span>
        </div>
        <div class="c-acts">
          <template v-if="editingId === row.id">
            <el-button link type="primary" @click="save(row)">保存</el-button>
            <el-button link @click="editingId = null">取消</el-button>
          </template>
          <template v-else>
            <el-button link type="primary" @click="startEdit(row)">重命名</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </div>
      </div>
      <div v-if="!loading && !rows.length" class="c-empty">还没有分类</div>
    </div>

    <el-table v-else v-loading="loading" :data="rows" border stripe>
      <el-table-column prop="id" label="ID" width="70" />
      <el-table-column label="分类名">
        <template #default="{ row }">
          <el-input v-if="editingId === row.id" v-model="editingName" size="small" @keyup.enter="save(row)" />
          <span v-else>{{ row.name }}</span>
        </template>
      </el-table-column>
      <el-table-column prop="sortOrder" label="排序" width="90" />
      <el-table-column label="操作" width="160">
        <template #default="{ row }">
          <template v-if="editingId === row.id">
            <el-button link type="primary" @click="save(row)">保存</el-button>
            <el-button link @click="editingId = null">取消</el-button>
          </template>
          <template v-else>
            <el-button link type="primary" @click="startEdit(row)">重命名</el-button>
            <el-button link type="danger" @click="remove(row)">删除</el-button>
          </template>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="addVisible" title="新增分类" width="420px">
      <el-input v-model="newName" placeholder="分类名" @keyup.enter="add" />
      <template #footer>
        <el-button @click="addVisible = false">取消</el-button>
        <el-button type="primary" :loading="adding" @click="add">确定</el-button>
      </template>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { createCategory, deleteCategory, listCategories, updateCategory, type Category } from '@/api/categories';
import { useIsMobile } from '@/composables/useIsMobile';

const { isMobile } = useIsMobile();

const loading = ref(false);
const rows = ref<Category[]>([]);
const editingId = ref<number | null>(null);
const editingName = ref('');
const addVisible = ref(false);
const adding = ref(false);
const newName = ref('');

async function load() {
  loading.value = true;
  try {
    rows.value = await listCategories();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
  } finally {
    loading.value = false;
  }
}

function startEdit(row: Category) {
  editingId.value = row.id;
  editingName.value = row.name;
}

async function save(row: Category) {
  const name = editingName.value.trim();
  if (!name) return;
  try {
    await updateCategory(row.id, { name });
    editingId.value = null;
    ElMessage.success('已保存');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  }
}

async function remove(row: Category) {
  try {
    await ElMessageBox.confirm(`确认删除分类「${row.name}」？分类下存在商品时将无法删除。`, '删除确认', {
      type: 'warning',
    });
    await deleteCategory(row.id);
    ElMessage.success('已删除');
    await load();
  } catch (e) {
    // 取消或后端 409 均不提示（后端消息会透出时单独处理）
    if (e instanceof Error && e.message) ElMessage.error(e.message);
  }
}

function onAdd() {
  newName.value = '';
  addVisible.value = true;
}

async function add() {
  const name = newName.value.trim();
  if (!name) {
    ElMessage.warning('请输入分类名');
    return;
  }
  adding.value = true;
  try {
    await createCategory({ name });
    addVisible.value = false;
    ElMessage.success('已新增');
    await load();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '新增失败');
  } finally {
    adding.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* ─────────── 手机列表 ─────────── */
.c-list {
  display: flex;
  flex-direction: column;
}
.c-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 48px;
  padding: 6px 2px;
  border-bottom: 1px solid var(--line-1);
}
.c-row:last-child {
  border-bottom: none;
}
.c-idx {
  flex: none;
  width: 26px;
  font-size: 10.5px;
  color: var(--text-lo);
  text-align: center;
}
.c-body {
  flex: 1;
  min-width: 0;
}
.c-name {
  font-size: 14px;
  color: var(--text-hi);
}
.c-acts {
  flex: none;
  display: flex;
  gap: 2px;
}
.c-empty {
  padding: 26px 0;
  text-align: center;
  font-size: 12px;
  color: var(--text-lo);
}
</style>

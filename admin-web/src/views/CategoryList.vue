<template>
  <el-card>
    <template #header>
      <div class="card-header">
        <span>分类管理</span>
        <el-button type="primary" size="small" @click="onAdd">+ 新增分类</el-button>
      </div>
    </template>

    <el-table v-loading="loading" :data="rows" border stripe>
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
</style>

<template>
  <el-card v-loading="loading">
    <template #header>{{ isEdit ? '编辑商品' : '录入商品' }}</template>
    <el-form ref="formRef" :model="form" :rules="rules" label-width="90px">
      <el-form-item label="商品名称" prop="name">
        <el-input v-model="form.name" placeholder="如：鸡肉冻干猫粮" maxlength="60" />
      </el-form-item>
      <el-form-item label="副标题" prop="subtitle">
        <el-input v-model="form.subtitle" placeholder="一句话卖点，选填" maxlength="60" />
      </el-form-item>
      <el-form-item label="分类" prop="categoryId">
        <el-select v-model="form.categoryId" placeholder="选择分类" style="width: 240px">
          <el-option v-for="c in categories" :key="c.id" :label="c.name" :value="c.id" />
        </el-select>
        <el-button link type="primary" @click="openCategoryDialog">管理分类</el-button>
      </el-form-item>
      <el-form-item label="封面图 URL" prop="coverImage">
        <el-input v-model="form.coverImage" placeholder="https://... 图片直链" />
      </el-form-item>
      <el-form-item label="详情图 URL">
        <el-input
          v-model="imagesText"
          type="textarea"
          :rows="3"
          placeholder="每行一个图片 URL，选填"
        />
      </el-form-item>
      <el-form-item label="商品描述" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="4" placeholder="图文/参数说明，选填" />
      </el-form-item>

      <el-form-item label="规格 SKU">
        <div class="sku-rows">
          <div v-for="(sku, i) in form.skus" :key="i" class="sku-row">
            <el-input v-model="sku.specName" placeholder="规格名，如 2kg" class="sku-spec" />
            <el-input-number
              v-model="sku.priceYuan"
              :min="0"
              :precision="2"
              :step="1"
              :controls="false"
              class="sku-price"
              placeholder="价格（元）"
            />
            <el-input-number v-model="sku.stock" :min="0" :step="1" class="sku-stock" placeholder="库存" />
            <el-button link type="danger" :disabled="form.skus.length <= 1" @click="removeSku(i)">删除</el-button>
          </div>
          <el-button type="primary" plain size="small" @click="addSku">+ 添加规格</el-button>
        </div>
      </el-form-item>

      <el-form-item>
        <el-button type="primary" :loading="submitting" @click="onSubmit">保存</el-button>
        <el-button @click="routerBack">取消</el-button>
      </el-form-item>
    </el-form>

    <!-- 分类快捷管理 -->
    <el-dialog v-model="categoryVisible" title="分类管理" width="480px">
      <div class="cat-item" v-for="c in categories" :key="c.id">
        <el-input v-model="c.name" size="small" style="flex: 1" />
        <el-button size="small" type="primary" plain @click="saveCategory(c)">保存</el-button>
        <el-button size="small" type="danger" plain @click="removeCategory(c)">删除</el-button>
      </div>
      <div class="cat-add">
        <el-input v-model="newCategoryName" size="small" placeholder="新分类名" style="flex: 1" />
        <el-button size="small" type="success" @click="addCategory">新增</el-button>
      </div>
    </el-dialog>
  </el-card>
</template>

<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { ElMessage, type FormInstance, type FormRules } from 'element-plus';
import {
  adminCreateProduct,
  adminGetProduct,
  adminUpdateProduct,
  type ProductDetail,
  type Sku,
} from '@/api/products';
import { createCategory, deleteCategory, listCategories, updateCategory, type Category } from '@/api/categories';
import { yuanToFen } from '@/utils/money';

interface SkuForm {
  /** 编辑模式既有 SKU 的数据库 id：无 id 视为新增 */
  id?: number;
  specName: string;
  priceYuan: number | undefined;
  stock: number;
}

const route = useRoute();
const router = useRouter();
const isEdit = !!route.params.id;
const productId = Number(route.params.id);

const formRef = ref<FormInstance>();
const loading = ref(false);
const submitting = ref(false);
const categories = ref<Category[]>([]);

const form = reactive({
  name: '',
  subtitle: '',
  categoryId: null as number | null,
  coverImage: '',
  description: '',
  skus: [] as SkuForm[],
});
const imagesText = ref('');

const rules: FormRules = {
  name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请选择分类', trigger: 'change' }],
  coverImage: [{ required: true, message: '请输入封面图 URL', trigger: 'blur' }],
};

function addSku() {
  form.skus.push({ specName: '', priceYuan: undefined, stock: 0 });
}

function removeSku(i: number) {
  form.skus.splice(i, 1);
}

function skuToForm(skus: Sku[]): SkuForm[] {
  return skus.map((s) => ({ id: s.id, specName: s.specName, priceYuan: s.price / 100, stock: s.stock }));
}

function parseImages(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function loadCategories() {
  categories.value = await listCategories();
}

async function loadDetail() {
  if (!isEdit) return;
  loading.value = true;
  try {
    const p: ProductDetail = await adminGetProduct(productId);
    form.name = p.name;
    form.subtitle = p.subtitle ?? '';
    form.categoryId = p.categoryId;
    form.coverImage = p.coverImage;
    form.description = p.description ?? '';
    form.skus = skuToForm(p.skus);
    imagesText.value = parseImages(p.images).join('\n');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '加载失败');
    routerBack();
  } finally {
    loading.value = false;
  }
}

function buildPayload() {
  const skus = form.skus
    .filter((s) => s.specName.trim() !== '')
    .map((s) => ({
      // 既有 SKU 回传 id → 服务端原位更新（保留被购物车/订单引用的 SKU）；无 id 为新增
      ...(s.id ? { id: s.id } : {}),
      specName: s.specName.trim(),
      price: yuanToFen(s.priceYuan ?? 0),
      stock: s.stock,
    }));
  if (!skus.length) throw new Error('至少需要一个规格 SKU');
  const images = imagesText.value.split('\n').map((s) => s.trim()).filter(Boolean);
  return {
    categoryId: form.categoryId!,
    name: form.name.trim(),
    subtitle: form.subtitle.trim() || undefined,
    description: form.description.trim() || undefined,
    coverImage: form.coverImage.trim(),
    images: images.length ? images : undefined,
    skus,
  };
}

async function onSubmit() {
  if (!form.skus.length) addSku();
  const valid = await formRef.value?.validate().catch(() => false);
  if (!valid) return;
  let payload;
  try {
    payload = buildPayload();
  } catch (e) {
    ElMessage.warning(e instanceof Error ? e.message : '参数不完整');
    return;
  }
  submitting.value = true;
  try {
    if (isEdit) {
      await adminUpdateProduct(productId, payload);
      ElMessage.success('已保存');
    } else {
      await adminCreateProduct(payload);
      ElMessage.success('录入成功');
    }
    router.replace('/products');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  } finally {
    submitting.value = false;
  }
}

function routerBack() {
  router.replace('/products');
}

// ---------- 分类快捷管理 ----------
const categoryVisible = ref(false);
const newCategoryName = ref('');

function openCategoryDialog() {
  categoryVisible.value = true;
}

async function addCategory() {
  const name = newCategoryName.value.trim();
  if (!name) return;
  try {
    await createCategory({ name });
    newCategoryName.value = '';
    await loadCategories();
    ElMessage.success('分类已新增');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '新增失败');
  }
}

async function saveCategory(c: Category) {
  try {
    await updateCategory(c.id, { name: c.name.trim() });
    ElMessage.success('已保存');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '保存失败');
  }
}

async function removeCategory(c: Category) {
  try {
    await deleteCategory(c.id);
    if (form.categoryId === c.id) form.categoryId = null;
    await loadCategories();
    ElMessage.success('已删除');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '删除失败');
  }
}

onMounted(async () => {
  addSku();
  try {
    await loadCategories();
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '分类加载失败');
  }
  await loadDetail();
});
</script>

<style scoped>
.sku-rows {
  width: 100%;
}
.sku-row {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
.sku-spec {
  width: 180px;
}
.sku-price {
  width: 140px;
}
.sku-stock {
  width: 120px;
}
.cat-item {
  display: flex;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}
.cat-add {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}
</style>

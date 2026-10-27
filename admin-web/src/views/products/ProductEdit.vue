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
      <el-form-item label="封面图" prop="coverImage">
        <!-- 手机上不该出现「填 URL」这种东西：商家相册里只有照片 -->
        <ImagePicker v-model="coverList" :max="1" />
      </el-form-item>
      <el-form-item label="详情图">
        <ImagePicker v-model="detailImages" :max="6" />
      </el-form-item>
      <el-form-item label="商品描述" prop="description">
        <el-input v-model="form.description" type="textarea" :rows="4" placeholder="图文/参数说明，选填" />
      </el-form-item>

      <el-form-item label="规格 SKU">
        <div class="sku-rows">
          <div v-for="(sku, i) in form.skus" :key="i" class="sku-row">
            <el-input v-model="sku.specName" placeholder="规格名，如 2kg" class="sku-spec" />
            <div class="sku-field sku-price">
              <!-- 库存默认 0，el-input-number 有值时 placeholder 不显示，手机上就分不清哪个是价格哪个是库存 -->
              <span class="sku-flabel">价格（元）</span>
              <el-input-number
                v-model="sku.priceYuan"
                :min="0"
                :precision="2"
                :step="1"
                :controls="false"
                placeholder="0.00"
              />
            </div>
            <div class="sku-field sku-stock">
              <span class="sku-flabel">库存</span>
              <el-input-number v-model="sku.stock" :min="0" :step="1" controls-position="right" placeholder="0" />
            </div>
            <el-button link type="danger" class="sku-del" :disabled="form.skus.length <= 1" @click="removeSku(i)">
              删除
            </el-button>
          </div>
          <el-button type="primary" plain size="small" class="sku-add" @click="addSku">+ 添加规格</el-button>
        </div>
      </el-form-item>

      <!-- 手机上表单很长，保存按钮跟着屏幕走，省得划到最底下 -->
      <div class="submit-bar">
        <el-button type="primary" :loading="submitting" @click="onSubmit">保存</el-button>
        <el-button @click="routerBack">取消</el-button>
      </div>
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
import { computed, onMounted, reactive, ref } from 'vue';
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
import ImagePicker from '@/components/ImagePicker.vue';

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

/** 封面图在表单里是单个字符串，选择器统一吃数组，这里做一层适配 */
const coverList = computed<string[]>({
  get: () => (form.coverImage ? [form.coverImage] : []),
  set: (v) => {
    form.coverImage = v[0] ?? '';
  },
});

/** 详情图：接口里存的是 JSON 字符串，这里始终是数组 */
const detailImages = ref<string[]>([]);

const rules: FormRules = {
  name: [{ required: true, message: '请输入商品名称', trigger: 'blur' }],
  categoryId: [{ required: true, message: '请选择分类', trigger: 'change' }],
  coverImage: [{ required: true, message: '请上传封面图', trigger: 'change' }],
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
    detailImages.value = parseImages(p.images);
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
  const images = detailImages.value.map((s) => s.trim()).filter(Boolean);
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
.sku-field {
  display: flex;
  align-items: center;
}
.sku-field .el-input-number {
  width: 100%;
}
/* 桌面端标签由 placeholder 承担，只在手机上显示 */
.sku-flabel {
  display: none;
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
.submit-bar {
  display: flex;
  gap: 8px;
}

/* ─────────── 手机：规格行改成「规格名独占一行，价格/库存并排」 ─────────── */
@media (max-width: 900px) {
  .sku-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
    grid-template-areas:
      'spec spec spec'
      'price stock del';
    gap: 8px 10px;
    padding: 10px;
    margin-bottom: 10px;
    border: 1px solid var(--line-1);
    border-radius: var(--r-1);
    background: var(--ink-820);
  }
  .sku-spec {
    grid-area: spec;
    width: 100%;
  }
  .sku-price {
    grid-area: price;
    width: 100%;
  }
  .sku-stock {
    grid-area: stock;
    width: 100%;
  }
  .sku-field {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }
  .sku-flabel {
    display: block;
    font-size: 11px;
    color: var(--text-lo);
  }
  .sku-del {
    grid-area: del;
    align-self: end;
  }
  .sku-add {
    width: 100%;
    height: 40px;
  }
  /* 保存条吸底：表单长，划到一半也能直接保存 */
  .submit-bar {
    position: sticky;
    bottom: 0;
    z-index: 3;
    padding: 10px 0 calc(10px + env(safe-area-inset-bottom));
    margin-top: 4px;
    background: linear-gradient(180deg, transparent, var(--ink-900) 22%);
  }
  .submit-bar .el-button {
    flex: 1;
    margin-left: 0;
  }
}
</style>

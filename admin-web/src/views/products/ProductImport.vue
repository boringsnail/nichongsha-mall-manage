<template>
  <div>
    <el-card shadow="never" class="intro">
      <div class="intro-head">
        <div>
          <div class="intro-title">批量导入商品</div>
          <div class="intro-desc">
            一行 = 一个规格（SKU）；同一「分类 + 商品名称」的多行会自动合并成一个商品。<br />
            金额填<b>元</b>（如 <code>39.9</code>），系统自动换算成分入库。
          </div>
        </div>
        <el-button @click="downloadTemplate">下载 CSV 模板</el-button>
      </div>
      <el-alert type="info" :closable="false" class="intro-tip">
        <template #title>
          Excel / WPS 里整理好后，<b>另存为 CSV UTF-8</b> 再上传；或直接选中区域复制后粘贴到下面的输入框。
        </template>
      </el-alert>
    </el-card>

    <el-card shadow="never" header="① 选择商品数据" class="block">
      <el-upload
        drag
        :auto-upload="false"
        :show-file-list="false"
        accept=".csv,.txt"
        :on-change="onFileChange"
      >
        <div class="drop">
          <div class="drop-icon">📄</div>
          <div>把 CSV 文件拖到这里，或<b>点击选择文件</b></div>
        </div>
      </el-upload>

      <el-divider>或者，直接从 Excel 复制粘贴</el-divider>

      <el-input
        v-model="pasted"
        type="textarea"
        :rows="6"
        placeholder="选中 Excel/WPS 里的表头+数据行复制，粘贴到这里"
      />
      <div class="row">
        <el-button type="primary" plain :disabled="!pasted.trim()" @click="parsePasted">解析粘贴内容</el-button>
        <el-button @click="reset">清空</el-button>
      </div>

      <el-alert v-if="parseError" type="error" :title="parseError" :closable="false" class="msg" />
      <el-alert
        v-if="unmappedHeaders.length"
        type="warning"
        :closable="false"
        class="msg"
        :title="`已忽略未识别的列：${unmappedHeaders.join('、')}`"
      />
      <el-alert
        v-if="rows.length"
        type="success"
        :closable="false"
        class="msg"
        :title="`已解析 ${rows.length} 行，覆盖 ${previewProductCount} 个商品`"
      />
    </el-card>

    <el-card shadow="never" header="② 导入选项与校验" class="block">
      <div class="opt">
        <span class="opt-label">遇到已存在的同名商品（同分类）：</span>
        <el-radio-group v-model="onDuplicate">
          <el-radio value="skip">跳过，不动</el-radio>
          <el-radio value="update">覆盖更新价格/库存</el-radio>
        </el-radio-group>
      </div>
      <div class="opt">
        <span class="opt-label">分类不存在时：</span>
        <el-switch v-model="createMissingCategory" active-text="自动创建" inactive-text="报错中止" />
      </div>
      <el-button type="primary" :loading="loading" :disabled="!rows.length" @click="runPreview">
        校验预览（不写入）
      </el-button>
    </el-card>

    <el-card v-if="report" shadow="never" class="block">
      <template #header>
        <div class="result-head">
          <span>{{ report.dryRun ? '校验结果' : report.committed ? '导入完成' : '导入中止' }}</span>
          <el-tag v-if="report.summary.errorCount" type="danger">错误 {{ report.summary.errorCount }}</el-tag>
          <el-tag v-else-if="report.dryRun" type="success">校验通过</el-tag>
          <el-tag v-if="report.summary.warningCount" type="warning">告警 {{ report.summary.warningCount }}</el-tag>
        </div>
      </template>

      <el-descriptions :column="4" border class="summary">
        <el-descriptions-item label="数据行">{{ report.summary.totalRows }}</el-descriptions-item>
        <el-descriptions-item label="商品数">{{ report.summary.productCount }}</el-descriptions-item>
        <el-descriptions-item label="SKU 数">{{ report.summary.skuCount }}</el-descriptions-item>
        <el-descriptions-item label="新建商品">{{ report.summary.createCount }}</el-descriptions-item>
        <el-descriptions-item label="更新商品">{{ report.summary.updateCount }}</el-descriptions-item>
        <el-descriptions-item label="跳过">{{ report.summary.skipCount }}</el-descriptions-item>
        <el-descriptions-item label="有问题">{{ report.summary.invalidCount }}</el-descriptions-item>
        <el-descriptions-item label="将新建分类">{{ newCategoryCount }}</el-descriptions-item>
      </el-descriptions>

      <el-table :data="report.groups" border stripe max-height="440" class="groups">
        <el-table-column prop="name" label="商品名称" min-width="200" show-overflow-tooltip>
          <template #default="{ row }">{{ row.name || '（缺少商品名称）' }}</template>
        </el-table-column>
        <el-table-column prop="categoryName" label="分类" width="130" show-overflow-tooltip>
          <template #default="{ row }">
            {{ row.categoryName || '—' }}
            <el-tag v-if="row.newCategory" size="small" type="warning" effect="plain">新建</el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="skuCount" label="SKU" width="70" />
        <el-table-column label="动作" width="90">
          <template #default="{ row }">
            <el-tag :type="actionTagType(row.action)" size="small">{{ actionLabel(row.action) }}</el-tag>
          </template>
        </el-table-column>
        <el-table-column label="问题" min-width="280">
          <template #default="{ row }">
            <div v-for="(e, i) in row.errors" :key="`e${i}`" class="err">✕ 第 {{ e.rowNo }} 行 {{ e.message }}</div>
            <div v-for="(w, i) in row.warnings" :key="`w${i}`" class="warn">! 第 {{ w.rowNo }} 行 {{ w.message }}</div>
            <span v-if="!row.errors.length && !row.warnings.length" class="ok">—</span>
          </template>
        </el-table-column>
      </el-table>

      <div class="row footer">
        <el-button
          v-if="report.dryRun"
          type="success"
          :loading="loading"
          :disabled="report.summary.errorCount > 0"
          @click="commit"
        >
          确认导入 {{ report.summary.createCount + report.summary.updateCount }} 个商品
        </el-button>
        <el-button v-if="report.dryRun && report.summary.errorCount > 0" @click="runPreview">重新校验</el-button>
        <el-button v-if="!report.dryRun" type="primary" @click="goProducts">去看商品列表</el-button>
        <span v-if="report.dryRun && report.summary.errorCount > 0" class="hint">
          存在错误行，已禁止导入。请在源表里修正后重新校验。
        </span>
        <span v-if="!report.dryRun && report.committed" class="hint">
          新建分类 {{ report.written.categories }} 个、商品 {{ report.written.products }} 个、SKU {{ report.written.skus }} 个；
          更新商品 {{ report.written.updatedProducts }} 个。
        </span>
      </div>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import type { UploadFile } from 'element-plus';
import { adminImportProducts, adminImportTemplate, type ImportReport, type ImportRowInput } from '@/api/products';
import { buildTemplateCsv, decodeFile, matrixToRows, parseDelimited } from '@/utils/importTable';

const router = useRouter();

const pasted = ref('');
const rows = ref<ImportRowInput[]>([]);
const parseError = ref('');
const unmappedHeaders = ref<string[]>([]);
const onDuplicate = ref<'skip' | 'update'>('skip');
const createMissingCategory = ref(true);
const loading = ref(false);
const report = ref<ImportReport | null>(null);
const template = ref<{ headers: string[]; sample: string[][] } | null>(null);

const previewProductCount = computed(() => {
  const keys = new Set(rows.value.map((r) => `${r.categoryName ?? ''}\u0000${r.name ?? ''}`));
  return keys.size;
});

const newCategoryCount = computed(
  () => new Set((report.value?.groups ?? []).filter((g) => g.newCategory).map((g) => g.categoryName)).size,
);

function actionLabel(action: string) {
  return { CREATE: '新建', UPDATE: '更新', SKIP: '跳过', INVALID: '有问题' }[action] ?? action;
}

function actionTagType(action: string): 'success' | 'primary' | 'info' | 'danger' {
  return ({ CREATE: 'success', UPDATE: 'primary', SKIP: 'info', INVALID: 'danger' } as const)[
    action as 'CREATE' | 'UPDATE' | 'SKIP' | 'INVALID'
  ] ?? 'info';
}

function applyMatrix(matrix: string[][]) {
  const result = matrixToRows(matrix);
  unmappedHeaders.value = result.unmappedHeaders;
  if (result.error) {
    parseError.value = result.error;
    rows.value = [];
    report.value = null;
    return;
  }
  parseError.value = '';
  rows.value = result.rows;
  report.value = null;
}

async function onFileChange(file: UploadFile) {
  const raw = file.raw;
  if (!raw) return;
  try {
    const text = await decodeFile(raw);
    pasted.value = '';
    applyMatrix(parseDelimited(text));
  } catch (e) {
    parseError.value = e instanceof Error ? e.message : '文件解析失败';
    rows.value = [];
  }
}

function parsePasted() {
  applyMatrix(parseDelimited(pasted.value));
}

function reset() {
  pasted.value = '';
  rows.value = [];
  report.value = null;
  parseError.value = '';
  unmappedHeaders.value = [];
}

function currentPayload(dryRun: boolean) {
  return {
    dryRun,
    onDuplicate: onDuplicate.value,
    createMissingCategory: createMissingCategory.value,
    rows: rows.value,
  };
}

async function runPreview() {
  loading.value = true;
  try {
    report.value = await adminImportProducts(currentPayload(true));
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '校验失败');
  } finally {
    loading.value = false;
  }
}

async function commit() {
  loading.value = true;
  try {
    const result = await adminImportProducts(currentPayload(false));
    report.value = result;
    if (result.committed) ElMessage.success('导入完成');
    else ElMessage.warning('存在错误行，未全部导入');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '导入失败');
  } finally {
    loading.value = false;
  }
}

function goProducts() {
  router.push('/products');
}

function downloadTemplate() {
  if (!template.value) {
    ElMessage.warning('模板尚未加载完成，请稍后重试');
    return;
  }
  const csv = buildTemplateCsv(template.value.headers, template.value.sample);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = '你宠啥-商品导入模板.csv';
  a.click();
  URL.revokeObjectURL(url);
}

onMounted(async () => {
  try {
    template.value = await adminImportTemplate();
  } catch {
    // 模板拿不到不阻断主流程，用户仍可手写表头
  }
});
</script>

<style scoped>
.intro {
  margin-bottom: 16px;
}
.intro-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}
.intro-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 6px;
}
.intro-desc {
  color: var(--text-mid);
  font-size: 13px;
  line-height: 1.7;
}
.intro-tip {
  margin-top: 14px;
}
.block {
  margin-bottom: 16px;
}
.drop {
  padding: 18px 0;
  color: var(--text-mid);
}
.drop-icon {
  font-size: 28px;
  margin-bottom: 6px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 12px;
}
.opt {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.opt-label {
  color: var(--text-mid);
  font-size: 13px;
}
.msg {
  margin-top: 12px;
}
.result-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.summary {
  margin-bottom: 14px;
}
.groups {
  margin-bottom: 8px;
}
.err {
  color: var(--red);
  font-size: 12px;
  line-height: 1.6;
}
.warn {
  color: var(--amber);
  font-size: 12px;
  line-height: 1.6;
}
.ok {
  color: var(--text-lo);
}
.footer {
  flex-wrap: wrap;
}
.hint {
  color: var(--text-lo);
  font-size: 12px;
}
code {
  background: #f2f3f5;
  padding: 1px 4px;
  border-radius: 3px;
}
</style>

<template>
  <div class="picker" :class="{ 'is-mobile': isMobile }">
    <div v-for="(url, i) in modelValue" :key="`${url}-${i}`" class="cell">
      <img v-if="url" :src="mediaSrc(url)" class="thumb" :alt="`图片 ${i + 1}`" />
      <div v-else class="thumb ph">无图</div>
      <button class="del" type="button" aria-label="删除这张图" @click="removeAt(i)">×</button>
      <button class="swap" type="button" aria-label="更换这张图" @click="pick(i)">更换</button>
    </div>

    <button v-if="modelValue.length < max" class="add" type="button" :disabled="uploading" @click="pick(-1)">
      <span v-if="uploading" class="spin" />
      <template v-else>
        <span class="plus">＋</span>
        <span class="add-text">{{ modelValue.length ? '再加一张' : '上传图片' }}</span>
      </template>
    </button>

    <!-- 相机 / 相册都走这个 input；accept 限定图片，手机上会直接弹「拍照 / 从相册选择」 -->
    <input
      ref="fileRef"
      type="file"
      accept="image/*"
      :multiple="max > 1"
      class="file"
      @change="onFileChange"
    />
  </div>

  <div class="picker-foot">
    <el-button link type="primary" @click="urlDialog = true">改用图片链接</el-button>
    <span class="hint">{{ hintText }}</span>
  </div>

  <el-dialog v-model="urlDialog" title="填写图片链接" width="480px" append-to-body>
    <el-input v-model="urlInput" placeholder="https://... 图片直链" clearable />
    <p class="url-hint">已经有图床地址时用这个；日常上传照片请用上面的按钮。</p>
    <template #footer>
      <el-button @click="urlDialog = false">取消</el-button>
      <el-button type="primary" @click="applyUrl">确定</el-button>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { mediaSrc, uploadImage } from '@/api/media';
import { useIsMobile } from '@/composables/useIsMobile';

/**
 * 图片选择器：手机相册直传，不再让商家去别处找「图片直链」。
 *
 * 单图 / 多图用同一个组件，靠 max 区分：封面图 max=1，详情图 max=6。
 * 上传成功后拿到的是绝对地址，直接存进商品的 coverImage / images。
 */
const props = withDefaults(
  defineProps<{
    /** 已选图片地址列表（长度 ≤ max） */
    modelValue: string[];
    /** 最多几张；1 = 单图模式 */
    max?: number;
  }>(),
  { max: 1 },
);

const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();

const { isMobile } = useIsMobile();
const fileRef = ref<HTMLInputElement>();
const uploading = ref(false);
const urlDialog = ref(false);
const urlInput = ref('');
/** 点的是哪一格：-1 表示新增，≥0 表示替换那一张 */
const replaceAt = ref(-1);

const hintText = computed(() =>
  props.max === 1 ? '建议 1:1 方图，长边 1600px 内自动压缩' : `最多 ${props.max} 张，按顺序展示`,
);

function pick(at: number) {
  replaceAt.value = at;
  urlInput.value = at >= 0 ? props.modelValue[at] ?? '' : '';
  fileRef.value?.click();
}

async function onFileChange(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // 先清空 value：否则选同一张图不会再触发 change
  input.value = '';
  if (!files.length) return;

  uploading.value = true;
  try {
    const next = [...props.modelValue];
    for (const file of files) {
      if (next.length >= props.max && replaceAt.value < 0) {
        ElMessage.warning(`最多 ${props.max} 张`);
        break;
      }
      const asset = await uploadImage(file);
      if (replaceAt.value >= 0 && replaceAt.value < next.length) {
        next[replaceAt.value] = asset.url;
        replaceAt.value = -1;
      } else if (next.length < props.max) {
        next.push(asset.url);
      }
    }
    emit('update:modelValue', next);
    ElMessage.success('图片已上传');
  } catch (err) {
    ElMessage.error(err instanceof Error ? err.message : '上传失败');
  } finally {
    uploading.value = false;
    replaceAt.value = -1;
  }
}

function removeAt(i: number) {
  const next = [...props.modelValue];
  next.splice(i, 1);
  emit('update:modelValue', next);
}

function applyUrl() {
  const url = urlInput.value.trim();
  if (!url) return;
  const next = [...props.modelValue];
  if (replaceAt.value >= 0 && replaceAt.value < next.length) next[replaceAt.value] = url;
  else if (next.length < props.max) next.push(url);
  else next[0] = url;
  emit('update:modelValue', next);
  urlDialog.value = false;
}
</script>

<style scoped>
.picker {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}
.cell {
  position: relative;
  width: 96px;
  height: 96px;
  flex: none;
}
.is-mobile .cell,
.is-mobile .add {
  width: 88px;
  height: 88px;
}
.thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border: 1px solid var(--line-2);
  border-radius: var(--r-1);
  background: var(--ink-820);
  display: block;
}
.thumb.ph {
  display: grid;
  place-items: center;
  font-size: 11px;
  color: var(--text-lo);
  border-style: dashed;
}
/* 删除角标压在右上角，44px 触控面积用 padding 撑出来（视觉小、点得准） */
.del {
  position: absolute;
  top: -7px;
  right: -7px;
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: var(--red);
  color: #fff;
  font-size: 14px;
  line-height: 1;
  cursor: pointer;
}
.swap {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 22px;
  padding: 0;
  border: none;
  border-top: 1px solid var(--line-2);
  border-radius: 0 0 var(--r-1) var(--r-1);
  background: rgb(0 0 0 / 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
}
.add {
  width: 96px;
  height: 96px;
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  border: 1px dashed var(--line-3);
  border-radius: var(--r-1);
  background: transparent;
  color: var(--text-mid);
  cursor: pointer;
  transition: border-color var(--dur-1) var(--ease), color var(--dur-1) var(--ease);
}
.add:hover:not(:disabled) {
  border-color: var(--signal);
  color: var(--signal);
}
.add:disabled {
  cursor: default;
  opacity: 0.7;
}
.plus {
  font-size: 20px;
  line-height: 1;
}
.add-text {
  font-size: 11px;
}
/* 上传中的转圈：不用 el-icon，省一次组件初始化 */
.spin {
  width: 18px;
  height: 18px;
  border: 2px solid var(--line-3);
  border-top-color: var(--signal);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.file {
  display: none;
}
.picker-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-top: 8px;
}
.hint {
  font-size: 11px;
  color: var(--text-lo);
}
.url-hint {
  margin: 8px 0 0;
  font-size: 11.5px;
  color: var(--text-lo);
}
</style>

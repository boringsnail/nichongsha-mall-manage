<template>
  <div class="page" v-loading="loading">
    <div class="page-hd">
      <span class="rule-title">配置管理</span>
      <span class="label">改动保存后立即生效，无需重启服务</span>
    </div>

    <div class="grid">
      <!-- ─────────────── 公告 ─────────────── -->
      <section class="panel">
        <div class="panel-hd">
          <span class="panel-title">公告内容</span>
          <span class="mono meta">{{ updatedText(ann.updatedAt) }}</span>
        </div>
        <div class="panel-bd">
          <div class="row">
            <div class="row-text">
              <div class="f-label">启用公告</div>
              <div class="f-hint">关闭后小程序首页不再展示，内容仍保留</div>
            </div>
            <el-switch v-model="ann.enabled" />
          </div>

          <div class="field">
            <div class="f-label">标题</div>
            <el-input
              v-model="ann.title"
              :maxlength="40"
              show-word-limit
              placeholder="例如：双十一发货安排"
            />
          </div>

          <div class="field">
            <div class="f-label">内容</div>
            <el-input
              v-model="ann.content"
              type="textarea"
              :rows="5"
              :maxlength="500"
              show-word-limit
              placeholder="写清楚时间、范围和注意事项。换行会原样保留。"
            />
          </div>

          <div class="actions">
            <el-button type="primary" :loading="savingAnn" @click="saveAnn">保存公告</el-button>
            <span class="f-hint">小程序侧通过 <code class="mono">GET /api/announcement</code> 读取</span>
          </div>
        </div>
      </section>

      <!-- ─────────────── 预览 ─────────────── -->
      <aside class="panel">
        <div class="panel-hd">
          <span class="panel-title">小程序预览</span>
          <span class="mono meta">近似效果</span>
        </div>
        <div class="panel-bd">
          <div class="phone">
            <div class="phone-hd">
              <span class="dot-live" />
              <span class="mono">你宠啥</span>
            </div>
            <div v-if="ann.enabled && (ann.title || ann.content)" class="notice">
              <span class="notice-bar" />
              <div class="notice-body">
                <div class="notice-title">{{ ann.title || '公告' }}</div>
                <div class="notice-text">{{ ann.content || '（未填写内容）' }}</div>
              </div>
            </div>
            <div v-else class="notice-empty">公告已关闭或内容为空，首页不展示</div>
            <div class="phone-ph" />
          </div>
        </div>
      </aside>
    </div>

    <!-- ─────────────── 售后规则 ─────────────── -->
    <section class="panel">
      <div class="panel-hd">
        <span class="panel-title">退款自动同意时长</span>
        <span class="mono meta">{{ updatedText(sale.updatedAt) }}</span>
      </div>
      <div class="panel-bd">
        <div class="row">
          <div class="row-text">
            <div class="f-label">超时自动同意退款</div>
            <div class="f-hint">
              关闭时：超时只标红提醒，<strong>永远不会</strong>自动退款，必须你在这里点同意
            </div>
          </div>
          <el-switch v-model="sale.autoApproveEnabled" />
        </div>

        <div class="field">
          <div class="f-label">时长（小时）</div>
          <div class="hours">
            <el-input-number
              v-model="sale.autoApproveHours"
              :min="1"
              :max="720"
              :step="1"
              controls-position="right"
              style="width: 150px"
            />
            <span class="f-hint">即 {{ hoursText }}</span>
            <span class="presets">
              <button
                v-for="h in presets"
                :key="h"
                type="button"
                class="preset"
                :class="{ on: sale.autoApproveHours === h }"
                @click="sale.autoApproveHours = h"
              >
                {{ h }}h
              </button>
            </span>
          </div>
          <div class="f-hint mt">
            这个时长有两个作用：超过它仍未处理 → 列表标红「已超时」；若上方开关打开 → 同时自动同意并退款。
          </div>
        </div>

        <el-alert v-if="sale.autoApproveEnabled" type="warning" :closable="false" show-icon class="warn">
          <template #title>自动退款已开启</template>
          <div class="warn-body">
            售后申请超过 {{ sale.autoApproveHours }} 小时无人处理时，系统会<strong>自动同意并原路退款</strong>，资金一旦退出不可撤回。
            如果只是想「提醒自己别拖」，请把上面的开关关掉。
          </div>
        </el-alert>

        <div class="readonly">
          <div class="ro-item">
            <span class="label">升级提醒</span>
            <span class="ro-v mono">{{ cfg?.env.escalateDays ?? '—' }} 天</span>
            <span class="f-hint">超过后每日汇总提醒一次</span>
          </div>
          <div class="ro-item">
            <span class="label">买家寄回时限</span>
            <span class="ro-v mono">{{ cfg?.env.returnDays ?? '—' }} 天</span>
            <span class="f-hint">到期未寄回自动关闭售后</span>
          </div>
          <div class="ro-item">
            <span class="label">每日提醒时刻</span>
            <span class="ro-v mono">{{ cfg?.env.alertHour ?? '—' }}:00</span>
            <span class="f-hint">业务时区（默认 +08:00）</span>
          </div>
        </div>

        <div class="actions">
          <el-button type="primary" :loading="savingSale" @click="saveSale">保存售后规则</el-button>
          <span class="f-hint">这三项由环境变量控制，如需调整请改服务配置</span>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { ElMessage } from 'element-plus';
import { getAppConfig, saveAppConfig, type AppConfig } from '@/api/config';

const loading = ref(false);
const savingAnn = ref(false);
const savingSale = ref(false);
const cfg = ref<AppConfig | null>(null);

const ann = reactive({ enabled: false, title: '', content: '', updatedAt: null as string | null });
const sale = reactive({ autoApproveEnabled: false, autoApproveHours: 48, updatedAt: null as string | null });

const presets = [24, 48, 72, 168];

const hoursText = computed(() => {
  const h = sale.autoApproveHours || 0;
  if (h >= 24 && h % 24 === 0) return `${h / 24} 天`;
  return `${h} 小时`;
});

function updatedText(iso: string | null): string {
  if (!iso) return '未修改过';
  const d = new Date(iso);
  return `更新于 ${d.toLocaleString('zh-CN', { hour12: false })}`;
}

function fill(data: AppConfig) {
  cfg.value = data;
  ann.enabled = data.announcement.enabled;
  ann.title = data.announcement.title;
  ann.content = data.announcement.content;
  ann.updatedAt = data.announcement.updatedAt;
  sale.autoApproveEnabled = data.afterSale.autoApproveEnabled;
  sale.autoApproveHours = data.afterSale.autoApproveHours;
  sale.updatedAt = data.afterSale.updatedAt;
}

async function load() {
  loading.value = true;
  try {
    fill(await getAppConfig());
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '读取配置失败');
  } finally {
    loading.value = false;
  }
}

async function saveAnn() {
  savingAnn.value = true;
  try {
    fill(
      await saveAppConfig({
        announcement: { enabled: ann.enabled, title: ann.title, content: ann.content },
      }),
    );
    ElMessage.success('公告已保存');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingAnn.value = false;
  }
}

async function saveSale() {
  savingSale.value = true;
  try {
    fill(
      await saveAppConfig({
        afterSale: {
          autoApproveEnabled: sale.autoApproveEnabled,
          autoApproveHours: sale.autoApproveHours,
        },
      }),
    );
    ElMessage.success('售后规则已保存');
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : '保存失败');
  } finally {
    savingSale.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.page-hd {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-bottom: 2px;
}
.page-hd .label {
  margin-left: auto;
}

.grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 320px;
  gap: var(--sp-3);
  align-items: start;
}

.meta {
  font-size: 10.5px;
  color: var(--text-lo);
  letter-spacing: 0.02em;
}

/* 一行「说明 + 开关」 */
.row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: 10px 0 12px;
  border-bottom: 1px solid var(--line-1);
}
.row-text {
  min-width: 0;
}
.f-label {
  font-size: 12.5px;
  color: var(--text-hi);
  font-weight: 500;
}
.f-hint {
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-lo);
  margin-top: 3px;
}
.f-hint.mt {
  margin-top: 8px;
}
.f-hint code {
  font-size: 10.5px;
  padding: 1px 4px;
  border: 1px solid var(--line-2);
  border-radius: 2px;
  color: var(--text-mid);
}

.field {
  padding-top: 14px;
}
.field > .f-label {
  margin-bottom: 6px;
}

.hours {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.presets {
  display: flex;
  gap: 4px;
}
.preset {
  font-family: var(--font-mono);
  font-size: 11px;
  padding: 4px 9px;
  border: 1px solid var(--line-2);
  border-radius: var(--r-1);
  background: transparent;
  color: var(--text-mid);
  cursor: pointer;
  transition: color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease);
}
.preset:hover {
  color: var(--text-hi);
  border-color: var(--line-3);
}
.preset.on {
  color: var(--signal);
  border-color: var(--signal-border);
  background: var(--signal-soft);
}

.warn {
  margin-top: 14px;
}
.warn-body {
  font-size: 11.5px;
  line-height: 1.7;
}

.readonly {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 1px;
  margin-top: 16px;
  background: var(--line-1);
  border: 1px solid var(--line-1);
}
.ro-item {
  background: var(--ink-850);
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.ro-v {
  font-size: 15px;
  color: var(--text-hi);
}

.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--line-1);
}

/* ---------- 小程序预览 ---------- */
.phone {
  border: 1px solid var(--line-2);
  border-radius: 6px;
  background: var(--ink-880);
  padding: 10px;
  min-height: 210px;
}
.phone-hd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 10px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--text-lo);
  padding-bottom: 8px;
  border-bottom: 1px solid var(--line-1);
}
.notice {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  padding: 9px 10px;
  background: var(--amber-soft);
  border: 1px solid var(--amber-border);
  border-radius: 4px;
}
.notice-bar {
  width: 2px;
  flex: none;
  border-radius: 2px;
  background: var(--amber);
}
.notice-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-hi);
}
.notice-text {
  font-size: 11px;
  line-height: 1.65;
  color: var(--text-mid);
  margin-top: 3px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 96px;
  overflow: auto;
}
.notice-empty {
  margin-top: 12px;
  padding: 14px 10px;
  border: 1px dashed var(--line-2);
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-lo);
  text-align: center;
}
.phone-ph {
  margin-top: 10px;
  height: 74px;
  border-radius: 4px;
  background: repeating-linear-gradient(
    135deg,
    var(--line-1) 0 1px,
    transparent 1px 8px
  );
}

@media (max-width: 1180px) {
  .grid {
    grid-template-columns: minmax(0, 1fr);
  }
  .readonly {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

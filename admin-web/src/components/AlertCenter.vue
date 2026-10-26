<template>
  <!-- 强提醒浮层：固定在内容区右上角，不遮挡表格操作列 -->
  <div class="alert-layer" aria-live="assertive">
    <TransitionGroup name="alert">
      <div v-for="item in store.items" :key="item.id" class="alert-card" :class="item.kind">
        <div class="bar" />
        <div class="body">
          <div class="meta">
            <span class="label">{{ item.kind === 'order' ? 'NEW ORDER' : 'AFTER SALE' }}</span>
            <span class="time mono">{{ hhmmss(item.at) }}</span>
          </div>
          <div class="title">{{ item.title }}</div>
          <div class="detail mono">{{ item.detail }}</div>
          <div class="actions">
            <el-button size="small" type="primary" @click="goto(item)">去处理</el-button>
            <el-button size="small" @click="store.dismiss(item.id)">知道了</el-button>
          </div>
        </div>
      </div>
    </TransitionGroup>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from 'vue-router';
import { useAlertStore, type AlertItem } from '@/stores/alerts';

const store = useAlertStore();
const router = useRouter();

function hhmmss(iso: string): string {
  return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
}

function goto(item: AlertItem) {
  router.push(item.to);
  store.dismiss(item.id);
}
</script>

<style scoped>
.alert-layer {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 3000;
  width: 320px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  pointer-events: none;
}
.alert-layer > * {
  pointer-events: auto;
}

.alert-card {
  position: relative;
  display: flex;
  background: var(--ink-820);
  border: 1px solid var(--line-2);
  border-radius: var(--r-1);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.55);
  overflow: hidden;
}
/* 左侧信号条：订单青绿、售后琥珀，扫一眼就能分优先级 */
.bar {
  width: 3px;
  flex: none;
  background: var(--signal);
}
.alert-card.after-sale .bar {
  background: var(--amber);
}
.alert-card.after-sale {
  border-color: var(--amber-border);
}

.body {
  flex: 1;
  min-width: 0;
  padding: 10px 12px 12px;
}

.meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
}
.time {
  font-size: 10px;
  color: var(--text-lo);
  letter-spacing: 0.06em;
}

.title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-hi);
  letter-spacing: 0.02em;
}

.detail {
  margin-top: 3px;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-mid);
  word-break: break-all;
}

.actions {
  display: flex;
  gap: 6px;
  margin-top: 10px;
}

.unlock {
  display: none;
}

/* 入场：从右侧滑入，缓动用 ease-out-quart，不用回弹 */
.alert-enter-active {
  transition: transform var(--dur-2) var(--ease), opacity var(--dur-2) var(--ease);
}
.alert-leave-active {
  transition: transform var(--dur-1) var(--ease), opacity var(--dur-1) var(--ease);
  position: absolute;
  right: 0;
}
.alert-enter-from {
  transform: translateX(16px);
  opacity: 0;
}
.alert-leave-to {
  transform: translateX(16px);
  opacity: 0;
}
</style>

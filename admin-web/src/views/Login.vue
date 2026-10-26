<template>
  <div class="screen grid-backdrop">
    <div class="inner">
    <!-- 左侧：身份与状态，不做营销文案，只交代「你进的是什么系统」 -->
    <div class="brand-side">
      <div class="brand-top">
        <div class="brand-mark">宠</div>
        <div>
          <div class="brand-name">你宠啥</div>
          <div class="label">dispatch console</div>
        </div>
      </div>

      <div class="statement">
        <div class="label">order · aftersale · inventory</div>
        <h1>商家调度台</h1>
        <p>订单、售后、库存三件事在同一块屏幕上闭环。所有需要你动手的单，都会响铃、播报并留在右上角，直到你处理。</p>
      </div>

      <div class="brand-foot">
        <span class="mono">v1.0</span>
        <span class="sep" />
        <span class="mono">微信云托管 · prod</span>
      </div>
    </div>

    <!-- 右侧：登录表单 -->
    <div class="form-side panel">
      <div class="form-head">
        <span class="label">authenticate</span>
        <span class="mono form-code">SIGN IN</span>
      </div>

      <form class="form" @submit.prevent="onSubmit">
        <label class="field">
          <span class="label">用户名</span>
          <el-input
            v-model="form.username"
            size="large"
            placeholder="merchant account"
            autocomplete="username"
            clearable
          />
        </label>

        <label class="field">
          <span class="label">密码</span>
          <el-input
            v-model="form.password"
            type="password"
            size="large"
            placeholder="••••••••"
            autocomplete="current-password"
            show-password
          />
        </label>

        <el-button type="primary" size="large" class="submit" :loading="loading" native-type="submit">
          进入调度台
        </el-button>

        <p class="hint">仅限已授权的商家账号。连续失败会触发风控限流。</p>
      </form>
    </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useRouter } from 'vue-router';
import { ElMessage } from 'element-plus';
import { useAuthStore } from '@/stores/auth';
import { adminLogin } from '@/api/auth';

const router = useRouter();
const auth = useAuthStore();
const loading = ref(false);
const form = reactive({ username: '', password: '' });

async function onSubmit() {
  if (!form.username.trim() || !form.password) {
    ElMessage.warning('请输入用户名和密码');
    return;
  }
  loading.value = true;
  try {
    const data = await adminLogin(form.username.trim(), form.password);
    auth.setAuth(data.token, data.merchant);
    router.replace('/dashboard');
  } catch (e) {
    ElMessage.error(e instanceof Error ? e.message : '登录失败');
  } finally {
    loading.value = false;
  }
}
</script>

<style scoped>
.screen {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 40px clamp(20px, 5vw, 72px);
  background-color: var(--ink-900);
}

/* 定宽内容区：避免两栏被拉得过散，构图更收得住 */
.inner {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 400px;
  align-items: center;
  gap: clamp(40px, 6vw, 88px);
  width: min(1040px, 100%);
}

/* ─────────────── 左：身份区 ─────────────── */
.brand-side {
  display: flex;
  flex-direction: column;
  gap: 56px;
  max-width: 520px;
}

.brand-top {
  display: flex;
  align-items: center;
  gap: 12px;
}
.brand-mark {
  width: 34px;
  height: 34px;
  display: grid;
  place-items: center;
  border: 1px solid rgba(46, 230, 197, 0.5);
  color: var(--signal);
  font-size: 16px;
  font-weight: 600;
  line-height: 1;
}
.brand-name {
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 0.1em;
  color: var(--text-hi);
  line-height: 1.3;
}

.statement h1 {
  margin: 12px 0 14px;
  font-size: clamp(30px, 3.4vw, 42px);
  font-weight: 600;
  letter-spacing: 0.02em;
  line-height: 1.15;
  color: var(--text-hi);
}
/* 标题下压一道信号短线，替代装饰性图标 */
.statement h1::after {
  content: '';
  display: block;
  width: 40px;
  height: 2px;
  margin-top: 18px;
  background: var(--signal);
}
.statement p {
  margin: 0;
  max-width: 430px;
  font-size: 13px;
  line-height: 1.85;
  color: var(--text-mid);
}

.brand-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 10.5px;
  letter-spacing: 0.1em;
  color: var(--text-lo);
}
.sep {
  width: 18px;
  height: 1px;
  background: var(--line-3);
}

/* ─────────────── 右：表单 ─────────────── */
.form-side {
  padding: 0;
  background: var(--ink-850);
  border-color: var(--line-2);
}

.form-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 13px 22px;
  border-bottom: 1px solid var(--line-1);
}
.form-code {
  font-size: 10px;
  letter-spacing: 0.18em;
  color: var(--line-3);
}

.form {
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 26px 22px 24px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 7px;
}

.submit {
  width: 100%;
  margin-top: 4px;
  letter-spacing: 0.14em;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.7;
  color: var(--text-lo);
}

/* 窄屏：收起左侧说明，只留表单，避免两栏挤压 */
@media (max-width: 900px) {
  .inner {
    grid-template-columns: minmax(0, 1fr);
    gap: 32px;
  }
  .brand-side {
    gap: 28px;
  }
  .statement p {
    display: none;
  }
  .brand-foot {
    display: none;
  }
}
</style>

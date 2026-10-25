<template>
  <el-container class="layout">
    <el-aside width="200px" class="aside">
      <div class="logo">你宠啥 · 商家后台</div>
      <el-menu
        :default-active="activePath"
        router
        class="menu"
        background-color="#001529"
        text-color="rgba(255,255,255,0.65)"
        active-text-color="#ffffff"
      >
        <el-menu-item index="/dashboard"><span class="dot" />营业大盘</el-menu-item>
        <el-menu-item index="/products"><span class="dot" />商品管理</el-menu-item>
        <el-menu-item index="/products/import"><span class="dot" />批量导入商品</el-menu-item>
        <el-menu-item index="/categories"><span class="dot" />分类管理</el-menu-item>
        <el-menu-item index="/orders"><span class="dot" />订单管理</el-menu-item>
        <el-menu-item index="/stock"><span class="dot" />库存管理</el-menu-item>
      </el-menu>
    </el-aside>
    <el-container>
      <el-header class="header">
        <span class="page-title">{{ pageTitle }}</span>
        <el-dropdown @command="onCommand">
          <span class="user">{{ merchantName }} <span class="caret">▾</span></span>
          <template #dropdown>
            <el-dropdown-menu>
              <el-dropdown-item command="logout">退出登录</el-dropdown-item>
            </el-dropdown-menu>
          </template>
        </el-dropdown>
      </el-header>
      <el-main class="main">
        <router-view />
      </el-main>
    </el-container>
  </el-container>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();

const activePath = computed(() => route.path);
const pageTitle = computed(() => (route.meta.title as string) || '');
const merchantName = computed(() => auth.merchant?.nickname || auth.merchant?.username || '');

function onCommand(cmd: string) {
  if (cmd === 'logout') {
    auth.logout();
    router.replace('/login');
  }
}
</script>

<style scoped>
.layout {
  height: 100vh;
}
.aside {
  background: #001529;
  overflow-y: auto;
}
.logo {
  height: 60px;
  line-height: 60px;
  text-align: center;
  color: #fff;
  font-size: 15px;
  font-weight: 600;
  letter-spacing: 1px;
}
.menu {
  border-right: none;
}
.menu :deep(.el-menu-item) {
  display: flex;
  align-items: center;
  gap: 8px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
}
.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #fff;
  border-bottom: 1px solid #e5e7eb;
}
.page-title {
  font-size: 16px;
  font-weight: 600;
}
.user {
  cursor: pointer;
  color: #333;
}
.caret {
  font-size: 12px;
  color: #999;
}
.main {
  background: #f5f7fa;
}
</style>

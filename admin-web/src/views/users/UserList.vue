<template>
  <div class="user-list-page">
    <a-card :bordered="false">
      <template #title>用户管理</template>
      <a-space style="margin-bottom: 16px">
        <a-input-search v-model="searchText" placeholder="搜索用户名/手机号" @search="fetchUsers" style="width: 250px" />
        <a-button type="primary" @click="fetchUsers">刷新</a-button>
      </a-space>
      <a-table :data="users" :loading="loading" :pagination="pagination" @page-change="onPageChange">
        <template #columns>
          <a-table-column title="ID" data-field="id" />
          <a-table-column title="用户名" data-field="username" />
          <a-table-column title="手机号" data-field="phone" />
          <a-table-column title="累计消费" data-field="totalSpent" :formatter="(row: any) => `¥${row.totalSpent.toFixed(2)}`" />
          <a-table-column title="订单数" data-field="orderCount" />
          <a-table-column title="注册时间" data-field="createdAt" :formatter="(row: any) => formatDate(row.createdAt)" />
          <a-table-column title="操作" :width="120">
            <template #body="{ row }: any" >
              <a-button size="small" type="primary" @click="viewDetail(row)">详情</a-button>
            </template>
          </a-table-column>
        </template>
      </a-table>
    </a-card>

    <!-- 详情弹窗 -->
    <a-modal v-model:visible="detailVisible" title="用户详情" width="700px">
      <template #footer>
        <a-button @click="detailVisible = false">关闭</a-button>
      </template>
      <div v-if="currentUser" class="user-detail">
        <a-descriptions :column="2" bordered>
          <a-descriptions-item label="ID">{{ currentUser.id }}</a-descriptions-item>
          <a-descriptions-item label="用户名">{{ currentUser.username }}</a-descriptions-item>
          <a-descriptions-item label="手机号">{{ currentUser.phone }}</a-descriptions-item>
          <a-descriptions-item label="邮箱">{{ currentUser.email || '未填写' }}</a-descriptions-item>
          <a-descriptions-item label="累计消费">¥{{ currentUser.totalSpent.toFixed(2) }}</a-descriptions-item>
          <a-descriptions-item label="订单数">{{ currentUser.orderCount }}</a-descriptions-item>
          <a-descriptions-item label="注册时间">{{ formatDate(currentUser.createdAt) }}</a-descriptions-item>
          <a-descriptions-item label="最近登录">{{ formatDate(currentUser.lastLoginAt) }}</a-descriptions-item>
        </a-descriptions>
        <a-divider>最近订单</a-divider>
        <a-table :data="currentUser.recentOrders" :bordered="true" size="small" v-if="currentUser.recentOrders.length">
          <template #columns>
            <a-table-column title="订单号" data-field="orderNo" />
            <a-table-column title="金额" data-field="totalAmount" :formatter="(row: any) => `¥${row.totalAmount.toFixed(2)}`" />
            <a-table-column title="状态" data-field="status" />
            <a-table-column title="下单时间" data-field="createdAt" :formatter="(row: any) => formatDate(row.createdAt)" />
          </template>
        </a-table>
        <a-empty v-else description="暂无订单" />
        <a-divider>收货地址</a-divider>
        <a-table :data="currentUser.addresses" :bordered="true" size="small" v-if="currentUser.addresses.length">
          <template #columns>
            <a-table-column title="联系人" data-field="name" />
            <a-table-column title="电话" data-field="phone" />
            <a-table-column title="地址" data-field="address" />
          </template>
        </a-table>
        <a-empty v-else description="暂无地址" />
      </div>
    </a-modal>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { message } from 'ant-design-vue';
import axios from 'axios';

const users = ref<any[]>([]);
const loading = ref(false);
const searchText = ref('');
const currentPage = ref(1);
const pageSize = ref(10);

const pagination = {
  current: currentPage.value,
  pageSize: pageSize.value,
  total: 0,
  showTotal: (total: number) => `共 ${total} 条`,
};

const detailVisible = ref(false);
const currentUser = ref<any>(null);

const formatDate = (dateStr: string) => {
  return new Date(dateStr).toLocaleString('zh-CN');
};

const fetchUsers = async () => {
  loading.value = true;
  try {
    const res = await axios.get('/api/admin/users', {
      params: { page: currentPage.value, pageSize: pageSize.value, keyword: searchText.value },
    });
    users.value = res.data.users;
    pagination.total = res.data.total;
  } catch (e: any) {
    message.error(e.response?.data?.error || '获取用户列表失败');
  } finally {
    loading.value = false;
  }
};

const onPageChange = (page: number) => {
  currentPage.value = page;
  fetchUsers();
};

const viewDetail = async (user: any) => {
  try {
    const res = await axios.get(`/api/admin/users/${user.id}`);
    currentUser.value = res.data;
    detailVisible.value = true;
  } catch (e: any) {
    message.error(e.response?.data?.error || '获取用户详情失败');
  }
};

onMounted(() => {
  fetchUsers();
});
</script>

<style scoped>
.user-detail {
  max-height: 600px;
  overflow-y: auto;
}
</style>

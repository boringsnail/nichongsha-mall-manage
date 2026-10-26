import { createRouter, createWebHistory } from 'vue-router';
import { useAuthStore } from '@/stores/auth';

const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/login', name: 'login', component: () => import('@/views/Login.vue') },
    {
      path: '/',
      component: () => import('@/views/Layout.vue'),
      redirect: '/dashboard',
      children: [
        { path: 'dashboard', name: 'dashboard', component: () => import('@/views/Dashboard.vue'), meta: { title: '营业大盘' } },
        { path: 'products', name: 'products', component: () => import('@/views/products/ProductList.vue'), meta: { title: '商品管理' } },
        { path: 'products/import', name: 'product-import', component: () => import('@/views/products/ProductImport.vue'), meta: { title: '批量导入商品' } },
        { path: 'products/create', name: 'product-create', component: () => import('@/views/products/ProductEdit.vue'), meta: { title: '商品录入' } },
        { path: 'products/:id/edit', name: 'product-edit', component: () => import('@/views/products/ProductEdit.vue'), meta: { title: '商品编辑' } },
        { path: 'categories', name: 'categories', component: () => import('@/views/CategoryList.vue'), meta: { title: '分类管理' } },
        { path: 'orders', name: 'orders', component: () => import('@/views/orders/OrderList.vue'), meta: { title: '订单管理' } },
        { path: 'after-sales', name: 'after-sales', component: () => import('@/views/afterSales/AfterSaleList.vue'), meta: { title: '售后管理' } },
        { path: 'stock', name: 'stock', component: () => import('@/views/Stock.vue'), meta: { title: '库存管理' } },
        { path: 'users', name: 'users', component: () => import('@/views/users/UserList.vue'), meta: { title: '用户管理' } },
        { path: 'settings', name: 'settings', component: () => import('@/views/Settings.vue'), meta: { title: '配置管理' } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.path !== '/login' && !auth.token) return { path: '/login' };
  return true;
});

export default router;
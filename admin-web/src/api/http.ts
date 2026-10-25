import axios, { type AxiosRequestConfig } from 'axios';

// 统一响应 {code:0,data}; 业务失败 {code,message}; HTTP 401 未登录
export const http = axios.create({
  // 本地：'/api' 走 Vite 代理 → localhost:3000
  // 云端：构建时注入 VITE_API_BASE 指向云托管服务公网地址
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 10000,
});

http.interceptors.request.use((config) => {
  const token = localStorage.getItem('admin_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

http.interceptors.response.use(
  (resp) => {
    const body = resp.data;
    if (body && body.code === 0) return body.data;
    const err = new Error(body?.message || '请求失败');
    (err as { code?: number }).code = body?.code;
    (err as { statusCode?: number }).statusCode = resp.status;
    return Promise.reject(err);
  },
  (error) => {
    const statusCode = error.response?.status;
    const message = error.response?.data?.message || error.message || '网络错误';
    const err = new Error(message);
    (err as { code?: number }).code = error.response?.data?.code || statusCode;
    (err as { statusCode?: number }).statusCode = statusCode;
    if (statusCode === 401) {
      localStorage.removeItem('admin_token');
      localStorage.removeItem('admin_merchant');
      // 用 location 而非 router：api 层不依赖路由实例，避免循环引用
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    }
    return Promise.reject(err);
  }
);

// 拦截器已解包 data，这里只补类型
export const api = {
  get: <T>(url: string, config?: AxiosRequestConfig) => http.get(url, config) as unknown as Promise<T>,
  post: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => http.post(url, data, config) as unknown as Promise<T>,
  put: <T>(url: string, data?: unknown, config?: AxiosRequestConfig) => http.put(url, data, config) as unknown as Promise<T>,
  del: <T>(url: string, config?: AxiosRequestConfig) => http.delete(url, config) as unknown as Promise<T>,
};

import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

// 统一响应 {code:0,data}; 业务失败 {code,message}; HTTP 401 未登录
export const http = axios.create({
  // 本地：'/api' 走 Vite 代理 → localhost:3000
  // 云端：构建时注入 VITE_API_BASE 指向云托管服务公网地址
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  // 微信云托管在「最小实例数 0」时会缩容到零，冷启动实测要 27s+，
  // 原来的 10s 必然超时（表现为「timeout of 10000ms exceeded」+ 列表空白）。
  // 这里放宽到 30s，配合下面的 GET 自动重试兜住偶发的 503。
  timeout: 30000,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可重试的网关类状态码：实例未就绪 / 正在启动 */
const RETRYABLE_STATUS = [502, 503, 504];
/** GET 最多重试 2 次（只对幂等的 GET；POST 绝不自动重试，避免重复发货/重复退款） */
const MAX_RETRY = 2;

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
  async (error: AxiosError<{ message?: string; code?: number }>) => {
    const cfg = error.config as (AxiosRequestConfig & { __retried?: number }) | undefined;
    const statusCode = error.response?.status;
    const method = (cfg?.method ?? 'get').toLowerCase();
    // 没有 response = 超时 / 断网 / 网关直接掐断
    const gatewayDown = !error.response || RETRYABLE_STATUS.includes(statusCode ?? 0);

    if (cfg && method === 'get' && gatewayDown && (cfg.__retried ?? 0) < MAX_RETRY) {
      cfg.__retried = (cfg.__retried ?? 0) + 1;
      await sleep(1200 * cfg.__retried);
      return http.request(cfg);
    }

    // 人话化：把 axios 的 "timeout of 30000ms exceeded" 换成能看懂的提示
    let message = error.response?.data?.message || error.message || '网络错误';
    if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message ?? '')) {
      message = '服务响应超时，可能正在启动，请稍后重试';
    } else if (RETRYABLE_STATUS.includes(statusCode ?? 0)) {
      message = '服务正在启动（云托管冷启动），请稍后重试';
    }

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

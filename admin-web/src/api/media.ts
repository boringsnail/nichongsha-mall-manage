import { api } from './http';

/**
 * 商品图片素材。
 *
 * 商家在手机上录商品时只有相册里的照片，没有「图片直链」。
 * 这里把照片压缩后转 data URL 传给后端，后端存库并回一个可长期缓存的地址。
 *
 * 为什么压缩在前端做：
 * 手机原图动辄 4~8MB，直接传既慢又必然撞后端的 1.5MB 上限；
 * 商品图在列表里最大也就显示 300px，压到 1600px 长边肉眼无差。
 */

export interface UploadedImage {
  id: number;
  url: string;
  path: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
  reused: boolean;
}

/** 长边上限：商品详情页放大看也够，单张通常落在 100~300KB */
const MAX_SIDE = 1600;
/** 后端硬上限（1.5MB），留一点余量避免边界抖动 */
const SOFT_LIMIT = 1_200_000;

/** 把 File 画进 canvas 再导出 JPEG。PNG 透明区域铺白底，否则会变黑 */
async function compress(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('当前设备不支持图片处理');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();

  // 逐步降质：多数图片第一次就够，大图最多再压两轮
  let quality = 0.82;
  let dataUrl = canvas.toDataURL('image/jpeg', quality);
  while (dataUrl.length * 0.75 > SOFT_LIMIT && quality > 0.5) {
    quality -= 0.12;
    dataUrl = canvas.toDataURL('image/jpeg', quality);
  }
  return { dataUrl, width: w, height: h };
}

/** 上传一张本地图片，返回后端地址 */
export async function uploadImage(file: File): Promise<UploadedImage> {
  if (!file.type.startsWith('image/')) throw new Error('请选择图片文件');
  const { dataUrl, width, height } = await compress(file);
  return api.post<UploadedImage>('/admin/media', { dataUrl, width, height });
}

/**
 * 把接口里存的图片地址补成可直接放进 <img src> 的形式。
 *
 * 数据库里可能有两种值：
 *  - 老的绝对地址（美团图床等）→ 原样返回
 *  - 新上传的相对路径 /api/media/12 → 补上接口基址
 *    这一步在 App 里是必须的：WebView 的页面源是 https://localhost，
 *    相对路径会指向 App 自己而不是后端。
 */
export function mediaSrc(url?: string | null): string {
  if (!url) return '';
  if (!url.startsWith('/api/')) return url;
  const base = import.meta.env.VITE_API_BASE || '/api';
  return base.replace(/\/api\/?$/, '') + url;
}

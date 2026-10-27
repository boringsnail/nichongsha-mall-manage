import { createHash } from 'node:crypto';
import { prisma } from '../db.js';
import { badRequest, notFound } from '../utils/HttpError.js';

/**
 * 商品图片素材。
 *
 * 商家在手机上录商品时没有「图片直链」这个概念 —— 他手机相册里只有照片。
 * 所以后台必须能直接收图。这里把图片存进数据库（LONGBLOB），由 /api/media/:id 回图：
 * 云托管容器是无状态的，本地磁盘重启就丢；接对象存储又要额外配桶和密钥。
 * 商品图是唯一需要落盘的素材，且前端已压到 ≤1600px / ≤1.2MB，存库完全够用。
 *
 * 不记凭证、不记上传人：图片本身是商品公开素材，没有敏感性。
 */

/** 只收这几种位图。SVG 一律拒绝：内联脚本在 <img> 里不执行，但下载直开可以，没必要冒这个风险 */
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** 单张上限 1.5MB（base64 解码后的字节数）。前端会先压到 ~150KB，这里是兜底 */
export const MEDIA_MAX_BYTES = 1_500_000;

const DATA_URL_RE = /^data:([\w/+.-]+);base64,([A-Za-z0-9+/=\s]+)$/;

export interface MediaAssetBrief {
  id: number;
  /** 绝对地址：直接存进 Product.coverImage，小程序 <image> 拿到就能用 */
  url: string;
  /** 相对路径：域名换了 / 本地开发时前端可以自己拼基址 */
  path: string;
  mime: string;
  byteSize: number;
  width: number;
  height: number;
}

/** 前端传入的 data URL → 落库。同 sha256 直接复用，不重复占空间 */
export async function saveImage(
  input: { dataUrl: string; width?: number; height?: number },
  /**
   * 请求来源，用来拼绝对地址。
   * 必须给绝对地址：这张图会被存进 Product.coverImage，小程序端直接 <image src> 使用，
   * 存相对路径小程序会解析成自己的包内路径，图就裂了。
   */
  origin: string,
): Promise<MediaAssetBrief & { reused: boolean }> {
  const m = DATA_URL_RE.exec(input.dataUrl.trim());
  if (!m) throw badRequest('MEDIA_BAD_DATA_URL', '图片格式不正确，需要 data:image/...;base64 形式');
  const mime = m[1].toLowerCase();
  if (!ALLOWED_MIME.has(mime)) {
    throw badRequest('MEDIA_BAD_MIME', `不支持的图片类型 ${mime}，请用 JPG / PNG / WebP`);
  }

  // 去掉换行再解 base64（有些客户端会按 76 字符折行）
  const base64 = m[2].replace(/\s+/g, '');
  const data = Buffer.from(base64, 'base64');
  if (!data.length) throw badRequest('MEDIA_EMPTY', '图片内容为空');
  if (data.length > MEDIA_MAX_BYTES) {
    throw badRequest(
      'MEDIA_TOO_LARGE',
      `图片 ${(data.length / 1024 / 1024).toFixed(1)}MB，超过 ${MEDIA_MAX_BYTES / 1024 / 1024}MB 上限`,
    );
  }

  const sha256 = createHash('sha256').update(data).digest('hex');
  const existing = await prisma.mediaAsset.findUnique({ where: { sha256 }, select: { id: true } });
  const base = origin.replace(/\/+$/, '');
  if (existing) {
    return {
      id: existing.id,
      url: `${base}/api/media/${existing.id}`,
      path: `/api/media/${existing.id}`,
      mime,
      byteSize: data.length,
      width: input.width ?? 0,
      height: input.height ?? 0,
      reused: true,
    };
  }

  const row = await prisma.mediaAsset.create({
    data: {
      mime,
      byteSize: data.length,
      width: Math.max(0, Math.round(input.width ?? 0)),
      height: Math.max(0, Math.round(input.height ?? 0)),
      sha256,
      // Prisma 的 Bytes 在 MySQL 上映射 LONGBLOB；Buffer 会被原样写入
      data,
    },
    select: { id: true, mime: true, byteSize: true, width: true, height: true },
  });

  return { ...row, url: `${base}/api/media/${row.id}`, path: `/api/media/${row.id}`, reused: false };
}

/** 读图：只取二进制与 mime，不带 sha256 之类无关字段 */
export async function readImage(id: number): Promise<{ mime: string; data: Buffer }> {
  const row = await prisma.mediaAsset.findUnique({
    where: { id },
    select: { mime: true, data: true },
  });
  if (!row) throw notFound('图片不存在或已被删除');
  // Prisma 在 MySQL 上把 BLOB 读成 Buffer，但类型声明是 Uint8Array，统一转一下
  return { mime: row.mime, data: Buffer.from(row.data) };
}

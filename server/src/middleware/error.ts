import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/HttpError.js';

// 未匹配路由 → 404
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ code: 'NOT_FOUND', message: '资源不存在' });
}

// 全局错误兜底
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    return res.status(err.status).json({ code: err.code, message: err.message });
  }
  // body-parser 的 JSON 解析失败：SyntaxError + type=entity.parse.failed，应给 400 而非 500
  const raw = err as { type?: string; status?: number };
  if (raw.type === 'entity.parse.failed') {
    return res.status(400).json({ code: 'PARAM_ERROR', message: '请求体不是合法 JSON' });
  }
  if (raw.type === 'entity.too.large') {
    return res.status(413).json({ code: 'PAYLOAD_TOO_LARGE', message: '请求体过大' });
  }
  console.error('[error]', err);
  res.status(500).json({ code: 'SERVER_ERROR', message: '服务器开小差了' });
}
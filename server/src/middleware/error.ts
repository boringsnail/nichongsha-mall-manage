import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../utils/HttpError.js';

// 未匹配路由 → 404
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ code: 'NOT_FOUND', message: '资源不存在' });
}

// 全局错误兜底
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction) {
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
  // 管控台是自建内部系统：把真实原因带进 message，前端 toast 直接可见，免去翻容器日志；
  // C 端接口仍只给通用文案，不向消费者暴露内部实现细节。
  const detail = req.path.startsWith('/api/admin') ? describeError(err) : '';
  res.status(500).json({
    code: 'SERVER_ERROR',
    message: detail ? `服务器开小差了（${detail}）` : '服务器开小差了',
  });
}

/**
 * 把未预期异常压缩成一句可读原因。
 * 唯一需要脱敏的是连接串里的密码（Prisma 的 P1000/P1001 报错会带 host 甚至账号名）。
 */
export function describeError(err: unknown): string {
  const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  const masked = raw.replace(/(\/\/[^:@/\s]+:)[^@/\s]+(@)/g, '$1***$2');
  return masked.length > 200 ? `${masked.slice(0, 200)}…` : masked;
}
import type { Request, Response, NextFunction } from 'express';
import type { ZodTypeAny } from 'zod';
import { badRequest } from '../utils/HttpError.js';

// zod 校验中间件：body/query/params 三通道
export function validate(schemas: { body?: ZodTypeAny; query?: ZodTypeAny; params?: ZodTypeAny }) {
  return (req: Request, _res: Response, next: NextFunction) => {
    try {
      if (schemas.body) req.body = schemas.body.parse(req.body);
      if (schemas.query) req.query = schemas.query.parse(req.query);
      if (schemas.params) req.params = schemas.params.parse(req.params);
      next();
    } catch (e) {
      const zodErr = e as { issues?: Array<{ path: (string | number)[]; message: string }> };
      const issue = zodErr.issues?.[0];
      const msg = issue ? `参数 ${issue.path.join('.')}：${issue.message}` : '参数错误';
      next(badRequest('PARAM_ERROR', msg));
    }
  };
}
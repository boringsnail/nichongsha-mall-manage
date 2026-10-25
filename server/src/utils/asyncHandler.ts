import type { Request, Response, NextFunction, RequestHandler } from 'express';

// Express4 异步处理器包装器：把 async 函数的 reject 交给 next(err)
export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };
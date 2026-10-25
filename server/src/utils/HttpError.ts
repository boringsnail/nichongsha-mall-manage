// 业务异常：携带 HTTP 状态码与语义错误码，由 errorHandler 统一序列化
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (code = 'PARAM_ERROR', message = '参数错误') => new HttpError(400, code, message);
export const notFound = (message = '资源不存在') => new HttpError(404, 'NOT_FOUND', message);
export const conflict = (code = 'CONFLICT', message = '冲突') => new HttpError(409, code, message);
export const forbidden = (message = '无权限') => new HttpError(403, 'FORBIDDEN', message);
export const unauthorized = (message = '未登录') => new HttpError(401, 'NOT_AUTH', message);
export const stockNotEnough = (message = '库存不足') => new HttpError(412, 'STOCK_NOT_ENOUGH', message);
export const orderIllegal = (message = '订单状态不允许该操作') => new HttpError(409, 'ORDER_STATUS_ILLEGAL', message);
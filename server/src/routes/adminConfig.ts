import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { CONFIG_LIMITS, getAppConfig, updateAppConfig } from '../services/configService.js';

export const adminConfigRouter = Router();

adminConfigRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ code: 0, data: await getAppConfig() });
  }),
);

// 部分更新：只传要改的字段，没传的保持原值。
// 全部 optional 是刻意的 —— 配置页有两块（公告 / 售后），各自单独保存时不该覆盖另一块。
const patchSchema = validate({
  body: z
    .object({
      announcement: z
        .object({
          enabled: z.boolean().optional(),
          title: z.string().trim().max(CONFIG_LIMITS.titleMax).optional(),
          content: z.string().trim().max(CONFIG_LIMITS.contentMax).optional(),
        })
        .optional(),
      afterSale: z
        .object({
          autoApproveEnabled: z.boolean().optional(),
          autoApproveHours: z
            .number()
            .int()
            .min(CONFIG_LIMITS.hoursMin)
            .max(CONFIG_LIMITS.hoursMax)
            .optional(),
        })
        .optional(),
    })
    .refine((v) => v.announcement || v.afterSale, { message: '没有需要保存的配置' }),
});

adminConfigRouter.put(
  '/',
  patchSchema,
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await updateAppConfig(req.body) });
  }),
);

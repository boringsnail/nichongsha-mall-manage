import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { listAdminUsers, getAdminUserDetail } from '../services/adminUserService.js';

export const adminUsersRouter = Router();

adminUsersRouter.get(
  '/',
  validate({
    query: z.object({
      keyword: z.string().max(64).optional(),
      sort: z.enum(['recent', 'spend']).optional(),
      page: z.coerce.number().int().positive().optional(),
      size: z.coerce.number().int().positive().max(100).optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await listAdminUsers(req.query as never) });
  }),
);

adminUsersRouter.get(
  '/:id',
  validate({ params: z.object({ id: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req, res) => {
    res.json({ code: 0, data: await getAdminUserDetail(Number(req.params.id)) });
  }),
);

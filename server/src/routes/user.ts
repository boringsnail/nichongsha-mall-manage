import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import { validate } from '../middleware/validate.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getProfile,
  updateProfile,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
  setDefaultAddress,
} from '../services/userService.js';

export const userRouter = Router();

// requireAuth 已注入 req.auth（UserPayload），此处补类型
const uid = (req: Request) => (req as unknown as { auth: { uid: number } }).auth.uid;

const profileSchema = validate({
  body: z.object({
    nickname: z.string().min(1).optional(),
    avatarUrl: z.string().min(1).optional(),
    phone: z.string().min(5).max(20).optional(),
  }),
});

const addressSchema = validate({
  body: z.object({
    receiverName: z.string().min(1),
    phone: z.string().min(5).max(20),
    province: z.string().min(1),
    city: z.string().min(1),
    district: z.string().min(1),
    detail: z.string().min(1),
    isDefault: z.boolean().optional(),
  }),
});

const addressPartialSchema = validate({
  body: z.object({
    receiverName: z.string().min(1).optional(),
    phone: z.string().min(5).max(20).optional(),
    province: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    district: z.string().min(1).optional(),
    detail: z.string().min(1).optional(),
    isDefault: z.boolean().optional(),
  }),
});

const idParam = validate({ params: z.object({ id: z.coerce.number().int().positive() }) });

userRouter.get('/profile', asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await getProfile(uid(req)) });
}));

userRouter.put('/profile', profileSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await updateProfile(uid(req), req.body) });
}));

userRouter.get('/addresses', asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await listAddresses(uid(req)) });
}));

userRouter.post('/addresses', addressSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await createAddress(uid(req), req.body) });
}));

userRouter.put('/addresses/:id', idParam, addressPartialSchema, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await updateAddress(uid(req), Number(req.params.id), req.body) });
}));

userRouter.delete('/addresses/:id', idParam, asyncHandler(async (req, res) => {
  await deleteAddress(uid(req), Number(req.params.id));
  res.json({ code: 0, data: { id: Number(req.params.id) } });
}));

userRouter.put('/addresses/:id/default', idParam, asyncHandler(async (req, res) => {
  res.json({ code: 0, data: await setDefaultAddress(uid(req), Number(req.params.id)) });
}));

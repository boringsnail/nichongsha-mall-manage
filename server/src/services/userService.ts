import { prisma } from '../db.js';
import { notFound } from '../utils/HttpError.js';

export async function getProfile(uid: number) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: uid } });
  return { id: user.id, openid: user.openid, nickname: user.nickname, avatarUrl: user.avatarUrl, phone: user.phone };
}

export async function updateProfile(uid: number, data: { nickname?: string; avatarUrl?: string; phone?: string }) {
  return prisma.user.update({
    where: { id: uid },
    data: {
      ...(data.nickname != null ? { nickname: data.nickname } : {}),
      ...(data.avatarUrl != null ? { avatarUrl: data.avatarUrl } : {}),
      ...(data.phone != null ? { phone: data.phone } : {}),
    },
  });
}

export interface AddressInput {
  receiverName: string;
  phone: string;
  province: string;
  city: string;
  district: string;
  detail: string;
  isDefault?: boolean;
}

// 默认地址在前，其余按创建时间倒序
export async function listAddresses(uid: number) {
  return prisma.address.findMany({
    where: { userId: uid },
    orderBy: [{ isDefault: 'desc' }, { id: 'desc' }],
  });
}

// 首个地址自动默认；显式 isDefault:true 时抢占默认（解下其他地址）
export async function createAddress(uid: number, data: AddressInput) {
  return prisma.$transaction(async (tx) => {
    const wantsDefault = data.isDefault === true;
    if (wantsDefault) await tx.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
    const count = await tx.address.count({ where: { userId: uid } });
    return tx.address.create({ data: { ...data, userId: uid, isDefault: wantsDefault || count === 0 } });
  });
}

async function ownedAddress(uid: number, id: number) {
  const address = await prisma.address.findUnique({ where: { id } });
  if (!address || address.userId !== uid) throw notFound('地址不存在');
  return address;
}

export async function updateAddress(uid: number, id: number, data: Partial<AddressInput>) {
  await ownedAddress(uid, id);
  return prisma.$transaction(async (tx) => {
    if (data.isDefault === true) {
      await tx.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
    }
    return tx.address.update({ where: { id }, data });
  });
}

export async function deleteAddress(uid: number, id: number) {
  await ownedAddress(uid, id);
  return prisma.address.delete({ where: { id } });
}

// 切换默认：事务内先把该用户全部复位，再置目标地址为默认
export async function setDefaultAddress(uid: number, id: number) {
  await ownedAddress(uid, id);
  return prisma.$transaction(async (tx) => {
    await tx.address.updateMany({ where: { userId: uid }, data: { isDefault: false } });
    return tx.address.update({ where: { id }, data: { isDefault: true } });
  });
}

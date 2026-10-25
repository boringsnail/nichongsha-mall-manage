/** 分 → 元（展示用），19900 → '199.00' */
export function fenToYuan(fen: number): string {
  return (fen / 100).toFixed(2);
}

/** 元 → 分（提交用），'199.00' → 19900 */
export function yuanToFen(yuan: number | string): number {
  return Math.round(Number(yuan) * 100);
}

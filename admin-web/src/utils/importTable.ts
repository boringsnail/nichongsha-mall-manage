// 商品导入的「表格 → 行对象」解析：零依赖，支持 CSV / TSV（Excel、WPS 直接粘贴或另存）。
// 之所以不引入 xlsx 依赖：npm 上的 xlsx@0.18.5 带已知 CVE，而 Excel 另存为 CSV 只多一步。

export interface ImportRowInput {
  rowNo?: number;
  name?: string;
  subtitle?: string;
  categoryName?: string;
  specName?: string;
  price?: string | number;
  stock?: string | number;
  coverImage?: string;
  images?: string;
  description?: string;
}

type Field = keyof ImportRowInput;

// 表头别名：美团后台导出、人工整理、英文表头都能认
const FIELD_ALIASES: Array<{ field: Field; aliases: string[] }> = [
  { field: 'name', aliases: ['商品名称', '商品名', '品名', '名称', '商品', 'name'] },
  { field: 'subtitle', aliases: ['副标题', '卖点', '宣传语', 'subtitle'] },
  { field: 'categoryName', aliases: ['分类', '分类名称', '类目', 'category', 'categoryname'] },
  { field: 'specName', aliases: ['规格名称', '规格名', '规格', 'specname', 'spec', 'sku'] },
  { field: 'price', aliases: ['价格(元)', '价格', '单价', '售价', 'price'] },
  { field: 'stock', aliases: ['库存', '数量', '库存数量', 'stock'] },
  { field: 'coverImage', aliases: ['封面图url', '封面图', '主图', '主图url', '图片', 'coverimage'] },
  { field: 'images', aliases: ['详情图url(逗号分隔)', '详情图url', '详情图', '轮播图', 'images'] },
  { field: 'description', aliases: ['商品描述', '商品详情', '描述', '详情', 'description'] },
];

/** 去掉空白/全角括号/BOM 后小写，便于宽松匹配表头 */
function normalizeHeader(raw: string): string {
  return raw
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u3000]/g, '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/[：:]/g, '')
    .toLowerCase();
}

function matchField(header: string): Field | null {
  const n = normalizeHeader(header);
  if (!n) return null;
  for (const { field, aliases } of FIELD_ALIASES) {
    if (aliases.includes(n)) return field;
  }
  // 前缀兜底：容忍「价格（元/份）」「库存(可售)」这类带后缀的表头
  if (n.startsWith('价格') || n.startsWith('单价') || n.startsWith('售价')) return 'price';
  if (n.startsWith('库存')) return 'stock';
  if (n.startsWith('封面') || n.startsWith('主图')) return 'coverImage';
  if (n.startsWith('详情图') || n.startsWith('轮播')) return 'images';
  if (n.startsWith('商品名称') || n.startsWith('商品名')) return 'name';
  if (n.startsWith('分类') || n.startsWith('类目')) return 'categoryName';
  if (n.startsWith('规格')) return 'specName';
  if (n.startsWith('副标题') || n.startsWith('卖点')) return 'subtitle';
  return null;
}

/** 文件解码：优先 UTF-8（带 BOM 识别），失败回退 GBK（中文 Excel 另存 CSV 的默认编码） */
export async function decodeFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(buf);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    try {
      return new TextDecoder('gbk').decode(buf);
    } catch {
      return new TextDecoder('utf-8').decode(buf);
    }
  }
}

/** 解析 CSV / TSV，自动识别分隔符，支持引号包裹与引号内换行 */
export function parseDelimited(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const firstLine = clean.split('\n')[0] ?? '';
  const tabs = (firstLine.match(/\t/g) ?? []).length;
  const commas = (firstLine.match(/,/g) ?? []).length;
  const delim = tabs >= commas && tabs > 0 ? '\t' : ',';

  const out: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      out.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  out.push(row);

  // 丢掉整行空白（Excel 末尾常带空行）
  return out.filter((r) => r.some((c) => c.trim() !== ''));
}

export interface ParseResult {
  rows: ImportRowInput[];
  headers: string[];
  unmappedHeaders: string[];
  error?: string;
}

/** 表头驱动解析：任意列顺序、缺失列忽略、多余列提示 */
export function matrixToRows(matrix: string[][]): ParseResult {
  if (!matrix.length) return { rows: [], headers: [], unmappedHeaders: [], error: '文件内容为空' };

  const headerRow = matrix[0];
  const fieldByCol: (Field | null)[] = headerRow.map(matchField);
  const headers = headerRow.map((h) => h.trim());
  const unmappedHeaders = headers.filter((h, i) => h && !fieldByCol[i]);

  const present = new Set(fieldByCol.filter(Boolean) as Field[]);
  const missing = (['name', 'categoryName', 'specName', 'price'] as Field[]).filter((f) => !present.has(f));
  if (missing.length) {
    const label: Record<string, string> = {
      name: '商品名称',
      categoryName: '分类',
      specName: '规格名称',
      price: '价格',
    };
    return {
      rows: [],
      headers,
      unmappedHeaders,
      error: `未识别到必需列：${missing.map((f) => label[f]).join('、')}。请使用模板表头，或点「下载模板」查看列名。`,
    };
  }

  const rows: ImportRowInput[] = [];
  for (let r = 1; r < matrix.length; r += 1) {
    const src = matrix[r];
    const row: ImportRowInput = { rowNo: r + 1 }; // 表头占第 1 行 → 源文件行号
    const target = row as Record<string, unknown>;
    fieldByCol.forEach((field, c) => {
      if (!field) return;
      const value = (src[c] ?? '').trim();
      if (value === '') return;
      target[field] = value;
    });
    // 整行都空（例如只填了未识别列）→ 跳过
    if (Object.keys(row).length > 1) rows.push(row);
  }

  if (!rows.length) return { rows: [], headers, unmappedHeaders, error: '表头之下没有数据行' };
  return { rows, headers, unmappedHeaders };
}

/** 生成 CSV 模板（带 BOM，Excel 打开不乱码） */
export function buildTemplateCsv(headers: readonly string[], sample: string[][]): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [headers.map(esc).join(','), ...sample.map((r) => r.map(esc).join(','))];
  return '\uFEFF' + lines.join('\r\n');
}

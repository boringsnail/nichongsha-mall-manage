import 'dotenv/config';

// 环境配置：所有配置集中于此，变量名与 .env / 云托管控制台一一对应。
//
// 数据库连接的解析规则（命中即停）：
//   1. DATABASE_URL=mysql://user:pass@host:3306/db —— 完整连接串，原样使用
//   2. 主机地址：DB_HOST + DB_PORT → DATABASE_URL=host:port → MYSQL_ADDRESS=host:port
//      （MYSQL_ADDRESS 是云托管/CloudBase 绑定内置 MySQL 时自动注入的变量）
//   3. 凭据：DB_USER / DB_PASS，其次云托管注入的 MYSQL_USERNAME / MYSQL_PASSWORD
//   4. 库名：DB_NAME，其次 MYSQL_DATABASE，默认 nichongsha
//
// 任何一项配错都会在启动时打印 [fatal] 并退出，不会带着半截配置跑起来；
// 能继续跑但有风险的情况（新旧变量并存、密码首尾带空白等）走 warnings。

type EnvLike = Record<string, string | undefined>;

const devMode = process.env.NODE_ENV !== 'production';
const jwtSecret = process.env.JWT_SECRET ?? 'dev-secret-change-me';
// 控制台粘贴的环境变量常带首尾空白/换行，会污染 code2Session 的 URL，这里统一 trim
const wxAppid = (process.env.WX_APPID ?? '').trim();
const wxSecret = (process.env.WX_APPSECRET ?? '').trim();

if (wxAppid && !/^wx[0-9a-f]{16}$/i.test(wxAppid)) {
  console.warn(`[warn] WX_APPID 形状可疑（应为 wx + 16 位十六进制，实长 ${wxAppid.length}），请检查是否粘贴了多余字符`);
}
if (wxSecret && !/^[0-9a-f]{32}$/i.test(wxSecret)) {
  console.warn(`[warn] WX_APPSECRET 形状可疑（应为 32 位十六进制，实长 ${wxSecret.length}），请检查是否粘贴了多余字符`);
}

// ---------- JWT_EXPIRES_IN ----------
// 控制台粘贴的环境变量常被自动加上引号（`"7d"`）或带首尾空白/换行，中文单位（`7天`）也很常见。
// jsonwebtoken 遇到这类值会在 **签发 token 时** 抛
//   `"expiresIn" should be a number of seconds or string representing a timespan`
// 表现为「账号密码都对了却返回 500 / 服务器开小差了」——极难自查，故在配置层直接清洗 + 校验，
// 不合法就回落默认值并告警，绝不让它把登录流程打挂。
const JWT_EXPIRES_IN_DEFAULT = '7d';
/** 与 jsonwebtoken 依赖的 ms 库一致的时长写法（数字单位、允许中间一个空格） */
const JWT_EXPIRES_IN_PATTERN =
  /^\d+(\.\d+)?\s*(ms|msecs?|milliseconds?|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?|y|yrs?|years?)$/i;

function resolveJwtExpiresIn(raw: string | undefined): string {
  if (raw === undefined) return JWT_EXPIRES_IN_DEFAULT;
  // 去掉成对包裹的引号（含反引号）与首尾空白
  let value = raw.trim();
  if (value.length >= 2) {
    const head = value[0];
    if ((head === '"' || head === "'" || head === '`') && value.endsWith(head)) {
      value = value.slice(1, -1).trim();
    }
  }
  if (!value) {
    console.warn(`[warn] JWT_EXPIRES_IN 为空（原始值「${raw}」），已回落为 ${JWT_EXPIRES_IN_DEFAULT}`);
    return JWT_EXPIRES_IN_DEFAULT;
  }
  // 纯数字：保持原样（jsonwebtoken 的数字语义），不在这里改语义，避免改变既有部署行为
  if (/^\d+$/.test(value)) return value;
  if (JWT_EXPIRES_IN_PATTERN.test(value)) return value;
  console.warn(
    `[warn] JWT_EXPIRES_IN 不合法（原始值「${raw}」），已回落为 ${JWT_EXPIRES_IN_DEFAULT}；` +
      '合法写法如 7d / 12h / 30m，不要带引号、不要用中文单位',
  );
  return JWT_EXPIRES_IN_DEFAULT;
}

const jwtExpiresIn = resolveJwtExpiresIn(process.env.JWT_EXPIRES_IN);

const DEFAULT_DATABASE = 'nichongsha';

const CONFIG_HINT =
  '请在云托管控制台「服务设置 → 环境变量」配置其一：' +
  '① DATABASE_URL 完整串（mysql://user:pass@host:3306/db）；' +
  '② DATABASE_URL=host:port（或 DB_HOST/DB_PORT）+ DB_USER/DB_PASS；' +
  '③ 绑定云托管内置 MySQL 时用自动注入的 MYSQL_ADDRESS + MYSQL_USERNAME/MYSQL_PASSWORD。';

/** 配置来源，排障时一眼看出用的是哪一组变量 */
export type DatabaseSource =
  | 'DATABASE_URL(mysql://)'
  | 'DB_HOST+DB_PORT'
  | 'DATABASE_URL(host:port)'
  | 'MYSQL_ADDRESS';

export interface DatabaseResolution {
  url: string;
  source: DatabaseSource;
  username: string;
  /** 库名 */
  database: string;
  /** 不含账号密码的连接目标（host:port/db） */
  target: string;
  warnings: string[];
}

/** 取第一个「已配置且非空」的变量值（去掉首尾空白） */
function firstValue(source: EnvLike, names: string[]): string | undefined {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** 密码不做 trim（可能含合法空格），仅把「未配置 / 空串」视为缺失 */
function firstSecret(source: EnvLike, names: string[]): { name: string; value: string } | undefined {
  for (const name of names) {
    const value = source[name];
    if (value !== undefined && value !== '') return { name, value };
  }
  return undefined;
}

function normalizePort(raw: string, label: string): string {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} 端口无效：${raw}（应为 1-65535 的整数）`);
  }
  return String(port);
}

/**
 * 解析 host:port。用 URL 解析器是为了顺带兼容 IPv6（[fd00::1]:3306）。
 * 注意：非 http(s) 协议的 URL，pathname 可能是空串而不是 '/'，
 * 例如 new URL('mysql://10.0.0.1:3306').pathname === ''，
 * 所以这里不能要求 pathname === '/'，否则 host:port 形式会被误判为非法。
 */
function parseHostPort(raw: string, label: string): { hostname: string; port: string } {
  let endpoint: URL;
  try {
    endpoint = new URL(`mysql://${raw}`);
  } catch {
    throw new Error(`${label} 主机地址格式无效，应为 host:port，实际为「${raw}」`);
  }
  const pathnameOk = endpoint.pathname === '' || endpoint.pathname === '/';
  if (endpoint.protocol !== 'mysql:' || !endpoint.hostname || !endpoint.port || !pathnameOk) {
    throw new Error(`${label} 主机地址格式无效，应为 host:port，实际为「${raw}」`);
  }
  return { hostname: endpoint.hostname, port: normalizePort(endpoint.port, label) };
}

/**
 * 从解析结果拼出 Prisma 需要的完整 MySQL URL。
 *
 * 这里**不能**用 `url.username = ...` / `url.password = ...` 赋值：
 * WHATWG URL 规范的 userinfo 百分号编码集不含 `%`，字面 `%` 会原样留在串里，
 * 消费方（Prisma/MySQL 驱动）再解码一次就会把 `%25x` 变成 `%x`。
 * 实测密码含 `%` 时必然 P1000 认证失败，所以这里显式 encodeURIComponent。
 */
function buildDatabaseUrl(
  endpoint: { hostname: string; port: string },
  username: string,
  password: string,
  database: string,
): string {
  // URL 解析器要求 IPv6 主机名带方括号。
  const hostname = endpoint.hostname.includes(':') && !endpoint.hostname.startsWith('[')
    ? `[${endpoint.hostname}]`
    : endpoint.hostname;
  const userinfo = `${encodeURIComponent(username)}:${encodeURIComponent(password)}`;
  return `mysql://${userinfo}@${hostname}:${endpoint.port}/${encodeURIComponent(database)}`;
}

/** 去掉账号密码后的连接目标，用于启动日志（不泄露凭据） */
function describeTarget(url: string): string {
  const matched = /^mysql:\/\/[^@]*@(.+)$/i.exec(url);
  return matched ? matched[1] : '(无法解析的数据库地址)';
}

/**
 * 解析数据库配置（含来源与告警）。导出以便单测直接覆盖各种环境变量组合。
 * @throws 配置缺失或非法时抛出带修复提示的错误
 */
export function resolveDatabaseConfig(source: EnvLike = process.env): DatabaseResolution {
  const warnings: string[] = [];
  const configuredUrl = firstValue(source, ['DATABASE_URL']);

  // 1. 完整连接串优先
  if (configuredUrl && /^mysql:\/\//i.test(configuredUrl)) {
    const ignoredNames = ['DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'MYSQL_ADDRESS', 'MYSQL_USERNAME', 'MYSQL_PASSWORD']
      .filter((name) => firstValue(source, [name]) !== undefined);
    if (ignoredNames.length) {
      warnings.push(
        `DATABASE_URL 是完整连接串，账号密码以串内为准，已忽略同时存在的 ${ignoredNames.join('/')}；` +
        '若认证失败，先检查 DATABASE_URL 里是否残留旧密码。',
      );
    }
    let parsed: URL | undefined;
    try {
      parsed = new URL(configuredUrl);
    } catch {
      parsed = undefined;
    }
    return {
      url: configuredUrl,
      source: 'DATABASE_URL(mysql://)',
      username: parsed ? decodeURIComponent(parsed.username) : '(串内)',
      database: parsed ? decodeURIComponent(parsed.pathname.replace(/^\//, '')) : '(串内)',
      target: describeTarget(configuredUrl),
      warnings,
    };
  }
  // 其它协议（postgres:// 等）直接拒绝，避免把错误配置传到 Prisma 才报错
  if (configuredUrl && /^[a-z][a-z\d+.-]*:\/\//i.test(configuredUrl)) {
    throw new Error('DATABASE_URL 必须是 mysql:// 完整连接串，或只写主机地址 host:port');
  }

  // 2. 主机 + 端口
  const configuredHost = firstValue(source, ['DB_HOST']);
  const configuredPort = firstValue(source, ['DB_PORT']);
  const mysqlAddress = firstValue(source, ['MYSQL_ADDRESS']);

  let endpoint: { hostname: string; port: string };
  let sourceLabel: DatabaseSource;
  if (configuredHost || configuredPort) {
    // 拆分变量优先：云托管控制台里单独改 host/port 更常见
    if (!configuredHost || !configuredPort) throw new Error('请同时配置 DB_HOST 和 DB_PORT');
    endpoint = { hostname: configuredHost, port: normalizePort(configuredPort, 'DB_PORT') };
    sourceLabel = 'DB_HOST+DB_PORT';
  } else if (configuredUrl) {
    endpoint = parseHostPort(configuredUrl, 'DATABASE_URL');
    sourceLabel = 'DATABASE_URL(host:port)';
  } else if (mysqlAddress) {
    endpoint = parseHostPort(mysqlAddress, 'MYSQL_ADDRESS');
    sourceLabel = 'MYSQL_ADDRESS';
  } else {
    throw new Error(`未配置数据库连接。${CONFIG_HINT}`);
  }

  // 3. 账号密码
  const username = firstValue(source, ['DB_USER', 'MYSQL_USERNAME']);
  const passwordField = firstSecret(source, ['DB_PASS', 'MYSQL_PASSWORD']);
  if (!username || !passwordField) {
    throw new Error(
      '缺少数据库账号密码：请配置 DB_USER/DB_PASS；绑定云托管内置 MySQL 时用 MYSQL_USERNAME/MYSQL_PASSWORD。',
    );
  }
  if (passwordField.value !== passwordField.value.trim()) {
    warnings.push(
      `${passwordField.name} 首尾含空白字符（多半是复制粘贴带上的），当前按原样使用；` +
      '若认证失败请清空该变量重新粘贴，或在云数据库控制台重置密码。',
    );
  }
  if (firstValue(source, ['DB_USER']) !== undefined && firstValue(source, ['MYSQL_USERNAME']) !== undefined) {
    warnings.push(
      `同时检测到 DB_USER/DB_PASS 与平台注入的 MYSQL_USERNAME/MYSQL_PASSWORD，当前使用 DB_USER/DB_PASS（账号「${username}」）；` +
      '若认证失败，先核对云数据库控制台里的真实账号，必要时删掉 DB_USER/DB_PASS 改用平台注入值。',
    );
  }

  // 4. 库名
  const database = firstValue(source, ['DB_NAME', 'MYSQL_DATABASE']) ?? DEFAULT_DATABASE;
  const url = buildDatabaseUrl(endpoint, username, passwordField.value, database);
  return {
    url,
    source: sourceLabel,
    username,
    database,
    target: describeTarget(url),
    warnings,
  };
}

/** 只要连接串时的便捷入口 */
export function resolveDatabaseUrl(source: EnvLike = process.env): string {
  return resolveDatabaseConfig(source).url;
}

/**
 * 只报「哪些数据库相关变量被设置了」，**不打印任何值**。
 * 用途：判断云托管是否悄悄注入了 MYSQL_*（控制台的环境变量列表里看不到它们）。
 */
export function describeEnvPresence(source: EnvLike = process.env): string {
  const names = [
    'DATABASE_URL', 'DB_HOST', 'DB_PORT', 'DB_USER', 'DB_PASS', 'DB_NAME',
    'MYSQL_ADDRESS', 'MYSQL_USERNAME', 'MYSQL_PASSWORD', 'MYSQL_DATABASE',
  ];
  return names.map((name) => `${name}=${source[name] !== undefined && String(source[name]).trim() !== '' ? '已设置' : '—'}`).join(' ');
}

/**
 * 是否打印数据库排障信息（账号名、配置来源、变量设置情况）。
 * 默认关闭：这些信息会把「用哪个账号连哪个库」写进容器日志，平时不需要。
 * 排查时在环境变量里加 `DB_CONFIG_DEBUG=1` 重新部署即可打开（不会打印密码）。
 */
export function isDbConfigDebugEnabled(source: EnvLike = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(source.DB_CONFIG_DEBUG?.trim() ?? '');
}

let resolved: DatabaseResolution;
try {
  resolved = resolveDatabaseConfig();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[fatal] 数据库配置有误：${message}`);
  console.error(`[fatal] ${CONFIG_HINT}`);
  process.exit(1);
  throw error; // 兜底：process.exit 被 mock/替换时，阻止模块带着空配置继续加载
}

const databaseUrl = resolved.url;

if (!devMode && !/^mysql:\/\//i.test(databaseUrl)) {
  console.error('[fatal] 生产环境必须使用 MySQL（DATABASE_URL 或 DB_HOST/DB_PORT + 凭据）');
  process.exit(1);
}

// 生产环境强校验：弱 JWT_SECRET / 缺微信配置一律拒绝启动（防带着开发默认值上线）
if (!devMode) {
  if (!process.env.JWT_SECRET || jwtSecret === 'dev-secret-change-me' || jwtSecret.length < 16) {
    console.error('[fatal] 生产环境必须配置强 JWT_SECRET（≥16 字符，不得为默认值）');
    process.exit(1);
  }
  if (!wxAppid || !wxSecret) {
    console.error('[fatal] 生产环境必须配置 WX_APPID/WX_APPSECRET（真实微信登录）');
    process.exit(1);
  }
}

// ---------- 微信云托管：用户身份由平台注入 ----------
// 小程序用 wx.cloud.callContainer 调服务时，平台会在请求头注入 x-wx-openid / x-wx-unionid / x-wx-source 等，
// 服务端可直接用它建立会话，无需出网调 code2Session、无需 AppSecret。默认信任；如需关闭设 TRUST_WX_HEADERS=0。
const trustWxHeaders = process.env.TRUST_WX_HEADERS !== '0';

// ---------- 微信支付：两种接入方式 ----------
// 方式一 wechatpay（云调用）：POST http://api.weixin.qq.com/_/pay/unifiedOrder，平台代签名转发。
//   注意：**小程序提供实物交易服务时微信会禁用该能力**（报 268500896，要求接入订单发货管理/改用工作流）。
// 方式二 wechatpay-direct（APIv3 直连，推荐）：用商户自己的 API 证书签名直连 api.mch.weixin.qq.com，
//   不受上述限制。配置见「商户平台 → 账户中心 → API安全」。
const paySubMchId = process.env.WXPAY_SUB_MCHID?.trim() ?? '';
const paySubAppId = process.env.WXPAY_SUB_APPID?.trim() || wxAppid;
const payEnvId = process.env.WXPAY_ENV_ID?.trim() ?? '';
const payNotifyService = process.env.WXPAY_NOTIFY_SERVICE?.trim() ?? '';
const payNotifyPath = process.env.WXPAY_NOTIFY_PATH?.trim() || '/api/pay/notify';

// 直连（APIv3）配置
const payDirectMchId = process.env.WXPAY_MCHID?.trim() ?? '';
const payDirectSerialNo = process.env.WXPAY_SERIAL_NO?.trim() ?? '';
const payDirectPrivateKey = process.env.WXPAY_PRIVATE_KEY?.trim() ?? '';
const payDirectApiV3Key = process.env.WXPAY_API_V3_KEY?.trim() ?? '';
const payDirectPlatformPublicKey = process.env.WXPAY_PLATFORM_PUBLIC_KEY?.trim() ?? '';
const payDirectPlatformPublicKeyId = process.env.WXPAY_PLATFORM_PUBLIC_KEY_ID?.trim() ?? '';
const payDirectPlatformCert = process.env.WXPAY_PLATFORM_CERT?.trim() ?? '';
const payDirectNotifyUrl = process.env.WXPAY_NOTIFY_URL?.trim() ?? '';
/** 退款回调地址：与支付回调分开，便于各自独立处理（缺省则用 PUBLIC_BASE_URL + /api/pay/refund-notify） */
const payDirectRefundNotifyUrl = process.env.WXPAY_REFUND_NOTIFY_URL?.trim() ?? '';
/** 服务公网基础地址（云托管默认域名或自定义域名），用于拼默认回调地址 */
const publicBaseUrl =
  process.env.PUBLIC_BASE_URL?.trim() || 'https://ncspetmall-326900-12-1504359859.sh.run.tcloudbase.com';

const payProvider = (process.env.PAY_PROVIDER?.trim() ||
  (payDirectMchId && payDirectPrivateKey ? 'wechatpay-direct' : paySubMchId ? 'wechatpay' : 'mock')) as
  | 'wechatpay'
  | 'wechatpay-direct'
  | 'mock';

if (payProvider === 'wechatpay') {
  const missing = [
    !paySubMchId ? 'WXPAY_SUB_MCHID' : '',
    !paySubAppId ? 'WXPAY_SUB_APPID（或 WX_APPID）' : '',
    !payEnvId ? 'WXPAY_ENV_ID' : '',
    !payNotifyService ? 'WXPAY_NOTIFY_SERVICE' : '',
  ].filter(Boolean);
  if (missing.length) {
    console.warn(`[warn] 已启用微信支付（云调用）但缺少配置：${missing.join('、')}，下单/回调会失败`);
  }
} else if (payProvider === 'wechatpay-direct') {
  const missing = [
    !payDirectMchId ? 'WXPAY_MCHID' : '',
    !payDirectSerialNo ? 'WXPAY_SERIAL_NO' : '',
    !payDirectPrivateKey ? 'WXPAY_PRIVATE_KEY' : '',
    !payDirectApiV3Key ? 'WXPAY_API_V3_KEY' : '',
    !paySubAppId ? 'WX_APPID（或 WXPAY_SUB_APPID）' : '',
  ].filter(Boolean);
  if (missing.length) {
    console.warn(`[warn] 已启用微信支付（APIv3 直连）但缺少配置：${missing.join('、')}，下单/回调会失败`);
  }
  if (!payDirectPlatformPublicKey && !payDirectPlatformCert) {
    console.warn('[warn] 未配置微信支付平台公钥/证书（WXPAY_PLATFORM_PUBLIC_KEY(_ID) 或 WXPAY_PLATFORM_CERT），回调将无法验签');
  }
} else if (!devMode) {
  console.warn('[warn] 当前为模拟支付（PAY_PROVIDER=mock）：生产环境请配置商户号以启用真实微信支付');
}

export const env = {
  port: Number(process.env.PORT ?? 3000),
  jwtSecret,
  jwtExpiresIn, // 已做引号/空白清洗与合法性校验，非法值回落 '7d'
  databaseUrl,
  /** 不含账号密码的连接目标，用于启动日志排查 */
  databaseTarget: resolved.target,
  /** 实际使用的数据库账号（排障关键信息，不是密码） */
  databaseUser: resolved.username,
  /** 实际使用的库名 */
  databaseName: resolved.database,
  /** 数据库配置来自哪组变量 */
  databaseSource: resolved.source,
  /** 数据库相关环境变量的设置情况（只报有无，不含值） */
  envPresence: describeEnvPresence(),
  /** 不致命但值得注意的配置告警 */
  databaseWarnings: resolved.warnings,
  /** 是否信任平台注入的 x-wx-openid（微信云托管 callContainer） */
  trustWxHeaders,
  /** 支付配置（微信云托管云调用 / APIv3 直连 / 开发期模拟支付） */
  pay: {
    provider: payProvider,
    subMchId: paySubMchId,
    subAppId: paySubAppId,
    envId: payEnvId,
    notifyService: payNotifyService,
    notifyPath: payNotifyPath,
    /** 服务公网基础地址（拼默认回调地址用） */
    publicBaseUrl,
    /** APIv3 直连参数 */
    direct: {
      mchid: payDirectMchId,
      serialNo: payDirectSerialNo,
      privateKey: payDirectPrivateKey,
      apiV3Key: payDirectApiV3Key,
      platformPublicKey: payDirectPlatformPublicKey,
      platformPublicKeyId: payDirectPlatformPublicKeyId,
      platformCert: payDirectPlatformCert,
      notifyUrl: payDirectNotifyUrl,
      refundNotifyUrl: payDirectRefundNotifyUrl,
    },
  },
  devMode,
  wxAppid,
  wxSecret,
};

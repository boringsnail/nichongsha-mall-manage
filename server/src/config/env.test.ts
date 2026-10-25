import { describe, expect, it } from 'vitest';
import { describeEnvPresence, isDbConfigDebugEnabled, resolveDatabaseConfig, resolveDatabaseUrl } from './env.js';

// 覆盖云托管部署最容易踩的几种环境变量组合（2026-10-12 线上容器启动崩溃回归）
describe('resolveDatabaseUrl', () => {
  it('完整 mysql:// 连接串原样使用', () => {
    const url = 'mysql://root:secret@10.0.0.1:3306/nichongsha';
    expect(resolveDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });

  it('DATABASE_URL=host:port + DB_USER/DB_PASS → 拼出完整 URL（回归：pathname 空串被误判非法）', () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: '10.0.0.1:3306',
      DB_USER: 'root',
      DB_PASS: 'secret',
    });
    expect(url).toBe('mysql://root:secret@10.0.0.1:3306/nichongsha');
  });

  it('DB_HOST/DB_PORT 优先于 DATABASE_URL 里的主机地址', () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: '10.0.0.9:3306',
      DB_HOST: '10.0.0.1',
      DB_PORT: '3307',
      DB_USER: 'root',
      DB_PASS: 'secret',
      DB_NAME: 'mall',
    });
    expect(url).toBe('mysql://root:secret@10.0.0.1:3307/mall');
  });

  it('支持云托管内置 MySQL 自动注入的 MYSQL_ADDRESS/MYSQL_USERNAME/MYSQL_PASSWORD', () => {
    const url = resolveDatabaseUrl({
      MYSQL_ADDRESS: '10.26.11.137:3306',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'pa55word',
    });
    expect(url).toBe('mysql://root:pa55word@10.26.11.137:3306/nichongsha');
  });

  it('MYSQL_DATABASE 可指定库名，DB_NAME 优先', () => {
    expect(
      resolveDatabaseUrl({
        MYSQL_ADDRESS: 'db:3306',
        MYSQL_USERNAME: 'root',
        MYSQL_PASSWORD: 'p',
        MYSQL_DATABASE: 'nodejs',
      }),
    ).toBe('mysql://root:p@db:3306/nodejs');
    expect(
      resolveDatabaseUrl({
        MYSQL_ADDRESS: 'db:3306',
        MYSQL_USERNAME: 'root',
        MYSQL_PASSWORD: 'p',
        MYSQL_DATABASE: 'nodejs',
        DB_NAME: 'nichongsha',
      }),
    ).toBe('mysql://root:p@db:3306/nichongsha');
  });

  it('IPv6 主机地址保留方括号', () => {
    const url = resolveDatabaseUrl({
      MYSQL_ADDRESS: '[fd00::1]:3306',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'p',
    });
    expect(url).toBe('mysql://root:p@[fd00::1]:3306/nichongsha');
  });

  it('账号密码里的特殊字符被正确转义', () => {
    const url = resolveDatabaseUrl({
      DATABASE_URL: '10.0.0.1:3306',
      DB_USER: 'root',
      DB_PASS: 'p@ss:w/ord#',
    });
    expect(url).toBe('mysql://root:p%40ss%3Aw%2Ford%23@10.0.0.1:3306/nichongsha');
    // 转义后的 URL 必须能被解析回原密码
    expect(decodeURIComponent(new URL(url).password)).toBe('p@ss:w/ord#');
  });

  it('密码含 % 时不会被二次解码（回归 P1000 认证失败）', () => {
    // new URL().password 赋值不会转义字面 '%'，消费方再解码就变成另一个密码
    const url = resolveDatabaseUrl({ MYSQL_ADDRESS: 'db:3306', MYSQL_USERNAME: 'u', MYSQL_PASSWORD: 'p%25x' });
    expect(url).toBe('mysql://u:p%2525x@db:3306/nichongsha');
    expect(decodeURIComponent(new URL(url).password)).toBe('p%25x');
  });

  it('任意可打印 ASCII 字符的账号密码都能原样往返', () => {
    for (let code = 0x20; code <= 0x7e; code += 1) {
      const ch = String.fromCharCode(code);
      const url = resolveDatabaseUrl({
        MYSQL_ADDRESS: 'db:3306',
        MYSQL_USERNAME: `user${ch}`,
        // 密码经 MYSQL_PASSWORD 传入时首尾空白同样保留（见下面的告警用例）
        MYSQL_PASSWORD: `pass${ch}end`,
      });
      const parsed = new URL(url);
      // 用户名按设计会 trim（空格字符不从 MYSQL_USERNAME 取值），密码必须逐字符原样保留
      const expectUser = code === 0x20 ? 'user' : `user${ch}`;
      expect(decodeURIComponent(parsed.username), `用户名含 ${JSON.stringify(ch)}`).toBe(expectUser);
      expect(decodeURIComponent(parsed.password), `密码含 ${JSON.stringify(ch)}`).toBe(`pass${ch}end`);
    }
  });

  it('只给主机不给凭据 → 抛出带修复提示的错误（线上崩溃点）', () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '10.0.0.1:3306' })).toThrow(/账号密码/);
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: '10.0.0.1:3306', DB_USER: 'root' }),
    ).toThrow(/DB_USER\/DB_PASS/);
  });

  it('空串与纯空白的变量视为未配置', () => {
    expect(() =>
      resolveDatabaseUrl({ MYSQL_ADDRESS: '10.0.0.1:3306', MYSQL_USERNAME: '  ', MYSQL_PASSWORD: '' }),
    ).toThrow(/账号密码/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: '   ' })).toThrow(/未配置数据库连接/);
  });

  it('非 mysql 协议的 DATABASE_URL 直接拒绝', () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: 'postgres://u:p@h:5432/db' })).toThrow(
      /必须是 mysql:\/\//,
    );
  });

  it('DB_HOST/DB_PORT 必须成对出现', () => {
    expect(() => resolveDatabaseUrl({ DB_HOST: '10.0.0.1', DB_USER: 'root', DB_PASS: 'p' })).toThrow(
      /同时配置 DB_HOST 和 DB_PORT/,
    );
  });

  it('端口非法时报错', () => {
    expect(() =>
      resolveDatabaseUrl({ MYSQL_ADDRESS: 'db:3306', MYSQL_USERNAME: 'r', MYSQL_PASSWORD: 'p', DB_PORT: '0', DB_HOST: 'x' }),
    ).toThrow(/端口无效/);
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: '10.0.0.1:99999', DB_USER: 'root', DB_PASS: 'p' }),
    ).toThrow(/格式无效|端口无效/);
  });

  it('完全没配置数据库 → 抛出含云托管排查提示的错误', () => {
    expect(() => resolveDatabaseUrl({})).toThrow(/未配置数据库连接/);
    expect(() => resolveDatabaseUrl({ PORT: '8080' })).toThrow(/MYSQL_ADDRESS/);
  });
});

describe('resolveDatabaseConfig 元信息与告警', () => {
  it('标注配置来源与实际账号', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'mysql://u:p@h:3306/db' })).toMatchObject({
      source: 'DATABASE_URL(mysql://)',
      username: 'u',
      target: 'h:3306/db',
    });
    expect(
      resolveDatabaseConfig({ DB_HOST: 'h', DB_PORT: '3306', DB_USER: 'root2', DB_PASS: 'p' }),
    ).toMatchObject({ source: 'DB_HOST+DB_PORT', username: 'root2', target: 'h:3306/nichongsha' });
    expect(resolveDatabaseConfig({ DATABASE_URL: 'h:3306', DB_USER: 'u', DB_PASS: 'p' })).toMatchObject({
      source: 'DATABASE_URL(host:port)',
    });
    expect(
      resolveDatabaseConfig({ MYSQL_ADDRESS: 'h:3306', MYSQL_USERNAME: 'u', MYSQL_PASSWORD: 'p' }),
    ).toMatchObject({ source: 'MYSQL_ADDRESS', username: 'u' });
  });

  it('完整连接串会忽略其它变量 → 给出告警（防残留旧密码覆盖新值）', () => {
    const resolved = resolveDatabaseConfig({
      DATABASE_URL: 'mysql://u:old@h:3306/db',
      DB_USER: 'root',
      DB_PASS: 'new',
    });
    expect(resolved.warnings.join(' ')).toMatch(/已忽略同时存在的 DB_USER\/DB_PASS/);
    expect(resolved.url).toContain('u:old@');
  });

  it('DB_USER 与 MYSQL_USERNAME 并存 → 告警说明当前用了哪个账号', () => {
    const resolved = resolveDatabaseConfig({
      MYSQL_ADDRESS: 'h:3306',
      DB_USER: 'nichongsha',
      DB_PASS: 'p',
      MYSQL_USERNAME: 'root',
      MYSQL_PASSWORD: 'p2',
    });
    expect(resolved.username).toBe('nichongsha');
    expect(resolved.warnings.join(' ')).toMatch(/当前使用 DB_USER\/DB_PASS（账号「nichongsha」）/);
  });

  it('密码首尾带空白 → 告警但仍按原样使用', () => {
    const resolved = resolveDatabaseConfig({ DATABASE_URL: 'h:3306', DB_USER: 'root', DB_PASS: ' pw ' });
    expect(resolved.warnings.join(' ')).toMatch(/首尾含空白字符/);
    expect(decodeURIComponent(new URL(resolved.url).password)).toBe(' pw ');
  });

  it('配置完好时不应产生告警', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'mysql://u:p@h:3306/db' }).warnings).toEqual([]);
    expect(
      resolveDatabaseConfig({ MYSQL_ADDRESS: 'h:3306', MYSQL_USERNAME: 'u', MYSQL_PASSWORD: 'p' }).warnings,
    ).toEqual([]);
  });

  it('账号与库名相同不告警（可能合法），但两者都会暴露给错误提示用', () => {
    const resolved = resolveDatabaseConfig({
      DB_HOST: '10.0.0.1',
      DB_PORT: '3306',
      DB_USER: 'nichongsha',
      DB_PASS: 'pw',
    });
    expect(resolved.database).toBe('nichongsha');
    expect(resolved.username).toBe('nichongsha');
    // 正常启动不该因此报警（线上实测属误报）；只有认证失败时 start.ts 才据此给提示
    expect(resolved.warnings).toEqual([]);
  });

  it('库名可从 DB_NAME / MYSQL_DATABASE / 完整串解析出来', () => {
    expect(resolveDatabaseConfig({ DATABASE_URL: 'mysql://u:p@h:3306/mydb' }).database).toBe('mydb');
    expect(
      resolveDatabaseConfig({ MYSQL_ADDRESS: 'h:3306', MYSQL_USERNAME: 'u', MYSQL_PASSWORD: 'p', MYSQL_DATABASE: 'mall' })
        .database,
    ).toBe('mall');
  });

  it('保留 DB_HOST/DB_PORT、凭据改用平台注入的 MYSQL_*（删掉 DB_USER/DB_PASS 的场景）', () => {
    const resolved = resolveDatabaseConfig({
      DB_HOST: '10.0.0.1',
      DB_PORT: '3306',
      MYSQL_USERNAME: 'platformuser',
      MYSQL_PASSWORD: 'platformpass',
    });
    expect(resolved.source).toBe('DB_HOST+DB_PORT');
    expect(resolved.username).toBe('platformuser');
    expect(resolved.url).toBe('mysql://platformuser:platformpass@10.0.0.1:3306/nichongsha');
    // DB_USER/DB_PASS 已删除 → 不该再报「并存」告警
    expect(resolved.warnings).toEqual([]);
  });
});

describe('describeEnvPresence（只报有无，不泄露值）', () => {  it('标注哪些变量已设置，且不含任何值', () => {
    const text = describeEnvPresence({
      DB_HOST: '10.0.0.1',
      DB_PORT: '3306',
      DB_USER: 'nichongsha',
      DB_PASS: 'super-secret',
      MYSQL_PASSWORD: 'platform-secret',
    });
    expect(text).toContain('DB_HOST=已设置');
    expect(text).toContain('DB_USER=已设置');
    expect(text).toContain('MYSQL_PASSWORD=已设置');
    expect(text).toContain('DATABASE_URL=—');
    expect(text).toContain('MYSQL_ADDRESS=—');
    // 关键：绝不能把值带出来
    expect(text).not.toContain('super-secret');
    expect(text).not.toContain('platform-secret');
    expect(text).not.toContain('10.0.0.1');
    expect(text).not.toContain('3306');
  });

  it('空串/纯空白视为未设置', () => {
    expect(describeEnvPresence({ DB_PASS: '   ' })).toContain('DB_PASS=—');
  });
});

describe('isDbConfigDebugEnabled（数据库排障日志开关，默认关闭）', () => {
  it('未设置 / 关 → false', () => {
    expect(isDbConfigDebugEnabled({})).toBe(false);
    expect(isDbConfigDebugEnabled({ DB_CONFIG_DEBUG: '' })).toBe(false);
    expect(isDbConfigDebugEnabled({ DB_CONFIG_DEBUG: '0' })).toBe(false);
    expect(isDbConfigDebugEnabled({ DB_CONFIG_DEBUG: 'false' })).toBe(false);
  });

  it('1/true/yes/on（含大小写与空格）→ true', () => {
    for (const v of ['1', 'true', 'TRUE', 'yes', 'On', ' 1 ']) {
      expect(isDbConfigDebugEnabled({ DB_CONFIG_DEBUG: v }), v).toBe(true);
    }
  });
});

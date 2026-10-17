/* CookieJar：与桌面 manager 相同的语义（按音源插件 id 隔离空间、域名模糊匹配），持久化到 localStorage */

const STORE_KEY = 'rv-cookie-jar-v1';

function readAll() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; }
  catch { return {}; }
}
function writeAll(data) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(data)); } catch { /* 配额失败忽略 */ }
}

function stripDot(d) { return String(d || '').replace(/^\./, ''); }

export class CookieJar {
  constructor() {
    this.data = readAll();
    this._saveTimer = 0;
  }
  _flush() {
    if (this._saveTimer) return;
    this._saveTimer = setTimeout(() => {
      this._saveTimer = 0;
      writeAll(this.data);
    }, 200);
  }
  flushNow() {
    if (this._saveTimer) { clearTimeout(this._saveTimer); this._saveTimer = 0; }
    writeAll(this.data);
  }
  _space(pluginId) {
    if (!this.data[pluginId]) this.data[pluginId] = {};
    return this.data[pluginId];
  }
  /** 取 cookie：domain 传 hostname（如 qq.com / music.163.com），双向 endsWith 匹配并按更具体域优先合并 */
  get(pluginId, domain) {
    const space = this._space(pluginId);
    if (!domain) return space;
    const hits = Object.keys(space).filter((d) => domain.endsWith(d) || d.endsWith(domain));
    if (!hits.length) return [];
    const merged = new Map();
    hits.sort((a, b) => a.length - b.length);
    for (const d of hits) for (const c of space[d]) merged.set(c.name, c);
    return [...merged.values()];
  }
  set(pluginId, domain, cookies) {
    if (!domain || !Array.isArray(cookies)) return;
    const space = this._space(pluginId);
    space[domain] = cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain || domain, path: c.path || '/', expires: c.expires || null
    }));
    this._flush();
  }
  clear(pluginId, domain) {
    const space = this._space(pluginId);
    if (domain) delete space[domain]; else this.data[pluginId] = {};
    this._flush();
  }
  header(pluginId, urlOrHost) {
    let host = urlOrHost;
    try { host = new URL(urlOrHost).hostname; } catch { /* 已是 hostname */ }
    const list = this.get(pluginId, host);
    return list.filter((c) => this._notExpired(c)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
  _notExpired(c) {
    // expires 可能是秒级或毫秒级时间戳
    if (!c.expires) return true;
    const ms = c.expires > 1e12 ? c.expires : c.expires * 1000;
    return ms > Date.now();
  }
  /** 登录流程回写：按 cookie 自带 domain 分组合并（同名覆盖、过期删除） */
  merge(pluginId, cookies) {
    if (!Array.isArray(cookies) || !cookies.length) return;
    const space = this._space(pluginId);
    for (const c of cookies) {
      if (!c?.name) continue;
      const d = stripDot(c.domain || '');
      if (!d) continue;
      const now = Date.now();
      const expMs = c.expiresAt > 1e12 ? c.expiresAt : (c.expiresAt ? c.expiresAt * 1000 : 0);
      if (!c.persistent || c.persistent === false) {
        // 会话 cookie：保留
      }
      if (expMs && expMs <= now) {
        if (space[d]) space[d] = space[d].filter((x) => x.name !== c.name);
        continue;
      }
      if (!space[d]) space[d] = [];
      const rec = {
        name: c.name, value: c.value, domain: d,
        path: c.path || '/', expires: expMs ? Math.round(expMs / 1000) : null
      };
      const idx = space[d].findIndex((x) => x.name === c.name);
      if (idx >= 0) space[d][idx] = rec; else space[d].push(rec);
    }
    this.flushNow();
  }
  cookieString(pluginId, hostname) {
    return this.get(pluginId, hostname).filter((c) => this._notExpired(c))
      .map((c) => `${c.name}=${c.value}`).join('; ');
  }
}

/** 解析 Set-Cookie 头值（Node PoC / 兜底用；原生侧由 CookieStore 直出结构化 cookie） */
export function parseSetCookie(values, requestUrl) {
  let reqDomain = '';
  try { reqDomain = new URL(requestUrl).hostname; } catch { /* noop */ }
  return (values || []).map((line) => {
    const parts = String(line).split(';').map((s) => s.trim());
    const [pair, ...attrs] = parts;
    const eq = pair.indexOf('=');
    if (eq < 0) return null;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!name) return null;
    const c = { name, value, domain: reqDomain, path: '/', expiresAt: 0, persistent: true };
    for (const a of attrs) {
      const i = a.indexOf('=');
      const k = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
      const v = i < 0 ? '' : a.slice(i + 1).trim();
      if (k === 'domain') c.domain = stripDot(v) || reqDomain;
      else if (k === 'path') c.path = v || '/';
      else if (k === 'expires') {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) c.expiresAt = t;
      } else if (k === 'max-age') {
        const sec = parseInt(v, 10);
        if (!Number.isNaN(sec)) c.expiresAt = Date.now() + sec * 1000;
      }
    }
    return c;
  }).filter(Boolean);
}

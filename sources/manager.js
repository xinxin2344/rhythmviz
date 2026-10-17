/* ============================================================
   音源插件宿主（主进程）
   ------------------------------------------------------------
   合规边界（重要）：
   - 本文件只提供通用宿主能力：沙箱加载、代理网络、Cookie 持久化、
     登录窗口、缓存、统计、换源调度、版本检查。
   - 绝不内置任何平台的爬虫、签名算法、私有接口、固定指纹头。
     一切平台相关逻辑全部位于用户自行导入的音源插件 JS 内。
   - 插件通过 host.net 发请求（走主进程代理 + 限流 + 重试），
     请求头（UA/Referer/sec-fetch 等指纹）由插件自行提供并透传。
   - 缓存仅限元数据 / 歌词 / 用户主动触发的歌单音频预取（audio-cache，LRU 上限）。
   ============================================================ */
import { session, net, ipcMain, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { webcrypto } from 'node:crypto';
import Store from 'electron-store';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/* 扫码登录（网易云 / QQ音乐）已独立为 sources/qrologin.js：
   后台隐藏窗口/官方接口取码、Cookie 持久化 json、事件推送均由其托管；
   登录凭证统一写入「与音源同 id 的 CookieJar 空间」，插件请求经 _jarHeader 自动携带。
   本文件仅保留登录态查询（loginInfo，凭证名由 qrologin 注入 loginCookieKeys）与 cookieClear。 */
const cmpVer = (a = '0', b = '0') => {
  const pa = String(a).split(/[.-]/).map(Number), pb = String(b).split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
};

/* 错误类型约定（插件可抛 / 宿主分类）：
   E_TIMEOUT  网络超时      → 指数退避重试，重试尽则换源
   E_NET      网络错误      → 同上
   E_SERVER   5xx/429       → 同上
   E_FORBIDDEN 403/401/签名失效 → 不重试，直接换源
   E_SIGN     插件显式签名错误   → 不重试，直接换源
   E_DRM      DRM 加密资源     → 不重试，直接换源          */
const err = (code, msg) => Object.assign(new Error(msg || code), { code });

export class SourceManager {
  constructor() {
    this.store = new Store({
      name: 'source-data',
      defaults: {
        plugins: [],     // [{ id, name, version, filename, code, enabled, addedAt, updateUrl }]
        proxies: [],     // ['http://127.0.0.1:7890', 'socks5://...']
        proxyEnabled: true,
        cookieJar: {},   // { [pluginId]: { [domain]: [{name,value,domain,path,expires}] } }
        cacheMeta: {},   // { [srcId::id]: { ...meta, ts } }   仅元数据
        cacheLyric: {},  // { [srcId::id]: { lrc, ttml, trans, ts } }  仅歌词
        config: { defaultSource: '' },
        pluginEnabled: {} // 目录插件（sources/plugins/*.js）的启用状态
      }
    });
    this.plugins = new Map();      // id -> { manifest, api, enabled }
    this._sessions = new Map();    // proxyRule -> { ses, deadUntil }
    this._chains = new Map();      // domain -> promise（限流串行链）
    this._rr = 0;                  // 代理轮换游标
    this.stats = new Map();        // srcId -> { calls, ok, fail, consec, dead, lastErr }
    this.onNotify = null;          // (msg) => void 推给渲染层 toast
    this._initAudioCache();        // 歌单音频磁盘缓存（audio-cache，LRU）

    // 内置音源（QQ / 网易云）通过 asar 内 sources/plugins/*.js 走 loadPluginsDir 加载，
    // 用户可在 userData/plugins 放同名插件覆盖；builtins 保留给未来硬编码音源。
    this.builtins = new Map();
    this.loginCookieKeys = {}; // srcId -> [凭证 Cookie 名]（由 sources/qrologin.js 注册时注入）
  }

  /** 统一取源：内置源表（当前为空）/ 外部插件 */
  srcApi(srcId) {
    return this.builtins.get(srcId) || this.plugins.get(srcId)?.api || null;
  }

  _freshStats() { return { calls: 0, ok: 0, fail: 0, consec: 0, dead: false, lastErr: '' }; }
  _stat(id) {
    if (!this.stats.has(id)) this.stats.set(id, this._freshStats());
    return this.stats.get(id);
  }
  _record(srcId, ok, errMsg = '') {
    const s = this._stat(srcId);
    s.calls++;
    if (ok) { s.ok++; s.consec = 0; }
    else {
      s.fail++; s.consec++; s.lastErr = errMsg;
      // 连续失败判定音源失效，弹窗提示用户（阈值 5）
      if (!s.dead && s.consec >= 5) {
        s.dead = true;
        const name = this.builtins.get(srcId)?.name || this.plugins.get(srcId)?.manifest?.name || srcId;
        this._notify(`⚠️ 音源「${name}」已连续失败 ${s.consec} 次，判定失效，暂停参与换源。可在音源管理中查看或删除后重新导入。`);
      }
    }
    return s;
  }
  _markAlive(srcId) { const s = this._stat(srcId); if (s.dead) s.dead = false; s.consec = 0; }
  _notify(msg) { try { this.onNotify?.(msg); } catch { /* noop */ } }

  /* ================= 代理：HTTP / SOCKS 多 IP 轮换 ================= */
  _sessionFor(rule) {
    if (!rule) return null;
    let e = this._sessions.get(rule);
    if (!e) {
      const ses = session.fromPartition('srcproxy-' + Buffer.from(rule).toString('base64url'), { cache: false });
      try { ses.setProxy({ proxyRules: rule, proxyBypassRules: '<-loopback>' }); } catch { return null; }
      e = { ses, deadUntil: 0 };
      this._sessions.set(rule, e);
    }
    return e;
  }
  _pickProxy() {
    if (!this.store.get('proxyEnabled')) return null;
    const list = this.store.get('proxies') || [];
    const alive = list.filter((p) => (this._sessionFor(p)?.deadUntil || 0) < Date.now());
    if (!alive.length) return null;
    const rule = alive[this._rr % alive.length];
    this._rr++;
    return rule;
  }
  _failProxy(rule) {
    if (!rule) return;
    const e = this._sessionFor(rule);
    if (e) e.deadUntil = Date.now() + 60_000; // 冷却 60s
  }
  setProxies(list, enabled = true) {
    this.store.set('proxies', (list || []).map(s => String(s).trim()).filter(Boolean));
    this.store.set('proxyEnabled', !!enabled);
    this._sessions.clear(); // 重置会话与冷却状态
  }
  getProxies() { return { list: this.store.get('proxies') || [], enabled: !!this.store.get('proxyEnabled') }; }

  /* ================= 限流：同域名串行 + 随机间隔（模拟真人） ================= */
  _throttle(domain) {
    const prev = this._chains.get(domain) || Promise.resolve();
    const wait = prev.catch(() => {}).then(() => sleep(350 + Math.random() * 550));
    this._chains.set(domain, wait);
    return wait;
  }

  /* ================= 网络请求（插件统一入口） ================= */
  _doRequest(o) {
    return new Promise((resolve, reject) => {
      let req;
      try {
        const opts = { url: o.url, method: o.method, redirect: o.redirect || 'follow' };
        if (o.session) opts.session = o.session;
        req = net.request(opts);
      } catch (e) { reject(err('E_NET', e.message)); return; }
      // 空闲超时：只在无数据流动时计时（大文件下载不误杀）
      let to = null;
      const bump = () => {
        clearTimeout(to);
        to = setTimeout(() => { try { req.abort(); } catch { /* noop */ } reject(err('E_TIMEOUT', '响应超时（空闲）')); }, o.timeout || 12000);
      };
      bump();
      for (const [k, v] of Object.entries(o.headers || {})) {
        try { req.setHeader(k, String(v)); } catch { /* 非法头忽略 */ }
      }
      req.on('response', (res) => {
        const chunks = [];
        res.on('data', (c) => { chunks.push(c); bump(); });
        res.on('end', () => {
          clearTimeout(to);
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: o.encoding === 'buffer' ? buf : buf.toString(o.encoding || 'utf8')
          });
        });
        res.on('error', (e) => { clearTimeout(to); reject(err('E_NET', e.message)); });
      });
      req.on('error', (e) => { clearTimeout(to); reject(err('E_NET', e.message)); });
      if (o.body != null) {
        try { req.write(typeof o.body === 'string' ? o.body : Buffer.from(o.body)); } catch { /* noop */ }
      }
      req.end();
    });
  }

  /** 宿主网络：代理轮换 + 限流 + 指数退避重试（403/401/签名错误不重试） */
  async hostRequest(opts = {}) {
    const { url, method = 'GET', headers = {}, body = null, timeout = 12000, redirect = 'follow', encoding = 'utf8' } = opts;
    let domain = '';
    try { domain = new URL(url).host; } catch { throw err('E_NET', '无效 URL'); }
    await this._throttle(domain);

    for (let attempt = 1; ; attempt++) {
      const rule = this._pickProxy();
      const ses = rule ? this._sessionFor(rule)?.ses : null;
      try {
        const r = await this._doRequest({ url, method, headers, body, timeout, redirect, encoding, session: ses });
        if (r.status === 403 || r.status === 401) throw err('E_FORBIDDEN', `HTTP ${r.status}（风控/签名失效）`);
        if (r.status >= 500 || r.status === 429) throw err('E_SERVER', `HTTP ${r.status}`);
        return r;
      } catch (e) {
        if (e.code === 'E_FORBIDDEN') throw e;              // 不重试 → 由换源调度接手
        if (rule && (e.code === 'E_NET' || e.code === 'E_TIMEOUT')) this._failProxy(rule); // 代理故障冷却
        if (attempt >= 3 || e.code === 'E_FORBIDDEN' || e.code === 'E_SIGN' || e.code === 'E_DRM') throw e;
        await sleep(700 * 2 ** (attempt - 1) + Math.random() * 400); // 指数退避
      }
    }
  }

  /* ================= Cookie 会话（插件 CookieJar 持久化） ================= */
  _jarSpace(pluginId) {
    const jar = this.store.get('cookieJar') || {};
    if (!jar[pluginId]) jar[pluginId] = {};
    return jar;
  }
  cookieGet(pluginId, domain) {
    const jar = this._jarSpace(pluginId);
    if (!domain) return jar[pluginId] || {};
    // 合并所有匹配域（如 qq.com 与 y.qq.com 两组）：find 只取一组会丢凭证。
    // 同名冲突以更具体的域（更长）优先 —— 与浏览器 cookie 域匹配语义一致
    const hits = Object.keys(jar[pluginId]).filter((d) => domain.endsWith(d) || d.endsWith(domain));
    if (!hits.length) return [];
    const merged = new Map();
    hits.sort((a, b) => a.length - b.length);
    for (const d of hits) for (const c of jar[pluginId][d]) merged.set(c.name, c);
    return [...merged.values()];
  }
  cookieSet(pluginId, domain, cookies) {
    if (!domain || !Array.isArray(cookies)) return;
    const jar = this._jarSpace(pluginId);
    jar[pluginId][domain] = cookies.map((c) => ({
      name: c.name, value: c.value, domain: c.domain || domain, path: c.path || '/', expires: c.expires || null
    }));
    this.store.set('cookieJar', jar);
  }
  cookieClear(pluginId, domain) {
    const jar = this._jarSpace(pluginId);
    if (domain) delete jar[pluginId][domain];
    else jar[pluginId] = {};
    this.store.set('cookieJar', jar);
  }
  _jarHeader(pluginId, url) {
    try {
      const domain = new URL(url).hostname;
      const list = this.cookieGet(pluginId, domain) || [];
      return list.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { return ''; }
  }

  /* ================= 账号登录态查询 =================
     扫码会话由 sources/qrologin.js 统一托管（start-qr-login / cancel-qr-login）；
     此处仅提供登录态查询与清除，供插件沙箱 host.login 与登录弹层使用。 */

  /** 退出登录：清空该插件 CookieJar，后续请求回落匿名态 */
  logout(pluginId) {
    this.cookieClear(pluginId);
    this._markAlive(pluginId);
    return this.loginInfo(pluginId);
  }

  /** 登录状态：已存 Cookie 的域名/数量；
      凭证名优先取 qrologin 注入的 loginCookieKeys（按 srcId），插件可自声明 loginCookieKeys 兜底 */
  loginInfo(pluginId) {
    const jar = (this.store.get('cookieJar') || {})[pluginId] || {};
    const all = Object.values(jar).flat();
    const keys = this.loginCookieKeys?.[pluginId] || this.srcApi(pluginId)?.loginCookieKeys || [];
    const loggedIn = keys.length ? all.some((c) => keys.includes(c.name) && c.value) : all.length > 0;
    return {
      loggedIn, count: all.length, domains: Object.keys(jar),
      names: [...new Set(all.map((c) => c.name))].slice(0, 12)
    };
  }

  /* ================= 缓存：仅元数据 / 歌词（直链绝不缓存） ================= */
  _cacheGet(mapName, key) {
    const m = this.store.get(mapName) || {};
    const v = m[key];
    if (!v) return null;
    if (Date.now() - v.ts > 14 * 24 * 3600 * 1000) { delete m[key]; this.store.set(mapName, m); return null; } // 14 天过期
    return v;
  }
  _cacheSet(mapName, key, val, cap) {
    const m = this.store.get(mapName) || {};
    m[key] = { ...val, ts: Date.now() };
    const keys = Object.keys(m);
    if (keys.length > cap) { // 简易 LRU：删最旧
      keys.sort((a, b) => m[a].ts - m[b].ts);
      for (let i = 0; i < keys.length - cap; i++) delete m[keys[i]];
    }
    this.store.set(mapName, m);
  }

  /* ================= 插件沙箱加载 ================= */
  loadFromText(filename, code, opts = {}) {
    const sandbox = {
      module: { exports: {} },
      console: { log: (...a) => console.log('[source]', filename, ...a), error: (...a) => console.error('[source]', filename, ...a) },
      setTimeout, clearTimeout, setInterval, clearInterval,
      Buffer, TextEncoder, TextDecoder, URL, URLSearchParams,
      webcrypto, // 标准 Web Crypto 原语（AES/SubtleCrypto）；平台签名算法仍由插件自行实现
      BigInt,
      host: null // init 前注入
    };
    sandbox.exports = sandbox.module.exports;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename, timeout: 8000 });
    const manifest = sandbox.module.exports;
    if (!manifest || !manifest.id || typeof manifest.search !== 'function' || typeof manifest.getPlayUrl !== 'function') {
      throw new Error('插件不符合 MusicSource 接口：必须提供 id / search / getPlayUrl');
    }
    if (this.builtins.has(manifest.id) || [...this.plugins.keys()].includes(manifest.id)) {
      if (!opts.replace) throw new Error(`音源 id「${manifest.id}」已存在，请先删除旧版`);
    }
    return manifest;
  }

  async attach(manifest, meta) {
    const host = this._makeHost(manifest.id);
    const rec = { manifest, api: manifest, enabled: meta.enabled !== false, filename: meta.filename || '' };
    this.plugins.set(manifest.id, rec);
    if (typeof manifest.init === 'function') {
      try { await manifest.init(host); } catch (e) { console.error('[source] init 失败', manifest.id, e.message); }
    }
    this._stat(manifest.id);
    return rec;
  }

  /** 宿主 API：注入每个插件（全部为通用能力，无平台逻辑） */
  _makeHost(pluginId) {
    const self = this;
    return {
      version: '1.0.0',
      get id() { return pluginId; },
      net: {
        /** 通用请求：走主进程代理轮换 + 限流 + 退避重试；headers 由插件提供（含完整指纹） */
        request: (opts) => self.hostRequest(opts),
        /** 快捷 GET（自动附带该插件 CookieJar 的 Cookie 头） */
        async get(url, opts = {}) {
          const cookie = self._jarHeader(pluginId, url);
          const headers = { ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) };
          return self.hostRequest({ ...opts, url, headers });
        },
        async post(url, body, opts = {}) {
          const cookie = self._jarHeader(pluginId, url);
          const headers = { ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) };
          return self.hostRequest({ ...opts, url, method: 'POST', body, headers });
        }
      },
      cookieJar: {
        get: (domain) => self.cookieGet(pluginId, domain),
        set: (domain, cookies) => self.cookieSet(pluginId, domain, cookies),
        clear: (domain) => self.cookieClear(pluginId, domain),
        header: (url) => self._jarHeader(pluginId, url)
      },
      login: {
        /** 查询/清除本插件登录态（扫码会话由 sources/qrologin.js 统一托管） */
        info: () => self.loginInfo(pluginId),
        logout: () => self.logout(pluginId)
      },
      storage: {
        get: (key) => { const s = self.store.get('pluginStorage') || {}; return s[pluginId]?.[key]; },
        set: (key, val) => {
          const s = self.store.get('pluginStorage') || {};
          s[pluginId] = s[pluginId] || {};
          s[pluginId][key] = val;
          self.store.set('pluginStorage', s);
        }
      },
      cache: {
        /** 仅限元数据/歌词类小数据；播放直链禁止使用本 API 缓存 */
        get: (key) => self._cacheGet('cacheMeta', `${pluginId}::${key}`)?.data,
        set: (key, data) => self._cacheSet('cacheMeta', `${pluginId}::${key}`, { data }, 300)
      },
      log: (...a) => console.log('[source:' + pluginId + ']', ...a),
      notify: (msg) => self._notify(`[音源] ${msg}`)
    };
  }

  /* ================= 导入 / 移除 / 启停 ================= */
  async importFromFile(filePath, enabled = true) {
    const { readFile } = await import('node:fs/promises');
    const code = await readFile(filePath, 'utf8');
    const filename = path.basename(filePath);
    const manifest = this.loadFromText(filename, code, { replace: true });
    const list = (this.store.get('plugins') || []).filter((p) => p.id !== manifest.id);
    list.push({ id: manifest.id, name: manifest.name || manifest.id, version: manifest.version || '0.0.0', filename, code, enabled, addedAt: Date.now(), updateUrl: manifest.updateUrl || null });
    this.store.set('plugins', list);
    const host = this._makeHost(manifest.id);
    manifest.host = host;
    this.plugins.set(manifest.id, { manifest, api: manifest, enabled, filename });
    if (typeof manifest.init === 'function') {
      try { await manifest.init(host); } catch (e) { console.error('[source] init 失败', manifest.id, e.message); }
    }
    this._stat(manifest.id);
    return { id: manifest.id, name: manifest.name, version: manifest.version };
  }
  remove(id) {
    if (this.builtins.has(id)) { // 内置源不可删除，仅停用
      const cfg = this.store.get('pluginEnabled') || {};
      cfg[id] = false; this.store.set('pluginEnabled', cfg);
      this._notify('内置音源不可删除，已为您停用（可在音源管理重新启用）');
      return;
    }
    const fromDir = this.plugins.get(id)?.fromDir;
    this.plugins.delete(id);
    if (fromDir) { // 目录插件：仅停用，文件由用户自行删除
      const cfg = this.store.get('pluginEnabled') || {};
      cfg[id] = false; this.store.set('pluginEnabled', cfg);
    } else {
      this.store.set('plugins', (this.store.get('plugins') || []).filter((p) => p.id !== id));
    }
    this.stats.delete(id);
  }
  toggle(id, enabled) {
    const rec = this.plugins.get(id);
    if (rec) rec.enabled = !!enabled;
    if (this.builtins.has(id) || rec?.fromDir) {
      const cfg = this.store.get('pluginEnabled') || {};
      cfg[id] = !!enabled; this.store.set('pluginEnabled', cfg);
    } else {
      this.store.set('plugins', (this.store.get('plugins') || []).map((p) => p.id === id ? { ...p, enabled: !!enabled } : p));
    }
    if (enabled) this._markAlive(id);
  }
  _enabledOf(id) {
    if (this.builtins.has(id)) return (this.store.get('pluginEnabled') || {})[id] !== false;
    return this.plugins.get(id)?.enabled === true;
  }
  async loadPersisted() {
    for (const meta of this.store.get('plugins') || []) {
      try {
        const manifest = this.loadFromText(meta.filename, meta.code, { replace: true });
        manifest.host = this._makeHost(manifest.id);
        this.plugins.set(manifest.id, { manifest, api: manifest, enabled: meta.enabled !== false, filename: meta.filename });
        if (typeof manifest.init === 'function') {
          try { await manifest.init(manifest.host); } catch { /* noop */ }
        }
        this._stat(manifest.id);
      } catch (e) {
        console.error('[source] 插件加载失败:', meta.filename, e.message);
      }
    }
  }

  /** 扫描插件目录（sources/plugins/*.js，*.template.* 除外）—— 逆向插件与主程序分离存放 */
  async loadPluginsDir(dirPath) {
    let names = [];
    try { const { readdirSync } = await import('node:fs'); names = readdirSync(dirPath); } catch { return; }
    for (const name of names) {
      if (!name.endsWith('.js') || name.includes('.template.')) continue;
      try {
        const { readFile } = await import('node:fs/promises');
        const code = await readFile(path.join(dirPath, name), 'utf8');
        const manifest = this.loadFromText(name, code, { replace: true });
        if (this.plugins.has(manifest.id)) continue; // 手动导入的版本优先
        const enabled = (this.store.get('pluginEnabled') || {})[manifest.id] !== false;
        const host = this._makeHost(manifest.id);
        manifest.host = host;
        this.plugins.set(manifest.id, { manifest, api: manifest, enabled, filename: name, fromDir: true });
        if (typeof manifest.init === 'function') {
          try { await manifest.init(host); } catch { /* noop */ }
        }
        this._stat(manifest.id);
        console.log('[source] 目录插件已加载:', name, manifest.id);
      } catch (e) {
        console.error('[source] 目录插件加载失败:', name, e.message);
      }
    }
  }

  /* ================= 状态监控 ================= */
  list() {
    const out = [];
    for (const [id, b] of this.builtins) {
      out.push({
        id, name: b.name, version: b.version, builtin: true, legal: true,
        needsKey: !!b.needsKey, enabled: this._enabledOf(id), stats: this._stat(id)
      });
    }
    for (const [id, rec] of this.plugins) {
      out.push({
        id, name: rec.manifest.name || id, version: rec.manifest.version || '0.0.0',
        builtin: false, enabled: rec.enabled, filename: rec.filename,
        fromDir: !!rec.fromDir, updateUrl: !!rec.manifest.updateUrl, stats: this._stat(id),
        loggedIn: this.loginInfo(id).loggedIn
      });
    }
    return out;
  }
  enabledIds(prefer) {
    const ids = [];
    if (prefer && this.srcApi(prefer) && this._enabledOf(prefer) && !this._stat(prefer).dead) ids.push(prefer);
    for (const [id, rec] of this.plugins) {
      if (rec.enabled && !ids.includes(id) && !this._stat(id).dead) ids.push(id);
    }
    return ids;
  }

  /* ================= 聚合搜索 / 首页内容源 / 歌单路由 ================= */
  /** 展示即可播统一底线：过滤试听/VIP 标记曲目与 <40s 短片段（歌单/专辑/单源搜索同规则） */
  _playableOnly(list) {
    return (list || []).filter((s) => s && !s.trial && (!s.duration || s.duration >= 40000));
  }
  /** 多源聚合搜索：默认音源优先，其余启用插件随后；结果带 srcId/srcName 标签 */
  async searchAll(kw) {
    const hintP = this._originalArtistHint(kw); // 与搜索并行：LRCLIB 原唱歌手提示
    const ids = this.enabledIds(this.store.get('config')?.defaultSource).filter((id) => {
      const api = this.srcApi(id);
      return api && typeof api.search === 'function';
    });
    const settled = await Promise.allSettled(ids.map(async (id) => {
      const list = await this.srcApi(id).search(kw, 1);
      this._markAlive(id);
      // 统一只展示完整曲目：过滤试听片段标记与 <40s 的短片段
      const full = (list || []).filter((s) => s && !s.trial && (!s.duration || s.duration >= 40000));
      return full.slice(0, 30).map((s) => ({ ...s, srcId: s.srcId || id, srcName: s.srcName || this.srcApi(id).name || id }));
    }));
    const out = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(...r.value);
      else if (r.reason?.id) this._record(r.reason.id, false, r.reason.message);
    }
    return this._rankOriginal(out, kw, await hintP); // 原唱优先（跨源统一 + LRCLIB 原唱提示）
  }

  /** 首页信息流（热歌 + 推荐歌单）：默认音源优先（可在音源管理切换），失败自动降级其他音源 */
  async feed() {
    const pref = this.store.get('config')?.defaultSource || 'netease';
    const order = [pref, 'netease', ...this.enabledIds()].filter((x, i, a) => x && a.indexOf(x) === i);
    const tried = [];
    for (const id of order) {
      const api = this.srcApi(id);
      if (!api || !this._enabledOf(id) || this._stat(id).dead) continue;
      try {
        let hot = [];
        if (typeof api.trending === 'function') hot = (await api.trending(50)) || [];
        else if (typeof api.search === 'function') hot = ((await api.search('热门歌曲', 1)) || []).slice(0, 50);
        hot = hot.filter((s) => s && !s.trial && (!s.duration || s.duration >= 40000));
        const playlists = typeof api.playlists === 'function' ? ((await api.playlists(16)) || []) : [];
        if (hot.length || playlists.length) {
          this._markAlive(id);
          return {
            hot: hot.slice(0, 50).map((s) => ({ ...s, srcId: s.srcId || id, srcName: s.srcName || api.name || id })),
            playlists, source: id, sourceName: api.name || id
          };
        }
        tried.push(`${id}: 空结果`);
      } catch (e) {
        this._record(id, false, e.message);
        tried.push(`${id}: ${e.message}`);
      }
    }
    console.error('[feed] 全部音源不可用:', tried.join('；'));
    return { hot: [], playlists: [], source: pref, sourceName: '' };
  }

  /** 账号云歌单（登录态「我的歌单」）：按音源拉取，插件未实现/未登录返回空数组 */
  async userPlaylists(srcId) {
    const api = this.srcApi(srcId);
    if (!api || typeof api.userPlaylists !== 'function') return [];
    try {
      const list = (await api.userPlaylists()) || [];
      this._markAlive(srcId);
      return list.map((p) => ({ ...p, srcId: p.srcId || srcId, srcName: p.srcName || api.name || srcId }));
    } catch (e) {
      this._record(srcId, false, e.message);
      return [];
    }
  }

  /** 歌单详情路由：`pl:srcId:原始id` 前缀 → 对应源；裸数字 id → 兼容旧收藏，尝试网易云插件 */
  async playlistDetail(pid) {
    const m = /^pl:([^:]+):(.+)$/.exec(String(pid));
    if (m) {
      const srcId = m[1], raw = m[2];
      const api = this.srcApi(srcId);
      // 专辑路由：pl:srcId:album:<专辑id> → 专辑详情（曲目保持专辑原始顺序，不做原唱重排）
      if (raw.startsWith('album:')) {
        if (!api || typeof api.albumDetail !== 'function') return { name: '', coverUrl: '', tracks: [], msg: '该专辑所属音源不可用' };
        try {
          const det = await api.albumDetail(raw.slice(6));
          this._record(srcId, true);
          det.tracks = this._playableOnly((det.tracks || []).map((t) => ({ ...t, srcId: t.srcId || srcId, srcName: t.srcName || api.name })));
          return det;
        } catch (e) {
          this._record(srcId, false, e.message);
          return { name: '', coverUrl: '', tracks: [], msg: e.message };
        }
      }
      if (!api || typeof api.playlistDetail !== 'function') return { name: '', coverUrl: '', tracks: [], msg: '该歌单所属音源不可用' };
      try {
        const det = await api.playlistDetail(raw);
        this._record(srcId, true);
        det.tracks = this._rankOriginal(this._playableOnly((det.tracks || []).map((t) => ({ ...t, srcId: t.srcId || srcId, srcName: t.srcName || api.name }))));
        return det;
      } catch (e) {
        this._record(srcId, false, e.message);
        return { name: '', coverUrl: '', tracks: [], msg: e.message };
      }
    }
    // 旧版收藏兼容（网易云数字 id）
    const ne = this.plugins.get('netease')?.api;
    if (ne && typeof ne.getPlaylistDetail === 'function') {
      try {
        const det = await ne.getPlaylistDetail(pid);
        if (det?.tracks) det.tracks = this._rankOriginal(this._playableOnly(det.tracks));
        return det;
      } catch { /* fallthrough */ }
    }
    return { name: '', coverUrl: '', tracks: [], msg: '歌单不存在或所属音源未启用' };
  }

  /** 音源设置读取 / 写入（如 defaultSource） */
  getConfig() { return this.store.get('config') || {}; }
  setConfig(patch) {
    const cfg = { ...(this.store.get('config') || {}), ...(patch || {}) };
    this.store.set('config', cfg);
    return cfg;
  }

  /* ================= 播放地址解析 + 多源自动换源 ================= */
  _unplayable(r) {
    const u = String(r?.url || '');
    if (!u) return '空地址';
    if (r.drm === true) return 'DRM 加密资源';
    if (/\.mpd($|[?#])/i.test(u) || /\.ism\/manifest/i.test(u)) return 'DASH 加密流';
    if (/\.m3u8($|[?#])/i.test(u)) return 'HLS 流（不可直接播放）';
    return null;
  }
  async _trySource(srcId, songId, quality) {
    const api = this.srcApi(srcId);
    if (!api) return { ok: false, msg: '音源不存在' };
    try {
      const r = await api.getPlayUrl(songId, quality || 128);
      this._record(srcId, true);
      const bad = this._unplayable(r);
      if (bad) return { ok: false, msg: bad, skip: true }; // DRM / 不可播流 → 直接换源
      return { ok: true, url: r.url, br: r.br || null, headers: r.headers || null };
    } catch (e) {
      const code = e.code || 'E_NET';
      this._record(srcId, false, e.message);
      return { ok: false, msg: e.message, code };
    }
  }
  /* 标题/歌手相似度：跨源匹配防「同名不同歌」误配（英文歌名撞名极多，直接取首条必错） */
  _normName(s) {
    return String(s || '').toLowerCase()
      .replace(/[（(【\[].*?[)）】\]]/g, ' ')
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .replace(/\s+/g, ' ').trim();
  }
  _simTokens(a, b) {
    const ta = new Set(a.split(' ').filter(Boolean));
    const tb = new Set(b.split(' ').filter(Boolean));
    if (!ta.size || !tb.size) return 0;
    let hit = 0;
    for (const t of ta) if (tb.has(t)) hit++;
    return hit / Math.max(ta.size, tb.size);
  }
  _matchScore(m, title, artist) {
    const t1 = this._normName(title), t2 = this._normName(m?.name || m?.title || '');
    if (!t1 || !t2) return 0;
    const ts = t1 === t2 ? 1 : (t2.includes(t1) || t1.includes(t2) ? 0.85 : this._simTokens(t1, t2));
    const a1 = this._normName(artist), a2 = this._normName(m?.artist || m?.singer || '');
    const as = (!a1 || !a2) ? 0.5 : (a1 === a2 ? 1 : this._simTokens(a1, a2)); // 一方缺歌手：中性
    return ts * 0.68 + as * 0.32;
  }
  /* 翻唱/非原唱识别：歌名或歌手含 cover/翻唱/现场/remix/DJ/伴奏/各种改编版 标记 → 视为非原唱；
     「(原唱 X)」字样也是翻唱标记（真正的原唱不会给自己标原唱） */
  _coverish(m) {
    const s = `${m?.name || ''} ${m?.artist || ''} ${m?.album || ''}`;
    return /(cover|翻[唱自]|现场|\blive\b|remix|混音|\bdj\b|伴奏|instrumental|karaoke|卡拉ok|demo|小样|tribute|致敬|烟嗓|女生版|男生版|女声版|男声版|童声版|深情版|抒情版|钢琴版|吉他版|弹唱|清唱|纯音乐|加速版|降调|变速|翻奏|（\s*原唱|\(\s*原唱|原唱[:：]|出版社|作品集|精选集|翻唱集)/i.test(s);
  }
  /**
   * 原唱优先排序（用户硬性要求：搜索/歌单第一个必须是原唱，无论音源）：
   * 1) LRCLIB 推断的原唱歌手条目最前（裸歌名搜索时的决定性信号）
   * 2) 歌名与关键词完全一致的在前（排除「晴天(深情版)」这类蹭名改编）
   * 3) 非翻唱（无 cover/翻唱/改编版/“原唱:” 等标记）在前
   * 4) 官方版权曲（fee===8 数字专辑）在前——原唱大概率是版权曲，翻唱基本免费
   *    （fee===1 VIP 已被 netease._mapSong 标记 trial 过滤，不再作为信号）
   * 5) 同级内与关键词贴合度高的在前 6) 完全稳定（不动源内原有相对顺序）。
   */
  _rankOriginal(list, kw = '', hint = '') {
    const kwN = String(kw).trim().toLowerCase();
    const exact = (m) => kwN && String(m?.name || '').trim().toLowerCase() === kwN;
    const hintN = hint ? this._normName(hint) : '';
    const isOrigin = (m) => hintN && this._simTokens(this._normName(m?.artist || ''), hintN) >= 0.7;
    return (list || []).map((m, i) => ({ m, i })).sort((a, b) => {
      const ga = isOrigin(a.m) ? 0 : 1, gb = isOrigin(b.m) ? 0 : 1;
      if (ga !== gb) return ga - gb;
      const ea = exact(a.m), eb = exact(b.m);
      if (kw && ea !== eb) return ea ? -1 : 1;
      const ca = this._coverish(a.m) ? 1 : 0, cb = this._coverish(b.m) ? 1 : 0;
      if (ca !== cb) return ca - cb;
      const oa = a.m?.fee === 8 ? 0 : 1, ob = b.m?.fee === 8 ? 0 : 1;
      if (oa !== ob) return oa - ob;
      if (kw) {
        const sa = this._matchScore(a.m, kw, ''), sb = this._matchScore(b.m, kw, '');
        if (Math.abs(sa - sb) > 0.05) return sb - sa;
      }
      return a.i - b.i;
    }).map((x) => x.m);
  }
  /* 原唱歌手推断（LRCLIB 公共库，免密钥）：裸歌名搜索时其收录的通常是原唱录音室版本，
     取回 artistName 作为原唱提示。失败/无收录返回空串静默降级；带 300 条 LRU 缓存。 */
  async _originalArtistHint(kw) {
    const key = String(kw || '').trim().toLowerCase();
    if (!key) return '';
    this._hintCache = this._hintCache || new Map();
    if (this._hintCache.has(key)) return this._hintCache.get(key);
    let hint = '';
    try {
      const r = await net.fetch(`https://lrclib.net/api/search?track_name=${encodeURIComponent(key)}`, { timeout: 6000 });
      if (r.status === 200) {
        const list = await r.json();
        const keyN = this._normName(key);
        const hit = Array.isArray(list) ? list.find((x) => x?.artistName && this._normName(x?.trackName) === keyN) : null;
        hint = hit ? String(hit.artistName || '').trim() : '';
      }
    } catch { /* 提示获取失败可忽略 */ }
    this._hintCache.set(key, hint);
    if (this._hintCache.size > 300) this._hintCache.delete(this._hintCache.keys().next().value);
    return hint;
  }
  async _matchInSource(srcId, title, artist) {
    const api = this.srcApi(srcId);
    if (!api || typeof api.search !== 'function') return null;
    try {
      const kw = [title, artist].filter(Boolean).join(' ');
      const list = await api.search(kw, 1);
      this._record(srcId, true);
      let best = null, bs = 0;
      for (const m of (list || []).slice(0, 5)) {
        const s = this._matchScore(m, title, artist);
        if (s > bs) { bs = s; best = m; }
      }
      // 阈值 0.72：同名不同歌手（≈0.68）判定为另一首歌，交后续源/LRCLIB 兜底
      if (bs < 0.72 || !best) return null;
      // 歌手地板线：带歌手信息时，候选歌手与目标歌手差异过大 → 判定同名不同歌，拒配
      // （防「同名不同曲」串歌词/串播放；0.35 容忍简称与多人合作写法差异）
      if (artist) {
        const asim = this._simTokens(this._normName(artist), this._normName(best.artist || best.singer || ''));
        if (asim < 0.35) return null;
      }
      return best;
    } catch (e) {
      this._record(srcId, false, e.message);
      return null;
    }
  }
  /** 换源调度：原源失败（403/签名/DRM/超时…）→ 依启用顺序跨源搜索匹配 → 取地址 */
  async resolvePlayUrl({ srcId, id, title, artist, quality }) {
    if (!srcId) srcId = this.store.get('config')?.defaultSource || 'netease'; // 缺省走默认音源
    const attempts = [];
    if (srcId) {
      const r = await this._trySource(srcId, id, quality);
      if (r.ok) return { url: r.url, br: r.br, headers: r.headers, srcId, via: srcId };
      attempts.push(`${srcId}: ${r.msg}`);
      if (this._stat(srcId).dead) this._notify(`音源「${srcId}」连续失败已停用`);
    }
    let switched = 0;
    for (const sid of this.enabledIds(srcId).filter((x) => x !== srcId)) {
      if (switched >= 3) break; // 最多跨 3 个源，避免拖沓
      const m = await this._matchInSource(sid, title, artist);
      if (!m?.id) { attempts.push(`${sid}: 无匹配`); continue; }
      const r = await this._trySource(sid, m.id, quality);
      attempts.push(`${sid}: ${r.ok ? 'OK' : r.msg}`);
      if (r.ok) {
        switched++;
        return { url: r.url, br: r.br, headers: r.headers, srcId: sid, via: sid, newId: m.id, name: m.name };
      }
    }
    return { url: null, msg: `全部音源均失败（${attempts.join('；')}）` };
  }

  /* ================= 歌词（缓存 + 跨源兜底） ================= */
  async getLyric(srcId, songId) {
    const key = `${srcId}::${songId}`;
    const hit = this._cacheGet('cacheLyric', key);
    if (hit) return { lrc: hit.lrc, yrc: hit.yrc || '', ttml: hit.ttml, trans: hit.trans, pure: hit.pure };
    const api = this.srcApi(srcId);
    if (!api || typeof api.getLyric !== 'function') return { lrc: '', yrc: '', ttml: '', trans: '' };
    try {
      const r = await api.getLyric(songId);
      this._record(srcId, true);
      const v = r?.pure === true
        ? { lrc: '', yrc: '', ttml: '', trans: '', pure: true }
        : { lrc: r?.lrc || '', yrc: r?.yrc || '', ttml: r?.ttml || '', trans: r?.trans || '' };
      this._cacheSet('cacheLyric', key, v, 200);
      return v;
    } catch (e) {
      this._record(srcId, false, e.message);
      return { lrc: '', ttml: '', trans: '' };
    }
  }

  /**
   * LRCLIB 公共歌词库兜底（lrclib.net，开放 API 免密钥）：源内与跨源都拿不到歌词时，
   * 按歌名+歌手精确检索带时间戳歌词。仅取 syncedLyrics（LRC），无时间戳的纯文本不可驱动卡拉OK。
   */
  async _lrclibLyric(title, artist) {
    const clean = (s) => String(s || '')
      .replace(/[（(【\[].*?[)）】\]]/g, '')   // 去括号补充（Live/feat/音质标注）
      .replace(/\s+/g, ' ').trim();
    const t = clean(title), a = clean(artist);
    if (!t) return null;
    const qs = `track_name=${encodeURIComponent(t)}&artist_name=${encodeURIComponent(a)}`;
    try {
      const r = await net.fetch(`https://lrclib.net/api/search?${qs}`, { timeout: 8000 });
      if (r.status !== 200) return null;
      const list = await r.json();
      if (!Array.isArray(list)) return null;
      // 逐条校验：歌名归一后必须完全一致；带歌手时歌手必须相近——
      // LRCLIB 搜索是模糊匹配，盲取首条会把同名不同歌的歌词配错
      const tN = this._normName(t), aN = this._normName(a);
      const hit = list.find((x) => {
        if (!x?.syncedLyrics || !x.syncedLyrics.includes('[')) return false;
        if (this._normName(x.trackName) !== tN) return false;
        if (aN && this._simTokens(this._normName(x.artistName), aN) < 0.5) return false;
        return true;
      });
      if (!hit) return null;
      return { lrc: hit.syncedLyrics, ttml: '', trans: '' };
    } catch { return null; }
  }

  /* 搜歌手：QQ音乐优先（用户指定），其后按启用顺序找首个实现 searchArtist 的源，返回非空结果 */
  async searchArtist(kw) {
    const ids = this.enabledIds(this.store.get('config')?.defaultSource);
    const ordered = ['qq', ...ids.filter((x) => x !== 'qq')];
    for (const id of ordered) {
      const api = this.srcApi(id);
      if (!api || typeof api.searchArtist !== 'function') continue;
      try {
        const r = await api.searchArtist(kw, 5);
        if (r?.length) { this._record(id, true); return r.map((a) => ({ ...a, srcId: id })); }
      } catch (e) { this._record(id, false, e.message); }
    }
    return [];
  }

  /** 歌词匹配（渲染层传入歌名/歌手）：原源优先 → 跨源匹配 → LRCLIB 公共库兜底 */
  async matchLyric({ srcId, id, title, artist }) {
    const primary = await this.getLyric(srcId || this.store.get('config')?.defaultSource || 'netease', id);
    if (primary.lrc || primary.yrc || primary.ttml || primary.pure) return primary;
    for (const sid of this.enabledIds(srcId).filter((x) => x !== srcId).slice(0, 3)) {
      const api = this.srcApi(sid);
      if (!api || typeof api.search !== 'function' || typeof api.getLyric !== 'function') continue;
      const m = await this._matchInSource(sid, title, artist);
      if (!m?.id) continue;
      const r = await this.getLyric(sid, m.id);
      if (r.lrc || r.yrc || r.ttml) return r;
    }
    // LRCLIB 最后兜底（成功则入缓存，键含歌名避免误命中）
    const ext = await this._lrclibLyric(title, artist);
    if (ext?.lrc) {
      this._cacheSet('cacheLyric', `lrclib::${title}|${artist}`, ext, 200);
      return ext;
    }
    return primary;
  }

  /* ================= 音频磁盘缓存（歌单预取） ================= */
  /* 用户要求：播放歌单内歌曲时，后台把同歌单后续在线歌曲缓存到本地，切歌读本地秒开。
     仅用户主动播放触发；LRU 上限 800MB；过短文件（试听/提示音 <64KB）不入缓存。 */
  _initAudioCache() {
    this._acDir = path.join(app.getPath('userData'), 'audio-cache');
    this._acIndexFile = path.join(this._acDir, 'index.json');
    this._acCap = 800 * 1024 * 1024;
    this._acMap = null;
    this._acInflight = new Set();
    this._acSeq = 0; // 预取代次：新一轮取代上一轮（快速连切歌时不做无用功）
  }
  _acLoad() {
    if (this._acMap) return;
    try { this._acMap = JSON.parse(fs.readFileSync(this._acIndexFile, 'utf8')) || {}; }
    catch { this._acMap = {}; }
  }
  _acSave() {
    try {
      fs.mkdirSync(this._acDir, { recursive: true });
      fs.writeFileSync(this._acIndexFile, JSON.stringify(this._acMap));
    } catch { /* 缓存索引写失败可忽略 */ }
  }
  audioCacheTake({ srcId, id } = {}) {
    this._acLoad();
    const key = `${srcId}::${id}`;
    const rec = this._acMap[key];
    if (!rec) return null;
    const fp = path.join(this._acDir, rec.file);
    if (!fs.existsSync(fp)) { delete this._acMap[key]; this._acSave(); return null; }
    rec.at = Date.now();
    this._acSave();
    return { url: pathToFileURL(fp).href, size: rec.size };
  }
  async audioCachePrefetch(tracks = []) {
    this._acLoad();
    const seq = ++this._acSeq;
    for (const t of tracks.slice(0, 12)) {
      if (seq !== this._acSeq) break;
      const srcId = t?.srcId || this.store.get('config')?.defaultSource || 'netease', id = String(t?.id ?? '');
      if (!id) continue;
      const key = `${srcId}::${id}`;
      if (this._acMap[key] || this._acInflight.has(key)) continue;
      this._acInflight.add(key);
      try {
        const r = await this.resolvePlayUrl({ srcId, id, title: t.title || '', artist: t.artist || '' });
        if (!r?.url) continue;
        // 手动跟 3xx（部分源直链是跳转端点）+ 补通用 UA（裸请求易被 CDN 拒）
        const baseHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', ...(r.headers || {}) };
        let u = r.url, bin = null;
        for (let hop = 0; hop < 5; hop++) {
          bin = await this.hostRequest({ url: u, headers: baseHeaders, encoding: 'buffer', timeout: 60000 });
          const loc = bin.headers?.location;
          if ([301, 302, 303, 307, 308].includes(bin.status) && loc) {
            u = new URL(Array.isArray(loc) ? loc[0] : loc, u).href;
            continue;
          }
          break;
        }
        if (!bin || (bin.status !== 200 && bin.status !== 206)) continue;
        const buf = Buffer.isBuffer(bin.body) ? bin.body : Buffer.from(bin.body || []);
        if (buf.length < 64 * 1024) continue;          // 过短：试听/提示音不入缓存
        if (buf.length > 100 * 1024 * 1024) continue;  // 超长 mix（>100MB）不占缓存额度
        fs.mkdirSync(this._acDir, { recursive: true });
        const file = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.bin`;
        fs.writeFileSync(path.join(this._acDir, file), buf);
        this._acMap[key] = { file, size: buf.length, at: Date.now(), title: t.title || '', artist: t.artist || '' };
        this._acEvict();
        this._acSave();
      } catch { /* 预取失败静默：不影响正常播放 */ }
      finally { this._acInflight.delete(key); }
    }
  }
  _acEvict() {
    const entries = Object.entries(this._acMap);
    let total = entries.reduce((a, [, r]) => a + (r.size || 0), 0);
    if (total <= this._acCap) return;
    entries.sort((a, b) => (a[1].at || 0) - (b[1].at || 0)); // 最久未用先删
    for (const [k, r] of entries) {
      if (total <= this._acCap) break;
      try {
        fs.unlinkSync(path.join(this._acDir, r.file));
        delete this._acMap[k];
        total -= r.size || 0;
      } catch { /* 文件被占用（正在播放）则保留 */ }
    }
  }
  /** 清空音频缓存（设置中心「清除缓存」）：返回释放的字节数与条目数 */
  audioCacheClear() {
    this._acLoad();
    this._acSeq++; // 取消进行中的预取轮次
    let freed = 0, n = 0, kept = 0;
    for (const [k, r] of Object.entries(this._acMap)) {
      try {
        fs.unlinkSync(path.join(this._acDir, r.file));
        delete this._acMap[k];
        freed += r.size || 0; n++;
      } catch { kept++; /* 被占用（正在播放）则保留 */ }
    }
    this._acSave();
    return { freed, count: n, kept };
  }

  /* ================= 音源版本更新检测 ================= */
  async checkUpdate(id) {
    const rec = this.plugins.get(id); // 全部音源均为外部插件，netease 无任何特判
    if (!rec) return { hasUpdate: false, msg: '该音源未加载（请在音源管理确认状态）' };
    const updateUrl = rec.manifest.updateUrl;
    if (!updateUrl) return { hasUpdate: false, msg: '该音源未提供更新地址' };
    try {
      const r = await net.fetch(updateUrl, { timeout: 8000 });
      const j = await r.json();
      const latest = j.version || j.latest || '';
      const hasUpdate = !!latest && cmpVer(latest, rec.manifest.version || '0.0.0') > 0;
      return { hasUpdate, local: rec.manifest.version, latest, notes: j.notes || '', url: j.url || '' };
    } catch (e) {
      return { hasUpdate: false, msg: '检测失败：' + e.message };
    }
  }
}

/* ================= IPC 装配 ================= */
export function registerSourceIPC(mgr) {
  ipcMain.handle('source:list', () => mgr.list());
  ipcMain.handle('source:import', async (_e, filePath) => mgr.importFromFile(filePath));
  ipcMain.handle('source:remove', (_e, id) => mgr.remove(id));
  ipcMain.handle('source:toggle', (_e, id, on) => mgr.toggle(id, on));
  ipcMain.handle('source:search', async (_e, srcId, kw, page) => {
    const api = mgr.srcApi(srcId);
    if (!api || typeof api.search !== 'function') return [];
    try {
      const hintP = mgr._originalArtistHint(kw);
      const r = await api.search(kw, page || 1);
      mgr._record(srcId, true);
      return mgr._rankOriginal(mgr._playableOnly(r || []), kw, await hintP);
    }
    catch (e) { mgr._record(srcId, false, e.message); throw e; }
  });
  ipcMain.handle('source:search-all', (_e, kw) => mgr.searchAll(kw));
  ipcMain.handle('source:search-artist', (_e, kw) => mgr.searchArtist(kw));
  ipcMain.handle('source:artist-albums', (_e, srcId, id) => {
    const api = mgr.srcApi(srcId);
    return api && typeof api.artistAlbums === 'function' ? api.artistAlbums(id) : { artist: '', coverUrl: '', albums: [] };
  });
  ipcMain.handle('source:artist-top', (_e, srcId, id, name) => {
    const api = mgr.srcApi(srcId);
    return api && typeof api.artistTopSongs === 'function' ? api.artistTopSongs(id, 60, name) : { artist: '', coverUrl: '', songs: [] };
  });
  ipcMain.handle('source:feed', () => mgr.feed());
  ipcMain.handle('source:pldetail', (_e, pid) => mgr.playlistDetail(pid));
  ipcMain.handle('source:user-playlists', (_e, srcId) => mgr.userPlaylists(srcId));
  ipcMain.handle('source:config:get', () => mgr.getConfig());
  ipcMain.handle('source:config:set', (_e, patch) => mgr.setConfig(patch));
  ipcMain.handle('source:playurl', (_e, spec) => mgr.resolvePlayUrl(spec));
  ipcMain.handle('source:lyric', (_e, srcId, id) => mgr.getLyric(srcId, id));
  ipcMain.handle('source:lyric-match', (_e, spec) => mgr.matchLyric(spec || {}));
  // 音频字节流（经代理 + 限流；仅内存中转，不落盘）
  ipcMain.handle('source:binary', async (_e, url, headers) => {
    try {
      const r = await mgr.hostRequest({ url, headers: headers || {}, encoding: 'buffer', timeout: 30000 });
      if (r.status !== 200 && r.status !== 206) return null;
      return { data: r.body, contentType: String(r.headers['content-type'] || 'audio/mpeg') };
    } catch { return null; }
  });
  // 歌单音频磁盘缓存：取命中 / 后台预取（立即返回，下载在主进程排队进行）
  ipcMain.handle('audio-cache:take', (_e, spec) => mgr.audioCacheTake(spec || {}));
  ipcMain.handle('audio-cache:prefetch', (_e, tracks) => { mgr.audioCachePrefetch(tracks || []).catch(() => {}); return true; });
  ipcMain.handle('audio-cache:clear', () => mgr.audioCacheClear());
  // 扫码登录相关 IPC（start-qr-login / cancel-qr-login / source:login:platforms / source:logout）
  // 统一由 sources/qrologin.js 的 registerQrLoginIPC 注册
  ipcMain.handle('source:login:info', (_e, srcId) => mgr.loginInfo(srcId));
  ipcMain.handle('source:proxy:get', () => mgr.getProxies());
  ipcMain.handle('source:proxy:set', (_e, list, enabled) => { mgr.setProxies(list, enabled); return true; });
  ipcMain.handle('source:update:check', (_e, id) => mgr.checkUpdate(id));
  // 播放直链经渲染层 Audio 元素直接播放（blob 除外）；跨域直链放行由 CSP media-src 控制
}

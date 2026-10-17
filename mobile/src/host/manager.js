/* 移动端音源 Manager：内置 qq/netease 插件，复刻桌面 manager 的 host 契约与换源/排序调度，
   网络走原生 RhythmNet，Cookie/配置走 localStorage。 */
import neManifest from '../../../sources/plugins/netease.js';
import qqManifest from '../../../sources/plugins/qq.js';
import { pluginRequest, rawRequest } from '../net.js';
import { CookieJar } from '../jar.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BUILTIN_ORDER = ['netease', 'qq'];

export class MobileSourceManager {
  constructor() {
    this.jar = new CookieJar();
    this.plugins = new Map();   // id -> { api, name, enabled }
    this.stats = new Map();
    this.cacheMeta = new Map();
    this._hintCache = new Map();
    this._notifyCbs = new Set();
    this.loginCookieKeys = { netease: ['MUSIC_U'], qq: ['qm_keyst', 'qqmusic_key'] };
    this.profiles = this._readJSON('rv-login-profiles', {});
  }

  _readJSON(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key) || '') ?? fallback; }
    catch { return fallback; }
  }
  _writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch { /* ignore */ }
  }

  async init() {
    const enabled = this._readJSON('rv-src-enabled', {});
    for (const manifest of [neManifest, qqManifest]) {
      const rec = { api: manifest, name: manifest.name || manifest.id, enabled: enabled[manifest.id] !== false };
      const host = this._makeHost(manifest.id);
      this.plugins.set(manifest.id, rec);
      try { await manifest.init?.(host); } catch (e) { console.error('[source] init 失败', manifest.id, e); }
    }
  }

  onNotify(cb) { this._notifyCbs.add(cb); return () => this._notifyCbs.delete(cb); }
  _notify(msg) { for (const cb of this._notifyCbs) { try { cb(msg); } catch { /* noop */ } } }

  /* ---------------- 统计 / 健康度 ---------------- */
  _stat(id) {
    if (!this.stats.has(id)) this.stats.set(id, { ok: 0, fail: 0, failAt: 0, msg: '' });
    return this.stats.get(id);
  }
  _record(id, ok, msg) {
    const s = this._stat(id);
    if (ok) { s.ok++; s.fail = 0; s.failAt = 0; s.msg = ''; }
    else { s.fail++; s.failAt = Date.now(); if (msg) s.msg = msg; }
  }
  _dead(id) {
    const s = this._stat(id);
    return s.fail >= 3 && Date.now() - s.failAt < 5 * 60 * 1000;
  }
  _markAlive(id) { const s = this._stat(id); s.fail = 0; s.failAt = 0; }

  srcApi(id) { return this.plugins.get(id)?.api || null; }
  _enabledOf(id) { return this.plugins.get(id)?.enabled !== false; }

  getConfig() { return this._readJSON('rv-src-config', {}); }
  setConfig(patch) {
    const cfg = { ...this.getConfig(), ...(patch || {}) };
    this._writeJSON('rv-src-config', cfg);
    return cfg;
  }
  _defaultSrc() { return this.getConfig().defaultSource || 'netease'; }

  list() {
    const out = [];
    for (const [id, rec] of this.plugins) {
      out.push({
        id, name: rec.name, version: rec.api.version || '0.0.0',
        builtin: true, enabled: rec.enabled, filename: '', updateUrl: '',
        stats: this._stat(id), loggedIn: this.loginInfo(id).loggedIn
      });
    }
    return out;
  }
  toggle(id, on) {
    const rec = this.plugins.get(id);
    if (!rec) return { ok: false, msg: '音源不存在' };
    rec.enabled = on !== false;
    const m = this._readJSON('rv-src-enabled', {});
    m[id] = rec.enabled;
    this._writeJSON('rv-src-enabled', m);
    return { id, enabled: rec.enabled };
  }

  /* ---------------- 插件 host ---------------- */
  _makeHost(pluginId) {
    const self = this;
    return {
      version: '1.0.0',
      get id() { return pluginId; },
      net: {
        request: (opts) => self._hostRequest(opts),
        async get(url, opts = {}) {
          const cookie = self.jar.header(pluginId, url);
          const headers = { ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) };
          return self._hostRequest({ ...opts, url, headers });
        },
        async post(url, body, opts = {}) {
          const cookie = self.jar.header(pluginId, url);
          const headers = { ...opts.headers, ...(cookie ? { Cookie: cookie } : {}) };
          return self._hostRequest({ ...opts, url, method: 'POST', body, headers });
        }
      },
      cookieJar: {
        get: (domain) => self.jar.get(pluginId, domain),
        set: (domain, cookies) => self.jar.set(pluginId, domain, cookies),
        clear: (domain) => self.jar.clear(pluginId, domain),
        header: (url) => self.jar.header(pluginId, url)
      },
      login: {
        info: () => self.loginInfo(pluginId),
        logout: () => self.logout(pluginId)
      },
      storage: {
        get(key) { const s = self._readJSON('rv-pstore-' + pluginId, {}); return s?.[key]; },
        set(key, val) {
          const s = self._readJSON('rv-pstore-' + pluginId, {});
          s[key] = val;
          self._writeJSON('rv-pstore-' + pluginId, s);
        }
      },
      cache: {
        get(key) {
          const hit = self.cacheMeta.get(pluginId + '::' + key);
          if (!hit) return undefined;
          if (Date.now() - hit.ts > 14 * 24 * 3600 * 1000) { self.cacheMeta.delete(pluginId + '::' + key); return undefined; }
          return hit.data;
        },
        set(key, data) {
          const k = pluginId + '::' + key;
          self.cacheMeta.set(k, { data, ts: Date.now() });
          if (self.cacheMeta.size > 300) {
            const oldest = [...self.cacheMeta.entries()].sort((a, b) => a[1].ts - b[1].ts)[0]?.[0];
            if (oldest) self.cacheMeta.delete(oldest);
          }
        }
      },
      log: (...a) => console.log('[source:' + pluginId + ']', ...a),
      notify: (msg) => self._notify(`[音源] ${msg}`)
    };
  }

  async _hostRequest(opts = {}) {
    const timeout = opts.timeout || 15000;
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await pluginRequest({ ...opts, timeout });
        if (r.status === 403 || r.status === 401) {
          throw Object.assign(new Error(`HTTP ${r.status}（风控/签名失效）`), { code: 'E_FORBIDDEN' });
        }
        if (r.status >= 500 || r.status === 429) {
          throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'E_SERVER' });
        }
        return r;
      } catch (e) {
        if (e?.code === 'E_FORBIDDEN') throw e;
        if (attempt >= 3) throw e;
        await sleep(600 * 2 ** (attempt - 1) + Math.random() * 300);
      }
    }
  }

  /* ---------------- 登录态 ---------------- */
  loginInfo(pluginId) {
    const space = this.jar.data[pluginId] || {};
    const all = Object.values(space).flat();
    const keys = this.loginCookieKeys[pluginId] || this.srcApi(pluginId)?.loginCookieKeys || [];
    const loggedIn = keys.length ? all.some((c) => keys.includes(c.name) && c.value) : all.length > 0;
    return {
      loggedIn, count: all.length, domains: Object.keys(space),
      names: [...new Set(all.map((c) => c.name))].slice(0, 12),
      profile: this.profiles[pluginId] || null
    };
  }
  saveProfile(pluginId, profile) {
    if (!profile) return;
    this.profiles[pluginId] = {
      userId: String(profile.userId || this.profiles[pluginId]?.userId || ''),
      nickname: profile.nickname || this.profiles[pluginId]?.nickname || '',
      avatar: profile.avatar || this.profiles[pluginId]?.avatar || ''
    };
    this._writeJSON('rv-login-profiles', this.profiles);
  }
  logout(pluginId) {
    this.jar.clear(pluginId);
    delete this.profiles[pluginId];
    this._writeJSON('rv-login-profiles', this.profiles);
    return this.loginInfo(pluginId);
  }

  /* ---------------- 搜索 ---------------- */
  enabledIds(prefer) {
    const ids = [];
    if (prefer && this.plugins.has(prefer) && this._enabledOf(prefer) && !this._dead(prefer)) ids.push(prefer);
    for (const [id, rec] of this.plugins) {
      if (rec.enabled && !ids.includes(id) && !this._dead(id)) ids.push(id);
    }
    return ids;
  }
  _playableOnly(list) {
    return (list || []).filter((s) => s && !s.trial && (!s.duration || s.duration >= 40000));
  }
  async search(srcId, kw, page) {
    const api = this.srcApi(srcId);
    if (!api || typeof api.search !== 'function') return [];
    try {
      const hintP = this._originalArtistHint(kw);
      const r = await api.search(kw, page || 1);
      this._record(srcId, true);
      return this._rankOriginal(this._playableOnly(r || []), kw, await hintP);
    } catch (e) {
      this._record(srcId, false, e.message);
      throw e;
    }
  }
  async searchAll(kw) {
    const hintP = this._originalArtistHint(kw);
    const ids = this.enabledIds(this._defaultSrc());
    const settled = await Promise.allSettled(ids.map(async (id) => {
      const list = await this.srcApi(id).search(kw, 1);
      this._markAlive(id);
      return this._playableOnly(list).slice(0, 30)
        .map((s) => ({ ...s, srcId: s.srcId || id, srcName: s.srcName || this.srcApi(id).name || id }));
    }));
    const out = [];
    for (const r of settled) {
      if (r.status === 'fulfilled') out.push(...r.value);
      else console.warn('[search-all] 源失败', r.reason?.message || r.reason);
    }
    return this._rankOriginal(out, kw, await hintP);
  }
  async searchArtist(kw) {
    // 桌面版聚合艺人搜索：移动版按默认源实现
    const api = this.srcApi(this._defaultSrc());
    if (api?.searchArtist) return api.searchArtist(kw);
    return [];
  }
  artistAlbums(srcId, id) {
    const api = this.srcApi(srcId);
    return api?.artistAlbums ? api.artistAlbums(id) : { artist: '', coverUrl: '', albums: [] };
  }
  artistTop(srcId, id, name) {
    const api = this.srcApi(srcId);
    return api?.artistTopSongs ? api.artistTopSongs(id, 60, name) : { artist: '', coverUrl: '', songs: [] };
  }

  /* ---------------- 首页 / 歌单 ---------------- */
  async feed() {
    const pref = this._defaultSrc();
    const order = [...new Set([pref, ...BUILTIN_ORDER, ...this.enabledIds()])];
    for (const id of order) {
      const api = this.srcApi(id);
      if (!api || !this._enabledOf(id) || this._dead(id)) continue;
      try {
        let hot = [];
        if (typeof api.trending === 'function') hot = (await api.trending(50)) || [];
        else if (typeof api.search === 'function') hot = ((await api.search('热门歌曲', 1)) || []).slice(0, 50);
        hot = this._playableOnly(hot);
        const playlists = typeof api.playlists === 'function' ? ((await api.playlists(16)) || []) : [];
        if (hot.length || playlists.length) {
          this._markAlive(id);
          return {
            hot: hot.slice(0, 50).map((s) => ({ ...s, srcId: s.srcId || id, srcName: s.srcName || api.name || id })),
            playlists, source: id, sourceName: api.name || id
          };
        }
      } catch (e) {
        this._record(id, false, e.message);
      }
    }
    return { hot: [], playlists: [], source: pref, sourceName: '' };
  }
  async userPlaylists(srcId) {
    const api = this.srcApi(srcId);
    if (!api?.userPlaylists) return [];
    try {
      const list = (await api.userPlaylists()) || [];
      this._markAlive(srcId);
      return list.map((p) => ({ ...p, srcId: p.srcId || srcId, srcName: p.srcName || api.name || srcId }));
    } catch (e) { this._record(srcId, false, e.message); return []; }
  }
  async playlistDetail(pid) {
    const m = /^pl:([^:]+):(.+)$/.exec(String(pid));
    if (m) {
      const srcId = m[1], raw = m[2];
      const api = this.srcApi(srcId);
      const tag = (t) => ({ ...t, srcId: t.srcId || srcId, srcName: t.srcName || api?.name });
      if (raw.startsWith('album:')) {
        if (!api?.albumDetail) return { name: '', coverUrl: '', tracks: [], msg: '该专辑所属音源不可用' };
        try {
          const det = await api.albumDetail(raw.slice(6));
          this._record(srcId, true);
          det.tracks = this._playableOnly((det.tracks || []).map(tag));
          return det;
        } catch (e) { this._record(srcId, false, e.message); return { name: '', coverUrl: '', tracks: [], msg: e.message }; }
      }
      if (!api?.playlistDetail) return { name: '', coverUrl: '', tracks: [], msg: '该歌单所属音源不可用' };
      try {
        const det = await api.playlistDetail(raw);
        this._record(srcId, true);
        det.tracks = this._rankOriginal(this._playableOnly((det.tracks || []).map(tag)));
        return det;
      } catch (e) { this._record(srcId, false, e.message); return { name: '', coverUrl: '', tracks: [], msg: e.message }; }
    }
    const ne = this.srcApi('netease');
    if (ne?.getPlaylistDetail) {
      try {
        const det = await ne.getPlaylistDetail(pid);
        if (det?.tracks) { det.tracks = this._rankOriginal(this._playableOnly(det.tracks)); return det; }
      } catch { /* fallthrough */ }
    }
    return { name: '', coverUrl: '', tracks: [], msg: '歌单不存在或所属音源未启用' };
  }

  /* ---------------- 播放地址 + 换源 ---------------- */
  // WebView 页面为 https scheme，http 音频会被 mixed content 拦截；直链域名均支持 https
  _up(url) { return typeof url === 'string' ? url.replace(/^http:\/\//i, 'https://') : url; }
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
      if (bad) return { ok: false, msg: bad, skip: true };
      return { ok: true, url: r.url, br: r.br || null, headers: r.headers || null };
    } catch (e) {
      this._record(srcId, false, e.message);
      return { ok: false, msg: e.message, code: e.code || 'E_NET' };
    }
  }
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
    const as = (!a1 || !a2) ? 0.5 : (a1 === a2 ? 1 : this._simTokens(a1, a2));
    return ts * 0.68 + as * 0.32;
  }
  _coverish(m) {
    const s = `${m?.name || ''} ${m?.artist || ''} ${m?.album || ''}`;
    return /(cover|翻[唱自]|现场|\blive\b|remix|混音|\bdj\b|伴奏|instrumental|karaoke|卡拉ok|demo|小样|tribute|致敬|烟嗓|女生版|男生版|女声版|男声版|童声版|深情版|抒情版|钢琴版|吉他版|弹唱|清唱|纯音乐|加速版|降调|变速|翻奏|（\s*原唱|\(\s*原唱|原唱[:：]|出版社|作品集|精选集|翻唱集)/i.test(s);
  }
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
  async _originalArtistHint(kw) {
    const key = String(kw || '').trim().toLowerCase();
    if (!key) return '';
    if (this._hintCache.has(key)) return this._hintCache.get(key);
    let hint = '';
    try {
      const r = await rawRequest({
        url: `https://lrclib.net/api/search?track_name=${encodeURIComponent(key)}`,
        method: 'GET', headers: {}, timeoutMs: 6000
      });
      if (r.status === 200) {
        const list = JSON.parse(new TextDecoder().decode(r.bytes));
        const keyN = this._normName(key);
        const hit = Array.isArray(list) ? list.find((x) => x?.artistName && this._normName(x?.trackName) === keyN) : null;
        hint = hit ? String(hit.artistName || '').trim() : '';
      }
    } catch { /* ignore */ }
    if (this._hintCache.size > 300) this._hintCache.delete(this._hintCache.keys().next().value);
    this._hintCache.set(key, hint);
    return hint;
  }
  async _matchInSource(srcId, title, artist) {
    const api = this.srcApi(srcId);
    if (!api?.search) return null;
    try {
      const list = await api.search([title, artist].filter(Boolean).join(' '), 1);
      this._record(srcId, true);
      let best = null, bs = 0;
      for (const m of (list || []).slice(0, 5)) {
        const s = this._matchScore(m, title, artist);
        if (s > bs) { bs = s; best = m; }
      }
      if (bs < 0.72 || !best) return null;
      if (artist) {
        const asim = this._simTokens(this._normName(artist), this._normName(best.artist || best.singer || ''));
        if (asim < 0.35) return null;
      }
      return best;
    } catch (e) { this._record(srcId, false, e.message); return null; }
  }
  async resolvePlayUrl({ srcId, id, title, artist, quality }) {
    if (!srcId) srcId = this._defaultSrc();
    const attempts = [];
    if (srcId && this.srcApi(srcId)) {
      const r = await this._trySource(srcId, id, quality);
      if (r.ok) return { url: this._up(r.url), br: r.br, headers: r.headers, srcId, via: srcId };
      attempts.push(`${srcId}: ${r.msg}`);
    }
    let switched = 0;
    for (const sid of this.enabledIds(srcId).filter((x) => x !== srcId)) {
      if (switched >= 3) break;
      const m = await this._matchInSource(sid, title, artist);
      if (!m?.id) { attempts.push(`${sid}: 无匹配`); continue; }
      const r = await this._trySource(sid, m.id, quality);
      attempts.push(`${sid}: ${r.ok ? 'OK' : r.msg}`);
      if (r.ok) {
        return { url: this._up(r.url), br: r.br, headers: r.headers, srcId: sid, via: sid, newId: m.id, name: m.name };
      }
    }
    return { url: null, msg: `全部音源均失败（${attempts.join('；')}）` };
  }

  /* ---------------- 歌词 ---------------- */
  async getLyric(srcId, songId) {
    const api = this.srcApi(srcId);
    const empty = { lrc: '', yrc: '', ttml: '', trans: '' };
    if (!api?.getLyric) return empty;
    try {
      const r = await api.getLyric(songId);
      this._record(srcId, true);
      return { ...empty, ...r };
    } catch (e) { this._record(srcId, false, e.message); return empty; }
  }
  async matchLyric({ srcId, id, title, artist }) {
    const primaryId = srcId || this._defaultSrc();
    const primary = await this.getLyric(primaryId, id);
    if (primary.lrc || primary.yrc || primary.ttml) return primary;
    for (const sid of this.enabledIds(primaryId).filter((x) => x !== primaryId)) {
      const m = await this._matchInSource(sid, title, artist);
      if (!m?.id) continue;
      const r = await this.getLyric(sid, m.id);
      if (r.lrc || r.yrc || r.ttml) return r;
    }
    return primary;
  }

  /* ---------------- 字节流（音频 / 封面） ---------------- */
  async binary(url, headers = {}) {
    const { binaryFetch } = await import('../net.js');
    try {
      const bin = await binaryFetch(url, headers, 30000);
      return { data: bin.data, contentType: bin.contentType };
    } catch (e) {
      console.warn('[binary] 失败', url, e.message);
      return null;
    }
  }

  updateCheck() { return { hasUpdate: false, msg: '内置音源随应用更新' }; }
}

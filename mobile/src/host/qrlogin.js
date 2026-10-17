/* 纯 HTTP 扫码登录（无隐藏窗口）：
   - 网易云：unikey 出码 → codekey 本地生成二维码 → client/login 轮询 → Set-Cookie 取 MUSIC_U
   - QQ音乐：ptqrshow 出码（qrsig）→ hash33 算 ptqrtoken → ptqrlogin 轮询 → 跟随 check_sig 重定向链收 qm_keyst
   手机不能自己扫自己：二维码展示在屏幕上，需用【另一台设备】的 App 扫码确认。 */
import { rawRequest, toDataUrl } from '../net.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const PLATFORMS = {
  netease: { srcId: 'netease', name: '网易云音乐', hint: '请使用【另一台手机】打开网易云音乐 App → 左上角「扫一扫」扫描本屏幕二维码' },
  qqmusic: { srcId: 'qq', name: 'QQ音乐', hint: '请使用【另一台手机】打开 QQ 音乐或 QQ →「扫一扫」扫描本屏幕二维码' }
};

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 从 cookie 列表取域名匹配的 Cookie 头 */
function cookieHeader(cookies, url) {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* noop */ }
  const keep = (c) => {
    const d = String(c.domain || '').replace(/^\./, '');
    return !d || host === d || host.endsWith('.' + d) || host.endsWith(d);
  };
  return (cookies || []).filter(keep).map((c) => `${c.name}=${c.value}`).join('; ');
}

/** QQ hash33（DJB 变种）算 ptqrtoken */
function hash33(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h += ((h << 5) + str.charCodeAt(i));
  return h & 0x7fffffff;
}

export class QrLoginManager {
  constructor(mgr) {
    this.mgr = mgr;
    this.sessions = new Map(); // platform -> { seq, cancelled }
    this._updateCbs = new Set();
    this._successCbs = new Set();
  }
  onUpdate(cb) { this._updateCbs.add(cb); return () => this._updateCbs.delete(cb); }
  onSuccess(cb) { this._successCbs.add(cb); return () => this._successCbs.delete(cb); }
  _emitUpdate(d) { for (const cb of this._updateCbs) { try { cb(d); } catch { /* noop */ } } }
  _emitSuccess(d) { for (const cb of this._successCbs) { try { cb(d); } catch { /* noop */ } } }

  cancel(platform) {
    const s = this.sessions.get(platform);
    if (s) s.cancelled = true;
  }

  platforms() {
    return ['netease', 'qqmusic'].map((id) => {
      const cfg = PLATFORMS[id];
      const info = this.mgr.loginInfo(cfg.srcId);
      return {
        id, name: cfg.name, kind: 'qr', hint: cfg.hint,
        loggedIn: info.loggedIn, profile: info.profile || null
      };
    });
  }

  async start(platform) {
    const cfg = PLATFORMS[platform];
    if (!cfg) return { ok: false, msg: '不支持的平台' };
    this.cancel(platform);
    const seq = { seq: Date.now() + Math.floor(Math.random() * 1e6), cancelled: false };
    this.sessions.set(platform, seq);

    // 已有有效登录态：直接复用
    const info = this.mgr.loginInfo(cfg.srcId);
    if (info.loggedIn && info.profile?.nickname) {
      this._emitSuccess({ platform, name: cfg.name, profile: info.profile, reused: true });
      return { ok: true, reused: true, msg: '登录态仍有效，已直接复用' };
    }

    try {
      if (platform === 'netease') return await this._startNetease(seq, cfg);
      if (platform === 'qqmusic') return await this._startQq(seq, cfg);
    } catch (e) {
      return { ok: false, msg: e.message || '二维码获取失败' };
    }
    return { ok: false, msg: '不支持的平台' };
  }

  /* ============================ 网易云 ============================ */
  async _startNetease(seq, cfg) {
    const r = await rawRequest({
      url: 'https://music.163.com/api/login/qrcode/unikey?type=1',
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Referer: 'https://music.163.com/',
        'X-Real-IP': '118.88.88.88'
      },
      timeoutMs: 12000
    });
    let j;
    try { j = JSON.parse(new TextDecoder().decode(r.bytes)); } catch { throw new Error('unikey 解析失败'); }
    const unikey = j.unikey;
    if (!unikey) throw new Error(j.msg || '获取二维码凭证失败');

    // 后台轮询（不阻塞 start 返回；二维码文本交前端本地渲染）
    this._pollNetease(seq, unikey, r.cookies || [], cfg);
    return {
      ok: true, qrToken: String(seq.seq),
      content: `https://music.163.com/login?codekey=${unikey}`,
      hint: cfg.hint
    };
  }

  async _pollNetease(seq, unikey, seedCookies, cfg) {
    let cookies = [...(seedCookies || [])];
    let scannedSent = false;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      if (seq.cancelled) return;
      await sleep(2500);
      if (seq.cancelled) return;
      try {
        const ck = cookieHeader(cookies, 'https://music.163.com/');
        const r = await rawRequest({
          url: `https://music.163.com/api/login/qrcode/client/login?key=${encodeURIComponent(unikey)}&type=1`,
          method: 'POST',
          headers: {
            'User-Agent': UA,
            Referer: 'https://music.163.com/',
            Origin: 'https://music.163.com',
            'X-Real-IP': '118.88.88.88',
            'Content-Type': 'application/x-www-form-urlencoded',
            ...(ck ? { Cookie: ck } : {})
          },
          text: `key=${encodeURIComponent(unikey)}&type=1`,
          timeoutMs: 12000
        });
        const j = JSON.parse(new TextDecoder().decode(r.bytes));
        const code = j.code;
        if (Array.isArray(r.cookies) && r.cookies.length) cookies = r.cookies;
        if (code === 802 && !scannedSent) {
          // 已扫码，等待在手机上确认
          scannedSent = true;
          this._emitUpdate({ platform: 'netease', type: 'scanned', token: String(seq.seq) });
        }
        if (code === 803) {
          // 成功：MUSIC_U 在本响应 Set-Cookie（Node 侧 r.cookies；原生侧为全量 CookieStore）
          this.mgr.jar.merge('netease', cookies);
          const profile = await this._neteaseProfile();
          if (profile) this.mgr.saveProfile('netease', profile);
          this._emitSuccess({
            platform: 'netease', name: cfg.name,
            profile: profile || { nickname: '', avatar: '' }
          });
          return;
        }
        if (code === 800) {
          this._emitUpdate({ platform: 'netease', type: 'expired', token: String(seq.seq) });
          return;
        }
      } catch (e) {
        // 网络抖动继续轮询
      }
    }
    this._emitUpdate({ platform: 'netease', type: 'expired', token: String(seq.seq) });
  }

  async _neteaseProfile() {
    try {
      const ck = this.mgr.jar.cookieString('netease', 'music.163.com');
      if (!ck) return null;
      const r = await rawRequest({
        url: 'https://music.163.com/api/w/nuser/account/get',
        method: 'GET',
        headers: {
          'User-Agent': UA, Referer: 'https://music.163.com/',
          'X-Real-IP': '118.88.88.88', Cookie: ck
        },
        timeoutMs: 10000
      });
      const j = JSON.parse(new TextDecoder().decode(r.bytes));
      const p = j.profile || j.account;
      if (!p || p.code === 301) return null;
      return {
        userId: String(p.userId || p.id || ''),
        nickname: String(p.nickname || '').trim(),
        avatar: p.avatarUrl || p.avatar || ''
      };
    } catch { return null; }
  }

  /* ============================ QQ音乐 ============================ */
  async _startQq(seq, cfg) {
    const t = String(Math.random().toFixed(16)).replace('0.', '');
    const showUrl = `https://ssl.ptlogin2.qq.com/ptqrshow?appid=716027609&e=2&l=M&s=3&d=72&v=4&t=${t}&daid=384&pt_3rd_aid=0`;
    const r = await rawRequest({
      url: showUrl, method: 'GET',
      headers: { 'User-Agent': UA, Referer: 'https://xui.ptlogin2.qq.com/' },
      timeoutMs: 12000
    });
    if (r.status !== 200 || r.bytes.length < 100) throw new Error('二维码获取失败 HTTP ' + r.status);
    let cookies = [...(r.cookies || [])];
    const qrsig = cookies.find((c) => c.name === 'qrsig')?.value;
    if (!qrsig) throw new Error('未获取到 qrsig');
    const qrSrc = toDataUrl(r.bytes, r.headers['content-type'] || 'image/png');
    this._emitUpdate({ platform: 'qqmusic', type: 'refresh', qrSrc, token: String(seq.seq) });
    this._pollQq(seq, qrsig, cookies, cfg);
    return { ok: true, qrToken: String(seq.seq), qrSrc, hint: cfg.hint };
  }

  async _pollQq(seq, qrsig, seedCookies, cfg) {
    const token = hash33(qrsig);
    let cookies = [...(seedCookies || [])];
    let scannedSent = false;
    const deadline = Date.now() + 180000;
    const u1 = 'https://y.qq.com/portal/close.html';
    while (Date.now() < deadline) {
      if (seq.cancelled) return;
      await sleep(2500);
      if (seq.cancelled) return;
      try {
        const ck = cookieHeader(cookies, 'https://ssl.ptlogin2.qq.com/');
        const url = `https://ssl.ptlogin2.qq.com/ptqrlogin?u1=${encodeURIComponent(u1)}`
          + `&ptqrtoken=${token}&ptredirect=0&h=1&t=1&g=1&from_ui=1&ptlang=2052`
          + `&action=0-0-${Date.now()}&js_ver=25042814&js_type=1&login_sig=&pt_uistyle=40`
          + `&aid=716027609&daid=384&pt_no_auth=1&with_xlogin=0`;
        const r = await rawRequest({
          url, method: 'GET',
          headers: {
            'User-Agent': UA,
            Referer: 'https://xui.ptlogin2.qq.com/',
            ...(ck ? { Cookie: ck } : {})
          },
          timeoutMs: 12000
        });
        const body = new TextDecoder().decode(r.bytes);
        if (Array.isArray(r.cookies) && r.cookies.length) cookies = r.cookies;
        const fields = (body.match(/'([^']*)'/g) || []).map((s) => s.slice(1, -1));
        const code = fields[0];
        if (code === '66') {
          // 二维码未失效，等待扫码
        } else if (code === '67') {
          if (!scannedSent) {
            scannedSent = true;
            this._emitUpdate({ platform: 'qqmusic', type: 'scanned', token: String(seq.seq) });
          }
        } else if (code === '65' || code === '17') {
          this._emitUpdate({ platform: 'qqmusic', type: 'expired', token: String(seq.seq) });
          return;
        } else if (code === '0') {
          const jumpUrl = fields[2] || '';
          if (!jumpUrl) throw new Error('登录成功但缺少跳转地址');
          const ok = await this._finishQq(seq, jumpUrl, cookies, cfg);
          if (ok) return;
        }
      } catch (e) {
        // 网络抖动继续
      }
    }
    this._emitUpdate({ platform: 'qqmusic', type: 'expired', token: String(seq.seq) });
  }

  /** 跟随 check_sig / crossdomain 重定向链，在 y.qq.com 域收 qm_keyst/qqmusic_key */
  async _finishQq(seq, jumpUrl, seedCookies, cfg) {
    const ck = cookieHeader(seedCookies, jumpUrl);
    const r = await rawRequest({
      url: jumpUrl, method: 'GET',
      headers: {
        'User-Agent': UA,
        Referer: 'https://xui.ptlogin2.qq.com/',
        ...(ck ? { Cookie: ck } : {})
      },
      followRedirects: true,
      timeoutMs: 15000
    });
    // 原生侧：全量 CookieStore（含重定向链每一跳）；Node 侧只有最终一跳（仅用于 PoC）
    const all = Array.isArray(r.cookies) && r.cookies.length ? r.cookies : seedCookies;
    this.mgr.jar.merge('qq', all);
    const hasKey = (this.mgr.jar.get('qq', 'y.qq.com') || [])
      .some((c) => (c.name === 'qm_keyst' || c.name === 'qqmusic_key') && c.value);
    if (!hasKey) {
      // 部分流程首跳只到 check_sig，需再访问 y.qq.com 促使业务域签发
      const r2 = await rawRequest({
        url: 'https://y.qq.com/', method: 'GET',
        headers: {
          'User-Agent': UA,
          Cookie: this.mgr.jar.cookieString('qq', 'y.qq.com') || cookieHeader(all, 'https://y.qq.com/')
        },
        timeoutMs: 15000
      });
      if (Array.isArray(r2.cookies) && r2.cookies.length) this.mgr.jar.merge('qq', r2.cookies);
    }
    const finalHasKey = (this.mgr.jar.get('qq', 'y.qq.com') || [])
      .some((c) => (c.name === 'qm_keyst' || c.name === 'qqmusic_key') && c.value);
    if (!finalHasKey) {
      this._emitUpdate({ platform: 'qqmusic', type: 'expired', token: String(seq.seq) });
      return false;
    }
    const profile = await this._qqProfile();
    if (profile) this.mgr.saveProfile('qq', profile);
    this._emitSuccess({
      platform: 'qqmusic', name: cfg.name,
      profile: profile || { nickname: '', avatar: '' }
    });
    return true;
  }

  /**
   * 原生 QQ 快捷登录回传：App 内 WebView 完成 QQ 授权后收割到的 Cookie
   * （[{name,value,domain,path}]）→ 并入 Jar → 校验/补签 qm_keyst → 成功事件。
   */
  async finishQqFromCookies(pairs) {
    const cfg = PLATFORMS.qqmusic;
    const cookies = (pairs || []).map((p) => ({
      name: String(p.name || ''),
      value: String(p.value || ''),
      domain: p.domain || 'y.qq.com',
      path: p.path || '/'
    })).filter((c) => c.name);
    this.mgr.jar.merge('qq', cookies);
    let hasKey = (this.mgr.jar.get('qq', 'y.qq.com') || [])
      .some((c) => (c.name === 'qm_keyst' || c.name === 'qqmusic_key') && c.value);
    if (!hasKey) {
      // 业务域 Cookie 尚未签发：带登录态访问 y.qq.com 根，促使 Set-Cookie
      const r2 = await rawRequest({
        url: 'https://y.qq.com/', method: 'GET',
        headers: {
          'User-Agent': UA,
          Cookie: this.mgr.jar.cookieString('qq', 'y.qq.com')
        },
        timeoutMs: 15000
      }).catch(() => null);
      if (Array.isArray(r2?.cookies) && r2.cookies.length) this.mgr.jar.merge('qq', r2.cookies);
      hasKey = (this.mgr.jar.get('qq', 'y.qq.com') || [])
        .some((c) => (c.name === 'qm_keyst' || c.name === 'qqmusic_key') && c.value);
    }
    if (!hasKey) throw new Error('QQ 已授权，但未取得 QQ 音乐登录态（qm_keyst）');
    const profile = await this._qqProfile();
    if (profile) this.mgr.saveProfile('qq', profile);
    this._emitSuccess({
      platform: 'qqmusic', name: cfg.name,
      profile: profile || { nickname: '', avatar: '' }
    });
    return true;
  }

  /** 登录后用 musicu.fcg 取昵称/头像 */
  async _qqProfile() {
    try {
      const cookies = this.mgr.jar.get('qq', 'y.qq.com') || [];
      const obj = Object.fromEntries(cookies.map((c) => [c.name, c.value]));
      const isWx = !!obj.wxopenid || Number(obj.login_type) === 2;
      const rawUin = isWx ? (obj.wxuin || obj.uin || '') : (obj.uin || obj.qqmusic_uin || obj.wxuin || '');
      const uin = Number(String(rawUin).replace(/\D/g, '').replace(/^0+/, '')) || 0;
      const key = obj.qm_keyst || obj.qqmusic_key || '';
      let gtk = 5381;
      for (let i = 0; i < key.length; i++) gtk += ((gtk << 5) + key.charCodeAt(i));
      gtk &= 0x7fffffff;
      const payload = {
        comm: { g_tk: gtk, uin, format: 'json', ct: 19, cv: 0, platform: 'yqq.json', needNewCode: 0 },
        req_0: { module: 'userInfo.GetUserInfo', method: 'GetUserInfo', param: {} }
      };
      const r = await rawRequest({
        url: 'https://u.y.qq.com/cgi-bin/musicu.fcg',
        method: 'POST',
        headers: {
          'User-Agent': UA,
          Referer: 'https://y.qq.com/',
          'Content-Type': 'application/json',
          Cookie: this.mgr.jar.cookieString('qq', 'y.qq.com')
        },
        text: JSON.stringify(payload),
        timeoutMs: 10000
      });
      const j = JSON.parse(new TextDecoder().decode(r.bytes));
      const d = j.req_0?.data;
      if (!d) return null;
      const avatar = d.headPic || d.AvatarUrl || d.avatar || d.avatarUrl || '';
      const nick = d.nick || d.nickname || d.Nick || '';
      if (!nick) return null;
      return { userId: String(d.uin || d.id || uin || ''), nickname: String(nick), avatar: String(avatar) };
    } catch { return null; }
  }
}

/* ============================================================
   扫码登录模块（主进程）—— 网易云音乐 / QQ音乐
   ------------------------------------------------------------
   原则（用户要求）：不使用任何官方登录接口。两个平台统一走
   「后台隐藏窗口加载官方登录网页 → 从页面抓取/截屏二维码 →
   轮询会话 Cookie 与页面文本识别扫码状态 → 登录成功后抓网页
   账号信息（昵称/头像/用户ID）」。
   - 网页全程在后台不可见窗口（show:false）运行，绝不弹出网页；
     不使用 BrowserView。渲染进程只拿二维码图片自行展示。
   - 每个平台独立持久化 partition，Cookie 落盘；登录成功后另写入
     userData/login-cookies.json（含 profile），并按域名粘接进
     音源插件同名 CookieJar，插件请求自动携带 VIP 凭证。
   事件推送（主进程 → 渲染进程，无需渲染层轮询）：
   - 'login-qr-update' { platform, type:'refresh', qrSrc }   新二维码
   - 'login-qr-update' { platform, type:'scanned' }          已扫码待确认
   - 'login-qr-update' { platform, type:'expired' }          二维码过期
   - 'login-success'   { platform, name, count, profile }    登录成功
   ============================================================ */
import { BrowserWindow, ipcMain, session, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 登录链路监控日志：userData/qr-login.log（追加写、同步小流量）----
   用户扫码时读这个文件即可诊断到底卡在哪一步、Cookie 实际种在哪个域。
   关键键优先记录（p_skey/skey/uin/qm_keyst 等），避免整包 Cookie 刷屏 */
function _qrlog(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'qr-login.log'),
      `[${new Date().toISOString().slice(11, 23)}] ${msg}\n`);
  } catch { /* noop */ }
}
const QR_KEYS = ['uin', 'skey', 'p_skey', 'p_uin', 'pt4token', 'qm_keyst', 'qqmusic_key',
  'music_key', 'wxuin', 'wxunionid', 'wxopenrfid', 'wxrefresh_token', 'psrf_qqaccess_token', 'psrf_qqrefresh_token'];
const _cookieDigest = (cookies) => (cookies || [])
  .filter((c) => QR_KEYS.includes(c.name) && c.value)
  .map((c) => `${c.name}@${(c.domain || '').replace(/^\./, '')}`)
  .join(' ') || '(无关键键)';

/* 真实 Chrome UA：Electron 默认 UA 带 "Electron" 字样，平台登录页会拒绝或降级 */
const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/* 诊断开关：RV_SHOW_QR_WINDOW=1 时把后台登录页显示出来供排查；默认隐藏（正式行为不变） */
const SHOW_LOGIN_WIN = process.env.RV_SHOW_QR_WINDOW === '1';
/* 诊断开关：RV_DEBUG_URL=https://y.qq.com/ 时不用扫码页，直接开一个可见、可交互的内置浏览器窗口
   供手动登录排查；Cookie 轮询照常运行，手动登录成功同样会被接管 */
const DEBUG_URL = process.env.RV_DEBUG_URL || '';

/* ================= 双平台配置（分离维护） =================
   key        : IPC 入参 platform（'netease' | 'qqmusic'）
   srcId      : 对应音源插件 id —— Cookie 写入该 id 的 CookieJar 空间
   loginUrl   : 官方网页登录页（后台隐藏窗口加载，非接口）
   qrJs       : 可选，自定义取码脚本（返回图片 src / dataURL / ''）——优先级高于选择器
   qrSelectors: 二维码 <img> 选择器；抓不到 src 时对元素截屏兜底
   cookieGroups: 真登录判定（任一组全部命中即可）
   scannedRe / expiredRe : 页面文本状态识别
   profileUrl : 登录成功后抓取账号信息的页面
   profileJs  : 在该页面执行的抓取脚本（返回 { userId, nickname, avatar, html? }）
   htmlNickRe : 页面内嵌 JSON 昵称兜底正则（profileJs 返回 html 时在主进程侧匹配） */
const PLATFORMS = {
  netease: {
    name: '网易云音乐',
    srcId: 'netease',
    // 2026 年官网已改为 SPA：无独立登录页，二维码在顶栏「登录」弹层（.mrc-modal）里，
    // 且是 <canvas> 渲染（无 img src）——自定义脚本：确保弹层打开 → canvas.toDataURL 取码
    loginUrl: 'https://music.163.com/',
    qrJs: `(() => {
      const modal = document.querySelector('.mrc-modal-show, .mrc-modal-wrapper');
      if (!modal) {
        const els = [...document.querySelectorAll('a, span, div, button')];
        const t = els.find((e) => e.children.length === 0 && /^登录$/.test((e.textContent || '').trim()));
        if (t) t.click(); // 弹层未开：先点顶栏「登录」，下一轮再取码
        return '';
      }
      const c = document.querySelector('.mrc-modal canvas') || document.querySelector('canvas');
      if (!c || c.width < 80) return '';
      try { return c.toDataURL('image/png'); } catch (e) { return ''; }
    })()`,
    cookieGroups: [['MUSIC_U']],
    scannedRe: /扫描成功|已扫描|等待确认|确认登录/,
    expiredRe: /二维码已过期|二维码失效|已失效/,
    profileUrl: 'https://music.163.com/',
    /* 页面内嵌 GUser 对象 + 顶栏 DOM 双路抓取；CSP 禁 eval，对象字面量解析放主进程侧 */
    profileJs: `(() => {
      let g = null;
      try { if (window.GUser && (window.GUser.userId || window.GUser.nickname)) g = JSON.parse(JSON.stringify(window.GUser)); } catch (e) {}
      let domNick = '', domAvatar = '', uid = '';
      const a = document.querySelector('a[href*="/user/home?id="]');
      if (a) { domNick = (a.textContent || '').trim(); uid = (/id=(\\d+)/.exec(a.href) || [])[1] || ''; }
      const box = a ? (a.closest('div') || a.parentElement) : null;
      const im = (box && box.querySelector('img')) || document.querySelector('.m-tbar img');
      if (im) domAvatar = im.currentSrc || im.src || '';
      if (g) return { userId: String(g.userId || uid || ''), nickname: g.nickname || domNick, avatar: g.avatar || g.avatarUrl || domAvatar };
      return { userId: uid, nickname: domNick, avatar: domAvatar,
        html: (document.documentElement.innerHTML || '').slice(0, 240000) };
    })()`,
    /* 兜底：页面源码里的 GUser = {...} 字面量 */
    htmlNickRe: /GUser\s*=\s*\{[\s\S]{0,2000}?"nickname"\s*:\s*"((?:[^"\\]|\\.){1,40})"/,
    htmlUidRe: /GUser\s*=\s*\{[\s\S]{0,2000}?"userId"\s*:\s*(\d{2,})/,
    /* 官方账号接口：拿到 MUSIC_U 后直接取昵称/头像，比抓首页 DOM（GUser/顶栏结构常变）可靠；
       请求带 Cookie 由登录会话保证，成功返回 {profile:{userId,nickname,avatarUrl}} 或 {account:{...}} */
    apiProfile: {
      url: 'https://music.163.com/api/w/nuser/account/get',
      referer: 'https://music.163.com/'
    },
    hint: '打开网易云音乐 App → 左上角「扫一扫」'
  },
  qqmusic: {
    name: 'QQ音乐',
    srcId: 'qq',
    // QQ 互联扫码页：daid=384 为 QQ音乐业务；扫码确认后 302 跳 s_url 并种下凭证 Cookie
    loginUrl: 'https://xui.ptlogin2.qq.com/cgi-bin/xlogin?daid=384&pt_no_auth=1&style=40&appid=1006102'
      + '&s_url=' + encodeURIComponent('https://y.qq.com/portal/close.html') + '&target=self',
    qrSelectors: ['img#qrlogin_img', 'img.qrImg', 'img[alt*="二维码"]'],
    cookieGroups: [['uin', 'skey'], ['uin', 'p_skey']],
    scannedRe: /扫描成功|已扫描|请在.*确认/,
    expiredRe: /二维码已失效|已过期|失效/,
    profileUrl: 'https://y.qq.com/',
    /* 顶栏头像/昵称 DOM + 真 QQ 头像域名特征（thirdqq/qlogo；qpic 是歌曲封面域，不能当头像）+ 内嵌 JSON 兜底 */
    profileJs: `(() => {
      const q = (s) => document.querySelector(s);
      let img = q('.top_login__cover') || q('.mod_top_login img') || q('.top_login img') || q('#login_user_pic');
      if (!img) img = [...document.images].find((i) => /thirdqq|qlogo/.test(i.src || ''));
      const avatar = img ? (img.currentSrc || img.src || '') : '';
      const el = q('.top_login__name') || q('[class*="top_login"] [class*="name"]') || q('#login_user_name');
      const nick = el ? (el.textContent || '').trim() : '';
      return { nickname: nick, avatar, html: nick ? '' : (document.documentElement.innerHTML || '').slice(0, 300000) };
    })()`,
    htmlNickRe: /"nick(?:name|Name)?"\s*:\s*"((?:[^"\\]|\\.){1,40})"/,
    htmlUidRe: /"uin"\s*:\s*"?(\d{5,})"?/,
    hint: '打开手机 QQ 扫一扫登录',
    /* QQ 登录走「隐藏窗口取码」混合模式：主窗口隐藏加载 y.qq.com 自动点「登录」，
       OAuth 登录弹窗里抓出二维码推给界面（用户只见二维码，不见网页）；
       扫码确认、qm_keyst 签发全程在隐藏窗口完成。
       仅当取码失败/链路卡住时亮出官方网页窗口回退（旧行为）。
       为什么不直接用纯扫码页(xui.ptlogin2)：那只能拿到 QQ 通用登录态，y.qq.com 业务接口
       （musicu / 我的歌单 / 歌单详情）一律 500003 不认；必须从 y.qq.com 自身
       发起登录，让官方 SPA 的 OAuth 回调在 y.qq.com 域下签发 qm_keyst/qqmusic_key */
    web: true,
    cookieGroups: [['qm_keyst'], ['qqmusic_key']]
  }
};

/* 进行中的扫码会话：platform -> { win, ses, state, qrTimer, pollTimer, lastQr, token, expiredAt, done } */
const _sessions = new Map();

/* ---------- Cookie / 资料持久化文件（userData/login-cookies.json） ---------- */
function _cookieFile() { return path.join(app.getPath('userData'), 'login-cookies.json'); }
function _readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
}
function _writeJson(file, data) {
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch { /* 写盘失败不阻断登录 */ }
}

/** 启动回灌：读取 login-cookies.json，把各平台 Cookie 按域名粘回音源 CookieJar */
export function restoreLoginCookies(mgr) {
  const file = _cookieFile();
  const data = _readJson(file);
  for (const [platform, rec] of Object.entries(data)) {
    const cfg = PLATFORMS[platform];
    if (!cfg || !Array.isArray(rec?.cookies) || !rec.cookies.length) continue;
    _jarGlue(mgr, cfg.srcId, rec.cookies);
    // 历史版本抓到的资料可能缺昵称（页面结构变动）：有官方接口的平台启动时静默补全
    if (cfg.apiProfile && !rec.profile?.nickname && rec.cookieString) {
      _backfillProfile(platform, rec.cookieString, file).catch(() => { /* 静默，失败不影响登录态 */ });
    }
  }
}

/** 用已保存的登录 Cookie 静默拉一次官方账号接口，补写缺失的昵称/头像到 login-cookies.json。
    平台列表 IPC 每次实时读该文件，故补写成功后重开登录弹层即可看到名字，无需重启。 */
async function _backfillProfile(platform, cookieString, file) {
  const p = await _fetchProfileByApi(platform, cookieString);
  if (!p?.nickname) return;
  const data = _readJson(file);
  const rec = data[platform];
  if (!rec) return;
  rec.profile = {
    userId: p.userId || rec.profile?.userId || '',
    nickname: p.nickname,
    avatar: p.avatar || rec.profile?.avatar || ''
  };
  _writeJson(file, data);
  console.log(`[qr:${platform}] 已补全账号资料:`, p.nickname);
}

/** Cookie 按域名分组写入指定音源的 CookieJar（与 manager._persistCookies 同规则） */
function _jarGlue(mgr, srcId, cookies) {
  const strip = (d) => String(d || '').replace(/^\./, '');
  const domains = [...new Set(cookies.map((c) => strip(c.domain)).filter(Boolean))];
  for (const d of domains) {
    mgr.cookieSet(srcId, d, cookies.filter((c) => strip(c.domain) === d || strip(c.domain).includes(d)));
  }
}

/** 给渲染进程发消息（主窗口可能尚未就绪，全部容错） */
function _send(getWin, channel, payload) {
  try { getWin()?.webContents.send(channel, payload); } catch { /* noop */ }
}

/** 结束扫码会话：停定时器、销毁后台隐藏窗口与托管弹窗、清会话状态（重入/取消/成功/失败均走这里） */
function _closeSession(platform) {
  const sess = _sessions.get(platform);
  if (!sess) return;
  _sessions.delete(platform);
  if (sess.qrTimer) clearInterval(sess.qrTimer);
  if (sess.pollTimer) clearInterval(sess.pollTimer);
  if (sess._fbTimer) clearTimeout(sess._fbTimer);
  if (sess._shotTimer) clearInterval(sess._shotTimer);
  if (sess._renewTimer) clearInterval(sess._renewTimer);
  // OAuth 弹窗与 warmup 辅助窗一并销毁，防取消登录后残留网页窗口
  if (sess.popups) for (const w of [...sess.popups]) { try { if (!w.isDestroyed()) w.close(); } catch { /* noop */ } }
  if (sess.oauthWin && !sess.oauthWin.isDestroyed()) { try { sess.oauthWin.destroy(); } catch { /* noop */ } }
  if (sess.win && !sess.win.isDestroyed()) { try { sess.win.destroy(); } catch { /* noop */ } }
}

/** 在隐藏窗口里执行 JS（容错封装） */
async function _exec(win, js) {
  if (!win || win.isDestroyed()) return undefined;
  try { return await win.webContents.executeJavaScript(js, true); } catch { return undefined; }
}

/* ================= 二维码抓取：优先 <img> src，抓不到则对元素区域截屏 ================= */

/** 定位二维码元素：配置选择器优先，其次取页面上 120~400px 的类方形大图
    同时尽量把元素本体重绘成 dataURL —— 平台二维码图片 URL 每请求一次就是一张新码，
    交给渲染进程二次请求会拿到与后台轮询**不同**的码（扫码因此永远无法被识别） */
async function _locateQr(win, cfg) {
  return await _exec(win, `(() => {
    const info = (el) => {
      const r = el.getBoundingClientRect();
      const o = { src: el.currentSrc || el.src || '', dataUrl: '', rect: { x: r.left, y: r.top, width: r.width, height: r.height } };
      try {
        if (el.tagName === 'IMG' && el.naturalWidth) {
          const c = document.createElement('canvas');
          c.width = el.naturalWidth;
          c.height = el.naturalHeight;
          c.getContext('2d').drawImage(el, 0, 0);
          o.dataUrl = c.toDataURL('image/png');
        }
      } catch (e) { /* 跨域污染时回落 src */ }
      return o;
    };
    const sels = ${JSON.stringify(cfg.qrSelectors)};
    for (const sel of sels) {
      const el = document.querySelector(sel);
      if (!el) continue;
      if (el.getBoundingClientRect().width < 40) continue;
      return info(el);
    }
    let best = null;
    for (const im of document.images) {
      const r = im.getBoundingClientRect();
      if (r.width < 120 || r.width > 400) continue;
      if (Math.abs(r.width - r.height) > r.width * 0.2) continue;
      if (!best || r.width > best.rect.width) best = info(im);
    }
    return best;
  })()`);
}

/** 抓取二维码：平台自定义脚本优先；否则 img src（http/https/data:），再不行对元素截屏 */
async function _grabQr(win, cfg) {
  if (cfg.qrJs) {
    const src = await _exec(win, cfg.qrJs);
    return typeof src === 'string' ? src : '';
  }
  const info = await _locateQr(win, cfg);
  if (!info) return '';
  if (info.dataUrl) return info.dataUrl; // 同源自绘 dataURL：与后台轮询的码完全一致，优先使用
  if (info.src && /^(https?:|data:image)/.test(info.src)) return info.src;
  if (info.rect && info.rect.width > 40) {
    const r = info.rect;
    try {
      const img = await win.webContents.capturePage({
        x: Math.max(0, Math.floor(r.x) - 6), y: Math.max(0, Math.floor(r.y) - 6),
        width: Math.ceil(r.width) + 12, height: Math.ceil(r.height) + 12
      });
      if (img && !img.isEmpty()) return 'data:image/png;base64,' + img.toPNG().toString('base64');
    } catch { /* 截屏失败等下轮 */ }
  }
  return '';
}

/** 等待二维码出现：页面为异步渲染，轮询执行 JS 直到拿到（超时/窗口销毁则放弃） */
async function _waitQr(win, cfg, timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (win.isDestroyed()) return '';
    const src = await _grabQr(win, cfg);
    if (src) return src;
    await sleep(500);
  }
  return '';
}

/* ================= 账号信息抓取（登录成功后跳平台首页，从网页 DOM / 内嵌数据提取） ================= */

/** 官方账号接口直取资料（网易云）：拿到登录 Cookie 后请求 account/get，比抓页面 DOM 稳定。
    cookies 可为 Electron Cookie 数组，也可为已拼好的 Cookie 字符串。失败返回 null，交调用方兜底。 */
async function _fetchProfileByApi(platform, cookies) {
  const api = PLATFORMS[platform]?.apiProfile;
  if (!api) return null;
  const cookieString = typeof cookies === 'string' ? cookies
    : (cookies || []).filter((c) => c?.name && c.value).map((c) => `${c.name}=${c.value}`).join('; ');
  if (!cookieString) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(api.url, {
      method: 'GET',
      signal: ctrl.signal,
      headers: {
        Cookie: cookieString,
        Referer: api.referer || '',
        Accept: 'application/json, text/plain, */*',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
      }
    });
    const j = await r.json();
    // w 接口：{code:200, account:{...}, profile:{...}}；未登录 code 301 且无 profile
    const p = j.profile || j.account || j.data?.profile || null;
    if (!p || p.code === 301) return null;
    const nickname = String(p.nickname || '').trim();
    if (!nickname) return null;
    return {
      userId: String(p.userId || p.id || ''),
      nickname,
      avatar: p.avatarUrl || p.avatar || ''
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function _scrapeProfile(platform, sess, cookies) {
  const cfg = PLATFORMS[platform];
  const { win } = sess || {};
  // ① 官方接口优先（快且稳）；登录会话 / 静默补全都走这里
  const viaApi = await _fetchProfileByApi(platform, cookies);
  if (viaApi?.nickname) {
    console.log(`[qr:${platform}] 账号信息接口抓取成功:`, viaApi.nickname, viaApi.avatar ? '(有头像)' : '(无头像)', viaApi.userId ? 'uid=' + viaApi.userId : '');
    return viaApi;
  }
  if (!cfg.profileUrl || !win || win.isDestroyed()) return {};
  // ② 页面 DOM / 内嵌 JSON 兜底
  try { await win.loadURL(cfg.profileUrl); } catch { /* noop */ }
  const t0 = Date.now();
  while (Date.now() - t0 < 10000) {
    if (win.isDestroyed()) return {};
    const p = await _exec(win, cfg.profileJs);
    if (p) {
      let { userId = '', nickname = '', avatar = '' } = p;
      // DOM 抓不到时，从页面源码内嵌 JSON 正则兜底
      if ((!nickname || !userId) && p.html) {
        if (!nickname && cfg.htmlNickRe) {
          const m = cfg.htmlNickRe.exec(p.html);
          if (m) { try { nickname = JSON.parse('"' + m[1] + '"'); } catch { nickname = m[1]; } }
        }
        if (!userId && cfg.htmlUidRe) userId = (cfg.htmlUidRe.exec(p.html) || [])[1] || '';
      }
      if (nickname || avatar) {
        console.log(`[qr:${platform}] 账号信息抓取成功:`, nickname || '(无名)', avatar ? '(有头像)' : '(无头像)', userId ? 'uid=' + userId : '');
        return { userId: String(userId || ''), nickname: nickname || '', avatar: avatar || '' };
      }
    }
    await sleep(1200);
  }
  console.log(`[qr:${platform}] 账号信息抓取超时（不影响登录态）`);
  return {};
}

/* ================= 登录成功收尾 ================= */

/** 登录成功统一收尾：持久化 json（含 profile）→ 粘接 CookieJar → 通知渲染进程 → 关闭后台会话 */
async function _saveSuccess(platform, cookies, profile, mgr, getWin) {
  const cfg = PLATFORMS[platform];
  const sess = _sessions.get(platform);
  if (sess) sess.done = true; // 防重入（轮询可能重复命中）
  // 统一 Cookie 结构（Electron Cookie.expirationDate → expires 秒级时间戳）
  const list = (cookies || []).filter((c) => c && c.name && c.value).map((c) => ({
    name: c.name, value: c.value,
    domain: c.domain || '', path: c.path || '/', expires: c.expirationDate || c.expires || null
  }));
  if (!list.length) return;
  // 1) 拼接 Cookie 字符串并保存到本地 json 文件（含账号资料，重启后回显）
  const file = _cookieFile();
  const data = _readJson(file);
  data[platform] = {
    savedAt: Date.now(),
    cookieString: list.map((c) => `${c.name}=${c.value}`).join('; '),
    cookies: list,
    profile: {
      userId: String(profile?.userId || data[platform]?.profile?.userId || ''),
      nickname: profile?.nickname || data[platform]?.profile?.nickname || '',
      avatar: profile?.avatar || data[platform]?.profile?.avatar || ''
    }
  };
  _writeJson(file, data);
  // 2) 粘接进音源 CookieJar：导入对应音源插件后请求自动携带 VIP 凭证
  _jarGlue(mgr, cfg.srcId, list);
  mgr._markAlive?.(cfg.srcId);
  // 3) 通知渲染进程 + 4) 关闭后台隐藏窗口/轮询
  _send(getWin, 'login-success', { platform, name: cfg.name, count: list.length, profile: data[platform].profile });
  _closeSession(platform);
}

/* ================= 网页扫码主流程（双平台统一） ================= */

async function _pageStart(platform, mgr, getWin) {
  const cfg = PLATFORMS[platform];
  // 独立持久化 partition：Cookie 落盘，重复登录互不污染
  const part = 'persist:qr-login-' + platform;
  const ses = session.fromPartition(part, { cache: true });
  try { ses.setUserAgent(UA_CHROME); } catch { /* noop */ }
  // 后台不可见窗口：默认 show:false 且不抢任务栏（RV_SHOW_QR_WINDOW=1 时显示，仅用于排查）
  const winOpt = DEBUG_URL
    ? { show: true, skipTaskbar: false, width: 1180, height: 830, center: true, title: '内置浏览器（诊断）' }
    : { show: SHOW_LOGIN_WIN, skipTaskbar: !SHOW_LOGIN_WIN, width: 480, height: 640 };
  const win = new BrowserWindow({
    ...winOpt,
    webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
  });
  // 调试窗口放行页面弹窗（网页版登录会开新窗），扫码页仍一律拦截
  if (!DEBUG_URL) win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const sess = { win, ses, part, done: false, lastQr: '', state: 'wait', expiredAt: 0,
    token: Date.now().toString(36) + Math.random().toString(36).slice(2, 8) };
  _sessions.set(platform, sess);
  win.on('closed', () => { if (_sessions.get(platform) === sess) _closeSession(platform); });

  /* 状态轮询（1.5s）：Cookie 判登录 + 页面文本判已扫/过期（不依赖任何官方接口） */
  sess.pollTimer = setInterval(() => { _poll(platform, mgr, getWin).catch((e) => console.error(`[qr:${platform}] poll 异常:`, e?.message)); }, 1500);

  // 加载官方登录网页并等待二维码出现
  win.loadURL(DEBUG_URL || cfg.loginUrl).catch(() => {});
  if (DEBUG_URL) {
    console.log(`[qr:${platform}] 调试浏览器窗口已打开:`, DEBUG_URL);
    return { ok: true, platform, name: cfg.name, qrSrc: '', qrToken: sess.token,
      hint: '调试窗口已打开：请在内置浏览器窗口中手动登录', debugWindow: true };
  }
  console.log(`[qr:${platform}] 网页登录页加载中:`, cfg.loginUrl.slice(0, 72));
  const qrSrc = await _waitQr(win, cfg);
  console.log(`[qr:${platform}] 二维码:`, qrSrc ? (qrSrc.startsWith('data:') ? '截屏 dataUrl' : qrSrc.slice(0, 80)) : '（未获取到）');
  if (!qrSrc) { _closeSession(platform); return { ok: false, msg: '未能获取二维码（平台页面可能已变更）' }; }
  sess.lastQr = qrSrc;
  // 后台复抓：平台页面自刷新二维码（或截屏重取）时同步给界面（3s 一次）
  sess.qrTimer = setInterval(async () => {
    if (sess.done || sess.state !== 'wait') return; // 已扫码后不再换图，避免覆盖「待确认」提示
    const s = await _grabQr(win, cfg);
    if (s && s !== sess.lastQr) {
      sess.lastQr = s;
      _send(getWin, 'login-qr-update', { platform, type: 'refresh', qrSrc: s, token: sess.token });
    }
  }, 3000);
  return { ok: true, platform, name: cfg.name, qrSrc, qrToken: sess.token, hint: cfg.hint };
}

/** 扫码会话轮询：真登录判定（Cookie 组命中）→ 抓取账号信息 → 收尾 */
async function _poll(platform, mgr, getWin) {
  const sess = _sessions.get(platform);
  const cfg = PLATFORMS[platform];
  if (!sess || sess.done) return;
  // 1) Cookie 命中判定（任一组全部命中即真登录；QQ 的 qm_keyst 由抓信息时跳首页补齐）
  let cookies = [];
  try { cookies = await sess.ses.cookies.get({}); } catch { /* noop */ }
  const has = (k) => cookies.some((c) => c.name === k && c.value);
  const hit = cfg.cookieGroups.some((g) => g.every(has));
  if (hit) {
    console.log(`[qr:${platform}] 检测到登录凭证 Cookie，命中组:`, cfg.cookieGroups.find((g) => g.every(has)).join('+'));
    // 先用命中的 Cookie 走官方接口取资料，失败再跳首页抓 DOM
    const profile = await _scrapeProfile(platform, sess, cookies);
    // 抓完信息后再收一次 Cookie（跳首页可能补齐业务凭证）
    try { cookies = await sess.ses.cookies.get({}); } catch { /* noop */ }
    await _saveSuccess(platform, cookies, profile, mgr, getWin);
    return;
  }
  // 2) 页面文本状态识别（已扫待确认 / 过期自动重载换码）
  const text = await _exec(sess.win, `String(document.body && document.body.innerText || '').slice(0, 2000)`);
  if (typeof text !== 'string' || !text) return;
  if (sess.state === 'wait' && cfg.scannedRe.test(text)) {
    sess.state = 'scanned';
    _send(getWin, 'login-qr-update', { platform, type: 'scanned', token: sess.token });
    console.log(`[qr:${platform}] 已扫码，等待手机确认`);
    return;
  }
  if (cfg.expiredRe.test(text) && Date.now() - sess.expiredAt > 10000) {
    // 不自动重载换码（换码会让用户扫到已作废的二维码，是「确认登录却跳 QQ 中心」的根因之一）；
    // 提示过期并结束会话，等用户在界面上点「刷新二维码」重新发起。
    sess.expiredAt = Date.now();
    _send(getWin, 'login-qr-update', { platform, type: 'expired', token: sess.token });
    console.log(`[qr:${platform}] 二维码已过期，会话结束（等用户刷新）`);
    _closeSession(platform);
  }
}

/* ================= QQ 官方网页登录（方案移植自开源项目 Mineradio，GPL-3.0） =================
   流程：可见窗口加载 y.qq.com/n/ryqq/profile → 自动点页面「登录」→ 轮询 Cookie：
   通用登录态(uin+skey/p_skey)先出现 → 5s 内官方 OAuth 回调应写出 qm_keyst；
   写不出则开隐藏 warmup 窗口加载 /n/ryqq/player 触发播放票据签发。
   判定完成 = uin + qm_keyst/qqmusic_key（播放票据）。 */
const QQ_WEB = {
  loginUrl: 'https://y.qq.com/n/ryqq/profile',
  fallbackUrl: 'https://y.qq.com/',
  warmupUrl: 'https://y.qq.com/n/ryqq/player',
  playbackKeys: ['qm_keyst', 'qqmusic_key', 'music_key', 'wxskey'],
  genericKeys: ['qm_keyst', 'qqmusic_key', 'music_key', 'p_skey', 'skey',
    'psrf_qqaccess_token', 'psrf_qqrefresh_token', 'wxrefresh_token', 'wxskey']
};

/** Cookie 数组 → 同名去重对象：y.qq.com 域优先（业务凭证以 y.qq.com 为准），其次过期时间更远者 */
function _qqCookieObj(cookies) {
  const picked = new Map();
  const score = (c) => {
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (d === 'y.qq.com' || d.endsWith('.y.qq.com')) return 400;
    if (d === 'qqmusic.qq.com' || d.endsWith('.qqmusic.qq.com')) return 360;
    if (d === 'qq.com') return 240;
    if (d.endsWith('.qq.com')) return 160;
    return 0;
  };
  for (const c of cookies || []) {
    if (!c || !c.name || c.value == null || c.value === '') continue;
    const d = String(c.domain || '').replace(/^\./, '').toLowerCase();
    if (d !== 'qq.com' && !d.endsWith('.qq.com')) continue;
    const sc = score(c), exp = Number(c.expirationDate) || 0;
    const prev = picked.get(c.name);
    if (!prev || sc > prev.sc || (sc === prev.sc && exp > prev.exp)) picked.set(c.name, { value: String(c.value), sc, exp });
  }
  return Object.fromEntries([...picked.entries()].map(([k, v]) => [k, v.value]));
}

function _qqUin(obj) {
  const isWx = !!obj.wxopenid || Number(obj.login_type) === 2;
  const raw = isWx ? (obj.wxuin || obj.uin || obj.p_uin || '') : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
  const digits = String(raw).replace(/\D/g, '');
  return digits.replace(/^0+/, '') || digits;
}

/** 登录态分级：'playback' 有播放票据（真完成）/ 'generic' 仅通用登录态 / 'none' */
function _qqLoginState(cookies) {
  const obj = _qqCookieObj(cookies);
  if (!_qqUin(obj)) return 'none';
  if (QQ_WEB.playbackKeys.some((k) => obj[k])) return 'playback';
  if (QQ_WEB.genericKeys.some((k) => obj[k])) return 'generic';
  return 'none';
}

function _trustedQqUrl(u) {
  try {
    const h = new URL(String(u || '')).hostname.toLowerCase();
    return ['qq.com', 'tencent.com', 'qqmusic.com', 'gtimg.com', 'qpic.cn', 'weixin.qq.com']
      .some((d) => h === d || h.endsWith('.' + d));
  } catch { return false; }
}

/* ================= QQ 音乐：官网原生链（隐藏窗口 + 自动点登录 + iframe 截图推码） =================
   演化史（三次实验定稿，别再走回头路）：
   1. 顶层直载 xlogin(appid=1006102)：被腾讯下线墙「当前应用版本过低」，扫出码=QQ中心 → 弃
   2. 顶层直载 xlogin(appid=716027609)：码正常、确认页「QQ音乐」✓，但裸 s_url 丢授权上下文，
      ptlogin 种的 p_skey@graph 无 pt4token → 手动导航 graph authorize 被 302 到
      show?which=Login 出新码死路（监控日志实测）→ 弃
   3. 官网原生链（现行）：隐藏窗口加载 y.qq.com 官网 → 自动点「登录」→ 官网自己弹
      iframe（完整授权上下文）→ 截图 iframe 二维码推 UI。确认后 iframe 内自动走
      login_jump（带参）→ graph 换 code → wx_redirect 回 y.qq.com → qm_keyst 签发。
      全链是官网自己验证过的原生流，主进程零二次请求（码不会作废），绝不导航打断。
   关键基建：paintWhenInitiallyHidden + backgroundThrottling:false（隐藏窗口照常渲染） */
const QQ_ZOOM = 2;

/** 通用跨 frame 偏移：沿 frame 树 root→target 逐层累计 iframe 元素位置
    （官网是两层嵌套：y.qq.com → graph show?which=Login → ptlogin xlogin，
    PoC verify-web4 实测累计 (173.6,154) 正确、截出 277×277 清晰码） */
async function _frameOffset(mainFrame, targetFrame) {
  const path = [];
  const walk = (f) => {
    if (f === targetFrame) return true;
    for (const c of (f.frames || [])) {
      if (walk(c)) { path.unshift(c); return true; }
    }
    return false;
  };
  if (!walk(mainFrame)) return null;
  let off = { x: 0, y: 0 };
  let parent = mainFrame;
  for (const child of path) {
    const host = ((child.url || '').split('/')[2]) || '';
    const io = await parent.executeJavaScript(`(() => {
      const host = ${JSON.stringify(host)};
      let hit = null;
      for (const f of document.querySelectorAll('iframe')) {
        try { if (new URL(f.src || 'about:blank', location.href).host === host) { const r = f.getBoundingClientRect(); hit = { x: r.x, y: r.y }; break; } } catch { /* bad src */ }
      }
      /* host 匹配失败兜底：页面里最大的 iframe（登录框都是大块头） */
      if (!hit) {
        let best = null;
        for (const f of document.querySelectorAll('iframe')) {
          const r = f.getBoundingClientRect();
          if (!best || r.width * r.height > best.w * best.h) best = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
        if (best && best.w > 200) hit = { x: best.x, y: best.y };
      }
      return hit;
    })()`).catch(() => null);
    if (!io) return null;
    off.x += io.x; off.y += io.y;
    parent = child;
  }
  return off;
}

/** 探测二维码区域（ptlogin iframe 内）：frame 内矩形 + 逐层 iframe 偏移累计
    → 窗口绝对 CSS 坐标（zoom 渲染下同坐标系） */
async function _probeQrRect(w) {
  try {
    const frames = w.webContents.mainFrame.framesInSubtree || [];
    const pf = frames.find((f) => /ptlogin2\.qq\.com/.test(f.url || ''));
    if (!pf) return null;
    const q = await pf.executeJavaScript(`(() => {
      const cand = [
        document.querySelector('.qrImg img'),
        document.querySelector('img[src*="ptqrshow"]'),
        document.querySelector('#qrlogin_img')
      ].filter(Boolean);
      for (const el of cand) {
        const r = el.getBoundingClientRect();
        if (r.width >= 60 && r.height >= 60) {
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return null;
    })()`);
    if (!q || !q.w) return null;
    const off = await _frameOffset(w.webContents.mainFrame, pf);
    if (!off) return null;
    return {
      x: Math.round(off.x + q.x), y: Math.round(off.y + q.y),
      w: Math.round(q.w), h: Math.round(q.h)
    };
  } catch { return null; }
}

async function _apiStart(platform, mgr, getWin) {
  const cfg = PLATFORMS[platform];
  const part = 'persist:qr-login-' + platform;
  const ses = session.fromPartition(part, { cache: true });
  try { ses.setUserAgent(UA_CHROME); } catch { /* noop */ }

  /* 已登录检测：播放票据仍有效 → 直接复用，免扫码 */
  try {
    const cur = await ses.cookies.get({});
    if (_qqLoginState(cur) === 'playback') {
      const profile = await _scrapeProfile(platform, { ses, part }).catch(() => ({}));
      await _saveSuccess(platform, cur, profile, mgr, getWin);
      return { ok: true, platform, name: cfg.name, reused: true, msg: '登录态仍有效，已直接复用' };
    }
  } catch { /* noop */ }

  /* 陈旧半登录态清理：上次扫出的「通用 QQ 登录态」（非 QQ音乐票据）残留在 partition，
     会让 Cookie 轮询一启动就误判「已扫码确认」直接跳授权页——新二维码永远推不出来。
     非播放票据态一律清空，保证每次都从干净状态出新码 */
  try {
    if (_qqLoginState(await ses.cookies.get({})) !== 'none') {
      await ses.clearStorageData({ storages: ['cookies'] });
      console.log('[qr:qqmusic] 清理上次残留的半登录态 Cookie，重新扫码');
    }
  } catch { /* noop */ }

  const sess = {
    win: null, ses, part, done: false, state: 'wait', expiredAt: 0,
    token: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    popups: new Set(),
    phase: 'qr',           // 'qr' 扫码渲染+Cookie轮询 → 'oauth' qm_keyst 签发 → 'done'
    oauthAt: 0, lastShot: '', qrRect: null, probeCnt: 0
  };
  _sessions.set(platform, sess);

  /* ---- 官网原生链窗口：隐藏但强制渲染 ---- */
  const win = new BrowserWindow({
    /* 2000×1400 + 导航后 zoom 2：布局视口 1000px（官网保持桌面版布局，登录弹窗
       居中弹出）；iframe 二维码 87 CSS px → 渲染 174px → 截图物理 ~217px（DPI 1.25）
       + 弹窗端 pixelated 放大，清晰可扫 */
    width: 2000, height: 1400, show: false, skipTaskbar: true, autoHideMenuBar: true,
    paintWhenInitiallyHidden: true,   /* 关键：隐藏窗口照常绘制，capturePage 才有画面 */
    title: 'QQ音乐扫码',
    webPreferences: {
      partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true,
      backgroundThrottling: false
    }
  });
  /* 关键：Windows 上隐藏窗口默认不绘制 → capturePage 全黑。paintWhenInitiallyHidden 让首帧照常画 */
  try { win.webContents.setBackgroundThrottling(false); } catch { /* noop */ }
  /* 截图兜底：若 capturePage 持续空窗，退化为「屏幕外可见窗口」模式（仍渲染但不被用户看到）。
     setOpacity(0)：Windows 多屏/系统把屏幕外坐标拉回可见工作区时依然完全不可见
     （透明窗口照常渲染，capturePage 截的是页面内容不受影响）——用户曾看到
     「扫描成功，请在手机上确认」窗口在桌面上残留 */
  setTimeout(() => {
    if (!win.isDestroyed() && !sess.done && sess.phase === 'qr' && !sess.lastShot) {
      try {
        win.setPosition(-32000, -32000);
        win.showInactive();
        win.setOpacity(0);
        console.log('[qr:qqmusic] 隐藏窗无画面，已切屏幕外透明渲染模式（-32000 + opacity 0，多屏下也绝不可见）');
      } catch { /* noop */ }
    }
  }, 4000);

  sess.win = win;
  win.on('closed', () => {
    if (_sessions.get(platform) === sess && !sess.done) {
      _closeSession(platform);
      _send(getWin, 'login-qr-update', { platform, type: 'closed', token: sess.token });
      console.log(`[qr:${platform}] 登录窗口被关闭，登录未完成`);
    }
  });

  /* ---- OAuth 阶段共用：可信域弹窗托管 + 自动点登录/授权 ---- */
  let settled = false, finalizePending = false, warmupTimer = null, warmupWindow = null;
  const popupWindows = sess.popups;

  const autoClickAuth = (w) => {
    if (!w || w.isDestroyed()) return;
    _exec(w, `
      setTimeout(() => {
        const nodes = Array.from(document.querySelectorAll('a, button, span, div'));
        const node = nodes.find((n) => {
          const t = (n.textContent || '').trim();
          if (!/^登录$|立即登录|点击登录|授权/.test(t) || t.length > 6) return false;
          const r = n.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        if (node) node.click();
      }, 700);
    `).catch(() => {});
  };

  const installHandlers = (w) => {
    if (!w || w.isDestroyed()) return;
    w.webContents.setWindowOpenHandler(({ url }) => {
      if (_trustedQqUrl(url)) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            width: 420, height: 520, show: false, skipTaskbar: true, autoHideMenuBar: true,
            webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
          }
        };
      }
      return { action: 'deny' };
    });
    w.webContents.on('did-create-window', (child) => {
      popupWindows.add(child);
      child.on('closed', () => popupWindows.delete(child));
      installHandlers(child);
      child.webContents.once('did-finish-load', () => autoClickAuth(child));
    });
    w.webContents.on('did-finish-load', () => {
      try { _qrlog(`[qqmusic] 页面到达: ${w.webContents.getURL().slice(0, 150)}`); } catch { /* noop */ }
      checkCookies();
    });
    /* 扫码确认瞬间窗口自隐：xlogin 页在手机确认后会 302 跳授权链（graph
       login_jump）——顶层导航一旦离开 ptlogin 即说明用户已确认，二维码使命
       已完成，窗口立即隐藏（授权链在隐藏窗继续跑，背景不节流）。
       仅 qr 阶段生效（oauth 阶段主窗还要加载 SPA 换票，不能隐） */
    w.webContents.on('did-navigate', () => {
      if (w !== win || sess.phase !== 'qr' || settled || sess.done) return;
      try {
        const u = w.webContents.getURL();
        if (!/ptlogin2\.qq\.com|xui\.ptlogin/.test(u)) {
          win.hide();
          _qrlog('[qqmusic] 手机已确认（页面已跳转授权链）→ 窗口立即隐藏');
        }
      } catch { /* noop */ }
    });
  };

  const checkCookies = async () => {
    if (settled || sess.done) return;
    let state = 'none', cookies = [];
    try { cookies = await ses.cookies.get({}); state = _qqLoginState(cookies); } catch { return; }
    /* 监控：登录态变化必记；oauth 阶段每轮 dump（Cookie 落哪个域一目了然） */
    if (state !== sess.lastLoggedState) {
      sess.lastLoggedState = state;
      _qrlog(`[qqmusic] 状态→${state} | ${_cookieDigest(cookies)}`);
    } else if (sess.phase === 'oauth') {
      _qrlog(`[qqmusic] oauth轮询 | ${_cookieDigest(cookies)}`);
    }
    if (state === 'playback') {
      if (finalizePending) return;
      finalizePending = true;
      await sleep(450);
      let state2 = 'none', cookies = [];
      try { cookies = await ses.cookies.get({}); state2 = _qqLoginState(cookies); } catch { /* noop */ }
      if (state2 === 'playback') {
        settled = true;
        sess.phase = 'done';
        if (sess.pollTimer) clearInterval(sess.pollTimer);
        cleanupAux();
        /* 登录完成：主窗口（含屏幕外兜底窗）一并关闭 —— 成功后不再有任何
           官方页残留窗口（用户「登录成功后不想看到这个」） */
        try { if (!win.isDestroyed()) win.close(); } catch { /* noop */ }
        try { await ses.flushStorageData(); } catch { /* noop */ }
        _qrlog('[qqmusic] ★ 播放票据已签发，登录完成');
        console.log('[qr:qqmusic] 播放票据已签发，登录完成');
        const profile = await _scrapeProfile(platform, sess).catch(() => ({}));
        try { cookies = await ses.cookies.get({}); } catch { /* noop */ }
        await _saveSuccess(platform, cookies, profile, mgr, getWin);
      } else { finalizePending = false; }
      return;
    }
    if (state === 'generic' && sess.phase === 'qr') {
      /* 手机已确认扫码。官网 iframe 场景：iframe 内 ptlogin 自动 302 login_jump（带
         完整官网上下文）→ graph 换 code → wx_redirect 回 y.qq.com → qm_keyst 签发。
         绝不导航打断（上一版顶层直载 5s 导航 authorize，graph 不认裸 s_url 种的态
         → 302 show?which=Login 出新码 =「确认后没反应」的根因）。30s 无票才兜底 */
      if (!sess.scanAt) {
        sess.scanAt = Date.now();
        _send(getWin, 'login-qr-update', { platform, type: 'scanned', token: sess.token });
        _qrlog('[qqmusic] 手机已确认 → 等 iframe 官网链自动换票（30s 无票才兜底）');
        console.log('[qr:qqmusic] 扫码确认，等待官网 iframe 链自动签发 qm_keyst');
        /* 确认瞬间立即隐藏窗口：截图已不需要，授权链（iframe 302 + JS）在 hidden
           窗照常执行（backgroundThrottling:false）—— 用户绝不该看到
           「扫描成功，请稍候」等待页（屏幕外兜底窗口在多屏下可能落入可见区） */
        try { if (!win.isDestroyed() && win.isVisible()) win.hide(); } catch { /* noop */ }
        setTimeout(() => {
          if (!settled && !sess.done && sess.phase === 'qr') startOauth();
        }, 30000);
      }
      return;
    }
  };

  const cleanupAux = () => {
    if (warmupTimer) { clearTimeout(warmupTimer); warmupTimer = null; }
    for (const w of [...popupWindows]) { try { if (!w.isDestroyed()) w.close(); } catch { /* noop */ } }
    popupWindows.clear();
    if (warmupWindow && !warmupWindow.isDestroyed()) { try { warmupWindow.close(); } catch { /* noop */ } }
    warmupWindow = null;
  };

  const startOauth = () => {
    sess.phase = 'oauth';
    sess.oauthAt = Date.now();
    _send(getWin, 'login-qr-update', { platform, type: 'scanned', token: sess.token });
    /* 30s 兜底（正常不应走到：官网 iframe 链自动换票）：warmup 窗加载 player SPA
       二次触发签发；主窗口也转过去双保险 */
    win.loadURL(QQ_WEB.warmupUrl).catch(() => {});
    _qrlog('[qqmusic] startOauth 兜底: 主窗转 player SPA + warmup 窗');
    setTimeout(() => autoClickAuth(win), 3000);
    setTimeout(() => { if (!settled && !sess.done && sess.phase === 'oauth') autoClickAuth(win); }, 12000);
    /* 12s 还没 playback（wx_redirect 换票失败等）：warmup 窗转 player SPA 二次触发签发 */
    warmupTimer = setTimeout(() => {
      warmupTimer = null;
      if (settled || sess.done) return;
      warmupWindow = new BrowserWindow({
        width: 720, height: 520, show: false, skipTaskbar: true, autoHideMenuBar: true,
        webPreferences: { partition: part, contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false }
      });
      warmupWindow.on('closed', () => { warmupWindow = null; });
      warmupWindow.webContents.on('did-finish-load', checkCookies);
      warmupWindow.loadURL(QQ_WEB.warmupUrl).catch(() => {});
    }, 12000);
    /* 20s 超时（兜底 30s + 20s = 确认后 50s 上限）：不能无限死等 */
    setTimeout(() => {
      if (settled || sess.done) return;
      sess.done = true;
      if (sess.pollTimer) clearInterval(sess.pollTimer);
      cleanupAux();
      try { if (!win.isDestroyed()) win.close(); } catch { /* noop */ }
      _send(getWin, 'login-qr-update', { platform, type: 'expired', token: sess.token });
      _qrlog('[qqmusic] ✗ 超时：确认后 50s 未取得业务票（见上方 oauth 轮询 Cookie 域分布定位断点）');
      console.warn('[qr:qqmusic] 登录超时：未取得播放票据');
    }, 20000);
  };

  /* ---- 二维码截图推流：探测 → 截屏 → 裁剪 → 推 UI（页面自动换码我们自动跟） ---- */
  const pushQrShot = async () => {
    if (sess.done || sess.phase !== 'qr' || win.isDestroyed()) return;
    /* 1) 探码区（缓存矩形，码位置不变；探测 3 次失败则整页截） */
    if (!sess.qrRect || sess.probeCnt % 8 === 0) {
      const r = await _probeQrRect(win);
      if (r) sess.qrRect = r;
      sess.probeCnt++;
    }
    if (!sess.qrRect) return;   // 页面还没就绪，下轮再试
    /* 2) 截屏（隐藏窗口依赖 paintWhenInitiallyHidden 保持有画面） */
    let img;
    try { img = await win.webContents.capturePage(); }
    catch { return; }
    if (!img || img.isEmpty()) return;
    /* 3) 换算裁剪：截图=物理像素，矩形=CSS像素；zoom 后 1 CSS px = zoom×DPI 物理像素。
       X/Y 分开算（PoC 实测截图与窗口内容存在轻微非均匀偏差，统一 scale 会裁歪） */
    const s = img.getSize();
    const [cw, chh] = (() => { try { return win.getContentSize(); } catch { return [0, 0]; } })();
    let scaleX = 1, scaleY = 1;
    try {
      scaleX = (s.width / Math.max(1, cw)) * QQ_ZOOM;
      scaleY = (s.height / Math.max(1, chh)) * QQ_ZOOM;
    } catch { /* noop */ }
    if (!isFinite(scaleX) || scaleX <= 0 || scaleX > 8) scaleX = 1;
    if (!isFinite(scaleY) || scaleY <= 0 || scaleY > 8) scaleY = 1;
    const qr = sess.qrRect;
    const pad = 12;   /* 静区：二维码四周必须有白边才扫得起（码本体边缘即图案） */
    const cx = Math.max(0, Math.round((qr.x - pad) * scaleX));
    const cy = Math.max(0, Math.round((qr.y - pad) * scaleY));
    const crop = {
      x: cx, y: cy,
      width: Math.min(s.width - cx, Math.round((qr.w + pad * 2) * scaleX)),
      height: Math.min(s.height - cy, Math.round((qr.h + pad * 2) * scaleY))
    };
    if (crop.width < 60 || crop.height < 60) return;
    const out = img.crop(crop).toDataURL();
    /* 4) 与上次不同才推（页面换码自动同步，同码不重复刷） */
    if (out !== sess.lastShot) {
      if (!sess.firstShot) { sess.firstShot = true; _qrlog(`[qqmusic] 首码已推送 (${crop.width}x${crop.height}px)`); }
      sess.lastShot = out;
      sess.state = 'wait';
      _send(getWin, 'login-qr-update', { platform, type: 'refresh', qrSrc: out, token: sess.token });
    }
  };

  _qrlog(`[qqmusic] === 会话启动（zoom=${QQ_ZOOM}，截图推码 + Cookie 轮询）===`);
  installHandlers(win);

  /* ---- 主轮询：截图推码（1.2s）+ Cookie 检测（2.4s 间隔合并在内） ---- */
  let tick = 0;
  sess.pollTimer = setInterval(() => {
    tick++;
    pushQrShot().catch(() => {});
    if (tick % 2 === 0) checkCookies().catch((e) => console.error(`[qr:${platform}] poll 异常:`, e?.message));
  }, 1200);

  /* 官网原生链：加载 y.qq.com → 导航完成 zoom → 自动点「登录」让官网弹 iframe
     （PoC 验证：隐藏窗口下官网可点、iframe 正常弹出）。多次重试应对 SPA 慢加载 */
  const _clickLoginBtn = () => {
    if (win.isDestroyed() || sess.phase !== 'qr') return;
    _exec(win, `(() => {
      /* 官网「登录」文字按钮（顶栏），点击后注入登录 iframe */
      const nodes = Array.from(document.querySelectorAll('a, button, span, div')).filter((n) => {
        const t = (n.textContent || '').trim();
        return t === '登录' && n.children.length === 0 && n.getBoundingClientRect().width > 0;
      });
      if (nodes.length) { (nodes[nodes.length - 1]).click(); return 'clicked'; }
      return 'noop';
    })()`).then((r) => {
      if (r === 'clicked') _qrlog('[qqmusic] 已点击官网「登录」→ iframe 弹出');
      else setTimeout(_clickLoginBtn, 2000);   /* SPA 未就绪，2s 后重试 */
    }).catch(() => setTimeout(_clickLoginBtn, 2500));
  };
  win.loadURL(QQ_WEB.loginUrl).then(() => {
    /* zoom 必须在导航完成后设置（导航会重置 per-origin 缩放） */
    try { win.webContents.setZoomFactor(QQ_ZOOM); } catch { /* noop */ }
    setTimeout(_clickLoginBtn, 1800);
  }).catch(() => {
    console.warn(`[qr:${platform}] 官网加载失败，重试一次`);
    win.loadURL(QQ_WEB.loginUrl).then(() => {
      try { win.webContents.setZoomFactor(QQ_ZOOM); } catch { /* noop */ }
      setTimeout(_clickLoginBtn, 1800);
    }).catch(() => {});
  });
  console.log(`[qr:${platform}] 官网原生链：隐藏窗口加载官网 → 自动点登录 → iframe 截图推码`);
  return { ok: true, platform, name: cfg.name, qrToken: sess.token,
    hint: '正在生成二维码，请稍候' };
}

/* ================= IPC 注册 =================
   start-qr-login  入参 platform：'netease' | 'qqmusic'
                   返回 { ok, platform, name, qrSrc?, hint, msg? }
   cancel-qr-login 入参 platform，返回 true（幂等）
   另托管登录弹层辅助接口：平台列表（含资料回显） / 退出登录 */
export function registerQrLoginIPC(mgr, getWin) {
  // 真登录判定凭证表注入宿主：manager.loginInfo(srcId) 据此判定 loggedIn
  mgr.loginCookieKeys = Object.fromEntries(Object.values(PLATFORMS).map((p) => [p.srcId, p.cookieGroups.flat()]));

  ipcMain.handle('start-qr-login', async (_e, platform) => {
    const cfg = PLATFORMS[platform];
    if (!cfg) return { ok: false, msg: `未知平台：${platform}` };
    _closeSession(platform); // 重入自动关闭上一会话，防多实例冲突
    try {
      return await (cfg.web ? _apiStart(platform, mgr, getWin) : _pageStart(platform, mgr, getWin));
    } catch (e) {
      _closeSession(platform);
      return { ok: false, msg: e.message || '启动扫码登录失败' };
    }
  });

  ipcMain.handle('cancel-qr-login', (_e, platform) => { _closeSession(platform); return true; });

  // 登录平台列表（登录弹层用）：双平台恒在，不依赖音源插件；附带登录态与账号资料回显
  ipcMain.handle('source:login:platforms', () => {
    const data = _readJson(_cookieFile());
    return Object.entries(PLATFORMS).map(([id, p]) => ({
      id, name: p.name, kind: 'page', hint: p.hint,
      loggedIn: mgr.loginInfo(p.srcId).loggedIn,
      profile: data[id]?.profile || null
    }));
  });

  // 退出登录：清 CookieJar + 删 json 记录 + 清该平台持久化 partition（彻底回落匿名态）
  ipcMain.handle('source:logout', async (_e, id) => {
    // 兼容平台 key（'qqmusic'）与音源 id（'qq'）两种入参
    const entry = PLATFORMS[id] ? [id, PLATFORMS[id]]
      : Object.entries(PLATFORMS).find(([, p]) => p.srcId === id) || [];
    const [platform, cfg] = entry;
    const srcId = cfg?.srcId || id;
    _closeSession(platform);
    mgr.cookieClear(srcId);
    mgr._markAlive?.(srcId);
    const file = _cookieFile();
    const data = _readJson(file);
    if (platform && data[platform]) { delete data[platform]; _writeJson(file, data); }
    if (cfg) { // 清持久化分区里的 Cookie（partition 落盘文件保留无碍）
      try { await session.fromPartition('persist:qr-login-' + platform).clearStorageData({ storages: ['cookies'] }); } catch { /* noop */ }
    }
    return mgr.loginInfo(srcId);
  });
}

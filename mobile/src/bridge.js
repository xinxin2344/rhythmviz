/* RhythmViz 移动端 window.api 垫片：对齐桌面 preload.cjs 全部接口，
   音源走移动宿主（原生 RhythmNet），设置/Cookie 走 localStorage。 */
import { installGlobals } from './buffer-poly.js';
import { MobileSourceManager } from './host/manager.js';
import { QrLoginManager } from './host/qrlogin.js';

installGlobals();

/* ---------------- 方向 / 平台标记 ---------------- */
document.documentElement.classList.add('rv-mobile', 'rv-android');
/* 背景清晰度（--bg-veil）：此处同步应用，早于任何背景渲染——设置页滑块写
   localStorage，启动即刻恢复，避免闪一下默认遮罩浓度 */
try {
  const _v = parseFloat(localStorage.getItem('rvBgVeil'));
  if (Number.isFinite(_v) && _v >= 0 && _v <= 0.7) {
    document.documentElement.style.setProperty('--bg-veil', String(_v));
  }
} catch { /* noop */ }
const applyOrient = () => {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  document.documentElement.classList.toggle('rv-portrait', portrait);
  document.documentElement.classList.toggle('rv-landscape', !portrait);
};
applyOrient();
window.addEventListener('resize', applyOrient);
window.addEventListener('orientationchange', () => setTimeout(applyOrient, 100));

/* ---------------- 启动看门狗：杜绝任何意外导致的卡启动页 ----------------
   正常流程 app.js boot() 会在 3.3s 撤掉 #splash；若 4.8s 后它仍在，
   说明启动链路有脚本异常——强制进入界面并展示错误诊断条。 */
(function rvBootWatchdog() {
  const errors = [];
  window.addEventListener('error', (e) => {
    try {
      errors.push(`${e.message || 'error'} @ ${(e.filename || '').split('/').pop()}:${e.lineno || 0}`);
    } catch { /* noop */ }
  });
  window.addEventListener('unhandledrejection', (e) => {
    try { errors.push('promise: ' + ((e.reason && e.reason.message) || e.reason || 'rejected')); } catch { /* noop */ }
  });
  setTimeout(() => {
    try {
      const sp = document.getElementById('splash');
      if (sp && !sp.classList.contains('gone')) {
        document.body && document.body.classList.add('show-chrome');
        sp.classList.add('gone');
        setTimeout(() => sp.remove(), 600);
      }
      if (errors.length && document.documentElement.classList.contains('rv-android')) {
        const d = document.createElement('div');
        d.style.cssText =
          'position:fixed;left:12px;right:12px;bottom:88px;z-index:99999;max-width:520px;margin:auto;' +
          'background:rgba(42,12,16,.97);color:#ffd9d9;border:1px solid rgba(255,99,99,.55);' +
          'border-radius:14px;padding:12px 14px;font:12px/1.6 system-ui,sans-serif;' +
          'box-shadow:0 12px 40px rgba(0,0,0,.5);max-height:42vh;overflow:auto;';
        const safe = (s) => String(s).replace(/[<>&]/g, '');
        d.innerHTML = '<b style="color:#ff8a8a">启动过程出现异常，已自动进入</b><br>' +
          errors.slice(0, 3).map((x) => '· ' + safe(x)).join('<br>');
        const btn = document.createElement('button');
        btn.textContent = '知道了';
        btn.style.cssText =
          'margin-top:8px;padding:6px 18px;border:0;border-radius:999px;background:#e04444;color:#fff;font-size:12px;';
        btn.onclick = () => d.remove();
        d.appendChild(btn);
        (document.body || document.documentElement).appendChild(d);
        setTimeout(() => { try { d.remove(); } catch { /* noop */ } }, 15000);
      }
    } catch { /* noop */ }
  }, 4800);
})();

/* ---------------- 宿主初始化 ---------------- */
let _mgr = null;
let _qr = null;
const _ready = (async () => {
  _mgr = new MobileSourceManager();
  await _mgr.init();
  _qr = new QrLoginManager(_mgr);
  window.__rv = { mgr: _mgr, qr: _qr };
  return { mgr: _mgr, qr: _qr };
})();
_ready.catch((e) => console.error('[rv] 宿主初始化失败', e));

/* ---------------- 设置（逐键合并，对齐桌面 settings:set） ---------------- */
function readSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('rv-settings') || '{}') || {};
    // 桌面专属：本地视频背景路径 / 本地曲库路径在安卓无意义
    delete s.bgVideo;
    s.localPaths = [];
    // 手机端默认体验（仅键不存在时注入，显式清除/更换后完全尊重用户选择）：
    // 启动页默认银河 WebGL 效果；初始背景用 cosmos 高级感渐变
    if (s.splash === undefined) s.splash = 'mr-galaxy'; // 手机端默认银河启动页（设置页可关，显式 follow 尊重用户选择）
    if (!('bgPreset' in s) && !s.bg) s.bgPreset = 'cosmos';
    return s;
  } catch { return { localPaths: [] }; }
}
function writeSetting(key, val) {
  const s = readSettings();
  s[key] = val;
  try { localStorage.setItem('rv-settings', JSON.stringify(s)); } catch { /* ignore */ }
}

/* ---------------- 事件桥 ---------------- */
const _qrUpdateCbs = new Set();
const _qrSuccessCbs = new Set();
const _notifyCbs = new Set();
_ready.then(({ qr, mgr }) => {
  qr.onUpdate((d) => _qrUpdateCbs.forEach((cb) => { try { cb(d); } catch { /* noop */ } }));
  qr.onSuccess((d) => _qrSuccessCbs.forEach((cb) => { try { cb(d); } catch { /* noop */ } }));
  mgr.onNotify((m) => _notifyCbs.forEach((cb) => { try { cb(m); } catch { /* noop */ } }));
});
// 初始化期间也能注册（setupUI 早于宿主就绪）
window.__rvQrUpdateCbs = _qrUpdateCbs;
window.__rvQrSuccessCbs = _qrSuccessCbs;

const noop = () => {};
const unsupported = () => Promise.resolve(null);

/* ---------------- window.api ---------------- */
window.api = {
  /* 本地文件（移动端不支持，静默返回空，UI 入口在 mobile.css 中隐藏）；
     pickBackground 例外——已支持选图（见下方实现），勿在此再占位 */
  getPathForFile: () => null,
  openAudioDialog: () => Promise.resolve([]),
  openAudioFolder: () => Promise.resolve([]),
  pickImage: () => Promise.resolve(null),
  pickSourceJs: () => Promise.resolve(null),
  readFile: () => Promise.resolve(null),
  readText: () => Promise.resolve(null),
  findLyric: () => Promise.resolve(null),
  parseMeta: () => Promise.resolve(null),

  /* 设置 */
  getSettings: () => Promise.resolve(readSettings()),
  setSetting: (key, val) => { writeSetting(key, val); return Promise.resolve(true); },

  /* mini 窗 / 窗口控制：移动端无对应能力 */
  openMini: noop,
  sendMiniState: noop,
  onMiniSync: noop,
  miniControl: noop,
  closeMini: noop,
  onMiniCmd: noop,
  minimizeWindow: noop,
  toggleMaximize: noop,
  setFullscreen: noop,
  closeWindow: noop,
  closeChoice: noop,
  onMinimized: noop,
  onMaximized: noop,
  onCloseAsk: noop,

  /* ---------------- 在线音源 ---------------- */
  sourceList: () => _ready.then(({ mgr }) => mgr.list()),
  sourceImport: () => Promise.reject(new Error('安卓版暂不支持导入外部音源')),
  sourceRemove: (id) => _ready.then(({ mgr }) => { mgr.toggle(id, false); return { id }; }),
  sourceToggle: (id, on) => _ready.then(({ mgr }) => mgr.toggle(id, on)),
  sourceSearch: (srcId, kw, page) => _ready.then(({ mgr }) => mgr.search(srcId, kw, page)),
  sourceSearchAll: (kw) => _ready.then(({ mgr }) => mgr.searchAll(kw)),
  sourceSearchArtist: (kw) => _ready.then(({ mgr }) => mgr.searchArtist(kw)),
  sourceArtistAlbums: (srcId, id) => _ready.then(({ mgr }) => mgr.artistAlbums(srcId, id)),
  sourceArtistTop: (srcId, id, name) => _ready.then(({ mgr }) => mgr.artistTop(srcId, id, name)),
  sourceFeed: () => _ready.then(({ mgr }) => mgr.feed()),
  sourcePlaylistDetail: (pid) => _ready.then(({ mgr }) => mgr.playlistDetail(pid)),
  sourceUserPlaylists: (srcId) => _ready.then(({ mgr }) => mgr.userPlaylists(srcId)),
  sourceConfigGet: () => _ready.then(({ mgr }) => mgr.getConfig()),
  sourceConfigSet: (patch) => _ready.then(({ mgr }) => mgr.setConfig(patch)),
  sourcePlayUrl: (spec) => _ready.then(({ mgr }) => mgr.resolvePlayUrl(spec || {})),
  sourceLyric: (srcId, id) => _ready.then(({ mgr }) => mgr.getLyric(srcId, id)),
  sourceLyricMatch: (spec) => _ready.then(({ mgr }) => mgr.matchLyric(spec || {})),
  sourceBinary: (url, headers) => _ready.then(({ mgr }) => mgr.binary(url, headers || {})),

  /* 歌单音频磁盘缓存：移动端不做落盘缓存（blob 会话内持有） */
  audioCacheTake: () => Promise.resolve(null),
  audioCachePrefetch: () => Promise.resolve(true),
  audioCacheClear: () => Promise.resolve(true),

  /* 自定义背景选图：Electron dialog 的手机版 —— <input type=file> 唤起系统选图器
     （Capacitor WebView 原生支持 file chooser），读成 dataURL 与桌面同构，
     ui.js 拿到后走同一 applyBg 链路。相册原图 dataURL 动辄 5-8MB 会爆
     localStorage 配额 → canvas 压到 1280 宽 JPEG（约 200-400KB）再返回 */
  pickBackground: () => new Promise((resolve) => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    /* 不能 display:none：Android WebView 的文件选择器对不可见 input 的程序化
       click() 常不响应（相册根本弹不出来 =「换背景没反应」）——移出视口代替 */
    inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none';
    inp.onchange = () => {
      const f = inp.files && inp.files[0];
      if (!f) { resolve(null); return; }
      const fr = new FileReader();
      fr.onload = () => {
        const img = new Image();
        img.onload = () => {
          try {
            const W = Math.min(1280, img.naturalWidth || 1280);
            const H = Math.round((img.naturalHeight || 720) * (W / (img.naturalWidth || 1280)));
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            cv.getContext('2d').drawImage(img, 0, 0, W, H);
            resolve(cv.toDataURL('image/jpeg', 0.85));
          } catch { resolve(String(fr.result || '') || null); }  /* 压缩失败退回原图 */
        };
        img.onerror = () => resolve(String(fr.result || '') || null);
        img.src = String(fr.result || '');
        if (!img.src) resolve(null);
      };
      fr.onerror = () => resolve(null);
      fr.readAsDataURL(f);
    };
    inp.addEventListener('cancel', () => resolve(null));
    document.body.appendChild(inp);
    inp.click();
    setTimeout(() => inp.remove(), 5 * 60 * 1000); // 兜底清理
  }),
  pickBackgroundVideo: () => Promise.resolve(null),   // 视频背景仍是桌面专属

  /* 扫码登录 */
  /* QQ 平台入口直接走原生官方页登录（协议已死，见 _qqNativeLogin 注释）；
     ui.js 对 webWindow 返回值显示「已打开官方登录窗口」占位，成功/取消
     分别经 onLoginSuccess / closed 更新回传 */
  qrLoginStart: (platform) => {
    if (platform === 'qqmusic' && isNative) {
      _qqNativeLogin();   // 异步：成功→onLoginSuccess，取消/失败→closed 更新 + toast
      return Promise.resolve({ ok: true, webWindow: true });
    }
    /* 网易同走原生官方页 WebView：原生 HttpURLConnection 的 Java TLS 指纹
       被网易登录端点风控拒绝（出码后轮询恒 8821，签名/清 Cookie 均无效），
       官方网页自身 JS 出码轮询（Chromium 指纹）则畅通——与 QQ 同构方案 */
    if (platform === 'netease' && isNative) {
      _neteaseNativeLogin();
      return Promise.resolve({ ok: true, webWindow: true });
    }
    return _ready.then(({ qr }) => qr.start(platform));
  },
  qrLoginCancel: (platform) => { _qr?.cancel(platform); return Promise.resolve(true); },
  onLoginQrUpdate: (cb) => { _qrUpdateCbs.add(cb); },
  onLoginSuccess: (cb) => { _qrSuccessCbs.add(cb); },
  /* 退出登录：ui.js 传平台 id（'qqmusic'），而 Jar 空间按音源 id（'qq'）隔离——
     必须映射，否则清错空间 → 退出后仍显示已登录（实测 bug） */
  sourceLogout: (srcId) => _ready.then(({ mgr }) => mgr.logout(srcId === 'qqmusic' ? 'qq' : srcId)),
  sourceLoginInfo: (srcId) => _ready.then(({ mgr }) => mgr.loginInfo(srcId)),
  sourceLoginPlatforms: () => _ready.then(({ qr }) => qr.platforms()),

  /* 代理 / 更新：移动端不支持 */
  sourceProxyGet: () => Promise.resolve({ enabled: false, list: [], proxies: [] }),
  sourceProxySet: () => Promise.resolve(true),
  sourceUpdateCheck: () => Promise.resolve({ hasUpdate: false, msg: '内置音源随应用更新' }),
  onSourceNotify: (cb) => { _notifyCbs.add(cb); },

  /* 桌面自动化测试钩子：移动端永不触发 */
  onAutotest: noop,
  onShot: noop
};

/* ============================================================
   移动端原生交互壳（网易云式常规手机播放器）
   1. 底部三 Tab：首页 / 搜索 / 我的
   2. 系统返回键逐级返回（弹层 → 歌单页 → Tab → 播放页 → 再按退出）
   3. 歌单详情用普通竖向歌曲列表，不进桌面端「歌单拼图」
   4. 登录方式：扫码登录 + 账号密码登录（网易直登 / QQ 官方登录页）
   ============================================================ */
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';

const QqLogin = registerPlugin('QqLogin');
const NeteaseLogin = registerPlugin('NeteaseLogin');
const MediaNotif = registerPlugin('MediaNotif');
const isNative = !!window.Capacitor?.isNativePlatform?.();

/* QQ 原生登录流：纯 API 扫码协议（ptqrlogin）已被 ptlogin v4 风控拦截
   （实测恒回 23013「当前应用版本过低」→ 扫码确认后永远无反应），改由
   QqLoginPlugin 全屏 WebView 承载官方登录页（协议由腾讯自己的 JS 执行，
   与桌面端「真浏览器」方案同思路），收割 Cookie 后并入音源 Jar */
/* QQ 登录阶段事件（模块级注册一次）：让用户看到流程卡在哪一步（确认/换票兜底） */
try {
  QqLogin.addListener?.('qqStage', ({ stage }) => {
    whenDom(() => rvToast(stage === 'confirmed'
      ? '已确认，正在获取 QQ 音乐登录态…'
      : '正在通过官网换票…（约几秒）'));
  });
} catch { /* noop */ }

async function _qqNativeLogin() {
  try {
    const res = await QqLogin.open();
    const { qr } = await _ready;
    await qr.finishQqFromCookies(res?.cookies || []);
    return { ok: true };
  } catch (e) {
    const cancelled = e?.message === 'cancelled';
    const msg = cancelled ? '已取消 QQ 登录' : ('QQ 登录失败：' + (e?.message || '未知错误'));
    try { _qrUpdateCbs.forEach((cb) => cb({ platform: 'qqmusic', type: 'closed', token: String(Date.now()) })); } catch { /* noop */ }
    whenDom(() => rvToast(msg));
    return { ok: false, msg };
  }
}

/* 网易原生登录流：全屏 WebView 承载官方网页登录页（扫码），MUSIC_U 收割后
   并入音源 Jar → 拉资料 → onLoginSuccess。失败/取消走 closed 更新 + toast */
async function _neteaseNativeLogin() {
  try {
    const res = await NeteaseLogin.open();
    const { qr } = await _ready;
    await qr.finishNeteaseFromCookies(res?.cookies || []);
    return { ok: true };
  } catch (e) {
    const cancelled = e?.message === 'cancelled';
    const msg = cancelled ? '已取消登录' : ('网易云登录失败：' + (e?.message || '未知错误'));
    try { _qrUpdateCbs.forEach((cb) => cb({ platform: 'netease', type: 'closed', token: String(Date.now()) })); } catch { /* noop */ }
    whenDom(() => rvToast(msg));
    return { ok: false, msg };
  }
}

/* ---------- 小工具 ---------- */
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));
const whenDom = (fn) => {
  if (document.body) fn();
  else document.addEventListener('DOMContentLoaded', fn, { once: true });
};
function rvToast(msg) {
  let t = $('#rvToast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'rvToast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2200);
}

/* ---------- 包装歌单详情 API：缓存最近一次云端歌单/专辑曲目 ---------- */
const _origPlaylistDetail = window.api.sourcePlaylistDetail.bind(window.api);
let pendingCloud = null; // { id, ts, resolve, reject, detail? }
window.api.sourcePlaylistDetail = (pid) => {
  const rec = { id: pid, ts: Date.now(), detail: null };
  pendingCloud = rec;
  const p = _origPlaylistDetail(pid)
    .then((det) => { rec.detail = det; return det; })
    .catch((e) => { rec.error = e; throw e; });
  return p;
};

/* ---------- 本地歌单曲目（我喜欢 / 自建歌单，取自 localStorage 设置） ---------- */
function localPlaylistByName(name) {
  let s = {};
  try { s = JSON.parse(localStorage.getItem('rv-settings') || '{}'); } catch { /* noop */ }
  if (name === '我喜欢的音乐') {
    return { name, tracks: (s.favSongs || []).map(songShape) };
  }
  const upl = (s.userPlaylists || []).find((p) => p.name === name);
  if (upl) return { name: upl.name, tracks: (upl.tracks || []).map(songShape) };
  return null;
}
function songShape(x) {
  return {
    id: x.id, srcId: x.srcId || null, name: x.name,
    artist: x.artist || '', album: x.album || '',
    coverUrl: x.coverUrl || '', duration: x.duration || 0
  };
}

/* ============================================================
   一、底部 Tab 壳
   ============================================================ */
const TABS = [
  { id: 'home', label: '首页', icon: '⌂' },
  { id: 'search', label: '搜索', icon: '⌕' },
  { id: 'mine', label: '我的', icon: '♪' }
];
let curTab = 'home';

function buildTabbar() {
  if ($('#rvTabbar')) return;
  const bar = document.createElement('nav');
  bar.id = 'rvTabbar';
  bar.innerHTML = TABS.map((t) =>
    `<button class="rv-tab" data-tab="${t.id}"><span class="rv-tab-ic">${t.icon}</span><span class="rv-tab-tx">${t.label}</span></button>`
  ).join('');
  document.body.appendChild(bar);
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('.rv-tab');
    if (b) switchTab(b.dataset.tab);
  });
  switchTab('home');
}

function switchTab(id) {
  curTab = id;
  document.body.classList.remove('rv-tab-home', 'rv-tab-search', 'rv-tab-mine');
  document.body.classList.add('rv-tab-' + id);
  $$('#rvTabbar .rv-tab').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
  // 首页 Tab：永远「回到」首页（btnHome 是开关式 toggle，已在首页时再点会误关进频谱页）
  if (id === 'home') {
    document.body.classList.add('home-active');
    window.__app?.toggleNp(false);
  }
  if (id === 'search') {
    setTimeout(() => { $('#homeSearchInput')?.focus(); }, 120);
  }
  if (id === 'mine') refreshAccountCard();
}

/* 我的页：账号状态卡（点击复用桌面端登录弹层） */
function buildAccountCard() {
  if ($('#rvAccount')) return;
  const sec = $('#myPlSec');
  if (!sec) return;
  const card = document.createElement('button');
  card.id = 'rvAccount';
  card.innerHTML = `<span class="rva-ic">👤</span>
    <span class="rva-meta"><b id="rvaName">未登录</b><i id="rvaSub">登录网易云 / QQ音乐账号</i></span>
    <span class="rva-go">›</span>`;
  card.addEventListener('click', () => $('#btnLogin')?.click());
  sec.prepend(card);
}
async function refreshAccountCard() {
  try {
    const { mgr } = await _ready;
    const parts = [];
    for (const src of ['netease', 'qq']) {
      const info = mgr.loginInfo(src);
      if (info?.loggedIn && info.profile?.nickname) parts.push(info.profile.nickname);
    }
    const nm = $('#rvaName'), sub = $('#rvaSub');
    if (!nm) return;
    if (parts.length) { nm.textContent = parts.join(' · '); sub.textContent = '已登录 · 点头像可切换账号'; }
    else { nm.textContent = '未登录'; sub.textContent = '登录网易云 / QQ音乐账号'; }
  } catch { /* noop */ }
}

/* ============================================================
   手机专属设置页（#rvSettings 全屏覆盖层，网易云式列表，非桌面 fxPanel）
   主题色 / 启动页银河 / 主页背景预设 / 歌词扫光 / 关于
   即时生效走 window.__app（桌面 app 实例），持久化走 settings
   ============================================================ */
const RVS_BG_PRESETS = [
  ['cosmos', '星云'], ['aurora', '极光'], ['dusk', '暮色'], ['ocean', '深海'],
  ['violet', '紫罗兰'], ['rose', '玫瑰'], ['ember', '余烬'], ['forest', '森野'],
  ['mint', '薄荷'], ['jade', '碧玉'], ['graphite', '石墨'], ['mono', '月白'],
];
const RSV_HUES = [258, 288, 330, 18, 42, 148, 195, 218];
function closeRvSettings() { $('#rvSettings')?.classList.remove('rvs-open'); }
function openRvSettings() { buildRvSettings().catch((e) => console.error('[rv-settings]', e)); }

async function buildRvSettings() {
  let v = $('#rvSettings');
  if (v) { v.classList.add('rvs-open'); syncRvSettings(v); return; }
  v = document.createElement('div');
  v.id = 'rvSettings';
  v.innerHTML = `
    <div class="rvs-head"><button class="rvs-back">‹</button><b class="rvs-title">设置</b></div>
    <div class="rvs-body">
      <div class="rvs-group">外 观</div>
      <div class="rvs-card" id="rvsThemeCard">
        <div class="rvs-row">
          <div><div class="rvs-label">主题颜色跟随封面</div><div class="rvs-note">关闭后使用下方固定主题色</div></div>
          <button class="rvs-sw" id="rvsFollow"></button>
        </div>
        <div class="rvs-dots" id="rvsDots"></div>
      </div>
      <div class="rvs-card" style="margin-top:10px">
        <div class="rvs-row">
          <div><div class="rvs-label">启动页银河效果</div><div class="rvs-note">WebGL 星云流动，重启应用后生效</div></div>
          <button class="rvs-sw" id="rvsGalaxy"></button>
        </div>
      </div>
      <div class="rvs-group">主 页 背 景</div>
      <div class="rvs-card"><div class="rvs-presets" id="rvsPresets"></div></div>
      <div class="rvs-card" style="margin-top:10px">
        <div class="rvs-row">
          <div><div class="rvs-label">自定义颜色背景</div><div class="rvs-note">选两个颜色，生成专属主页渐变</div></div>
        </div>
        <div class="rvs-colors">
          <label>主色 <input type="color" id="rvsC1" value="#7c5cff"></label>
          <label>辅色 <input type="color" id="rvsC2" value="#ff4d6d"></label>
          <button class="rvs-apply" id="rvsBgApply">应用</button>
        </div>
      </div>
      <div class="rvs-card" style="margin-top:10px">
        <div class="rvs-row">
          <div><div class="rvs-label">上传图片背景</div><div class="rvs-note">从相册选一张图当主页背景（与桌面同链路）</div></div>
        </div>
        <div class="rvs-colors">
          <button class="rvs-apply" id="rvsBgPick">从相册选择</button>
          <button class="rvs-apply" id="rvsBgClear" style="background:rgba(255,255,255,.08)">清除图片</button>
        </div>
      </div>
      <div class="rvs-card" style="margin-top:10px">
        <div class="rvs-row">
          <div><div class="rvs-label">背景清晰度</div><div class="rvs-note">越右越清晰；返回主页即可看到效果</div></div>
          <b class="rvs-veil-val" id="rvsVeilVal" style="font-size:12px;color:#aaa;margin-left:auto"></b>
        </div>
        <input type="range" id="rvsVeil" min="0" max="0.7" step="0.05" style="width:100%;accent-color:var(--accent,#a78bfa);margin-top:8px">
      </div>
      <div class="rvs-group">歌 词</div>
      <div class="rvs-card">
        <div class="rvs-row">
          <div><div class="rvs-label">逐字扫光效果</div><div class="rvs-note">卡拉OK式逐字点亮</div></div>
          <button class="rvs-sw" id="rvsKaraoke"></button>
        </div>
      </div>
      <div class="rvs-group">关 于</div>
      <div class="rvs-card">
        <div class="rvs-row"><div class="rvs-label">RhythmViz 移动版</div><span class="rvs-note" style="margin:0">v1.2.0</span></div>
        <div class="rvs-row"><div class="rvs-label">播放页操作</div><span class="rvs-note" style="margin:0">点唱片切歌词 · 点歌词切回</span></div>
      </div>
    </div>`;
  document.body.appendChild(v);
  v.querySelector('.rvs-back').addEventListener('click', closeRvSettings);

  const save = (k, val) => { try { window.api.setSetting(k, val); } catch { /* noop */ } };
  const app = window.__app;

  /* 主题色：跟随开关 + 固定色相板 */
  const dots = v.querySelector('#rvsDots');
  dots.innerHTML = RSV_HUES.map((h) =>
    `<button class="rvs-dot" data-hue="${h}" style="background:hsl(${h} 72% 58%)"></button>`).join('') +
    `<button class="rvs-dot follow" data-hue="follow" title="跟随封面"></button>`;
  dots.addEventListener('click', (e) => {
    const d = e.target.closest('.rvs-dot');
    if (!d) return;
    const hue = d.dataset.hue;
    if (hue === 'follow') {
      save('uiHue', 'follow');
      app?.theme?.setFixedHue?.('follow');
      rvToast('主题颜色：跟随封面取色');
    } else {
      const h = +hue;
      save('uiHue', h);
      app?.theme?.setFixedHue?.(h);
      rvToast('主题颜色已更新');
    }
    syncRvSettings(v);
  });
  v.querySelector('#rvsFollow').addEventListener('click', () => {
    const cur = v.querySelector('#rvsFollow').classList.contains('on');
    if (cur) { save('uiHue', 258); app?.theme?.setFixedHue?.(258); }
    else { save('uiHue', 'follow'); app?.theme?.setFixedHue?.('follow'); }
    syncRvSettings(v);
  });

  /* 启动页银河 */
  v.querySelector('#rvsGalaxy').addEventListener('click', () => {
    const on = !v.querySelector('#rvsGalaxy').classList.contains('on');
  save('splash', on ? 'mr-galaxy' : 'follow');
  if (on) { try { localStorage.setItem('splashGalaxyOn', '1'); localStorage.setItem('spTheme', 'mr-galaxy'); } catch { /* noop */ } }
  else { try { localStorage.removeItem('splashGalaxyOn'); localStorage.setItem('spTheme', 'follow'); } catch { /* noop */ } }
  /* 立即切换（不等重启）：applySplashTheme 读 app.settings.splash —— settings 是
     boot 时的快照，save() 只落 localStorage，必须同步更新内存对象再调 */
  if (app) {
    (app.settings = app.settings || {}).splash = on ? 'mr-galaxy' : 'follow';
    try { app.applySplashTheme?.(); } catch { /* noop */ }
  }
  syncRvSettings(v);
  rvToast(on ? '银河启动页已开启' : '已恢复默认启动页');
  });

  /* 背景清晰度（--bg-veil 暗化遮罩浓度）：滑块值 = 清晰度（右=更清晰 → 遮罩更淡），
     存储/变量仍为浓度。实时生效 + localStorage 持久化，启动早期 bridge 头部恢复 */
  const veilInput = v.querySelector('#rvsVeil');
  const veilVal = v.querySelector('#rvsVeilVal');
  const veilOf = () => {
    const raw = parseFloat(localStorage.getItem('rvBgVeil'));
    return Number.isFinite(raw) && raw >= 0 && raw <= 0.7 ? raw : 0.5;
  };
  const showVeil = (x) => {
    const pct = Math.round((1 - x / 0.7) * 100);
    veilVal.textContent = x <= 0.001 ? '全清晰' : `清晰 ${Math.max(pct, 1)}%`;
  };
  veilInput.value = String(0.7 - veilOf());
  showVeil(veilOf());
  veilInput.addEventListener('input', () => {
    const x = 0.7 - (parseFloat(veilInput.value) || 0);
    try { localStorage.setItem('rvBgVeil', String(x)); } catch { /* noop */ }
    document.documentElement.style.setProperty('--bg-veil', String(x));
    showVeil(x);
  });

  /* 主页背景预设（色板 = 桌面 applyBg 预设渐变的缩略版） */
  const PRESET_SW = {
    cosmos: 'radial-gradient(circle at 68% 22%, rgba(129,140,248,0.9), transparent 62%), radial-gradient(circle at 22% 82%, rgba(217,70,239,0.7), transparent 60%), linear-gradient(160deg, #180d2c, #07040f)',
    aurora: 'radial-gradient(circle at 24% 24%, rgba(0,245,212,0.85), transparent 60%), radial-gradient(circle at 80% 78%, rgba(143,108,255,0.7), transparent 60%), linear-gradient(160deg, #0a211b, #07090d)',
    dusk: 'radial-gradient(circle at 76% 24%, rgba(244,210,138,0.8), transparent 58%), radial-gradient(circle at 20% 80%, rgba(143,108,255,0.75), transparent 60%), linear-gradient(150deg, #221232, #0c0713)',
    ocean: 'radial-gradient(circle at 22% 24%, rgba(56,189,248,0.9), transparent 60%), linear-gradient(155deg, #07233c, #030810)',
    violet: 'radial-gradient(circle at 30% 22%, rgba(143,108,255,0.9), transparent 60%), radial-gradient(circle at 82% 80%, rgba(210,120,255,0.6), transparent 58%), linear-gradient(155deg, #1a0f2e, #0a0612)',
    rose: 'radial-gradient(circle at 72% 24%, rgba(255,120,160,0.85), transparent 60%), linear-gradient(155deg, #2a1020, #10060c)',
    ember: 'radial-gradient(circle at 76% 24%, rgba(251,146,60,0.85), transparent 60%), radial-gradient(circle at 20% 82%, rgba(244,63,94,0.6), transparent 58%), linear-gradient(155deg, #2a120a, #0f0504)',
    forest: 'radial-gradient(circle at 24% 22%, rgba(60,200,120,0.8), transparent 60%), linear-gradient(160deg, #0c2013, #060a07)',
    mint: 'radial-gradient(circle at 26% 24%, rgba(0,245,212,0.9), transparent 60%), linear-gradient(160deg, #07231d, #050b0a)',
    jade: 'radial-gradient(circle at 26% 22%, rgba(52,211,153,0.8), transparent 60%), linear-gradient(160deg, #0a241c, #040b09)',
    graphite: 'radial-gradient(circle at 68% 22%, rgba(90,140,255,0.7), transparent 60%), linear-gradient(160deg, #11141d, #07080d)',
    mono: 'radial-gradient(circle at 50% 18%, rgba(255,255,255,0.4), transparent 60%), linear-gradient(165deg, #171a20, #08090b)'
  };
  const ps = v.querySelector('#rvsPresets');
  ps.innerHTML = RVS_BG_PRESETS.map(([k, n]) =>
    `<button class="rvs-preset" data-key="${k}" style="background:${PRESET_SW[k]}"><i>${n}</i></button>`).join('');
  ps.addEventListener('click', (e) => {
    const b = e.target.closest('.rvs-preset');
    if (!b) return;
    const key = b.dataset.key;
    save('bg', null); save('bgPreset', key);
    app?.applyBg?.(null, key);
    app?.applySplashTheme?.();
    syncRvSettings(v);
    rvToast('背景：' + (RVS_BG_PRESETS.find(([k]) => k === key)?.[1] || key));
  });

  /* 自定义颜色背景：canvas 生成径向渐变 dataURL，走桌面 applyBg 图像通道 */
  v.querySelector('#rvsBgApply').addEventListener('click', () => {
    const c1 = v.querySelector('#rvsC1').value || '#7c5cff';
    const c2 = v.querySelector('#rvsC2').value || '#ff4d6d';
    try {
      const cv = document.createElement('canvas');
      cv.width = 512; cv.height = 512;
      const g = cv.getContext('2d');
      g.fillStyle = '#08070d';
      g.fillRect(0, 0, 512, 512);
      const r1 = g.createRadialGradient(360, 130, 30, 360, 130, 420);
      r1.addColorStop(0, c1); r1.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = r1; g.fillRect(0, 0, 512, 512);
      const r2 = g.createRadialGradient(110, 430, 30, 110, 430, 400);
      r2.addColorStop(0, c2); r2.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = r2; g.fillRect(0, 0, 512, 512);
      const url = cv.toDataURL('image/jpeg', 0.92);
      save('bgPreset', null); save('bg', url);
      app?.applyBg?.(url);
      v.querySelectorAll('#rvsPresets .rvs-preset').forEach((p) => p.classList.remove('on'));
      rvToast('自定义背景已应用');
    } catch (e) { rvToast('生成失败：' + e.message); }
  });

  /* 上传图片背景：window.api.pickBackground（bridge 实现为 <input type=file> 唤起
     系统相册选择器 → dataURL），落 settings.bg 走桌面同一 applyBg 通道 */
  v.querySelector('#rvsBgPick').addEventListener('click', async () => {
    rvToast('打开相册…');
    const url = await window.api.pickBackground();
    if (!url) return;   /* 用户取消选图 */
    save('bgPreset', null); save('bg', url);
    app?.applyBg?.(url);
    syncRvSettings(v);
    rvToast('图片背景已应用');
  });
  v.querySelector('#rvsBgClear').addEventListener('click', () => {
    save('bg', null);
    app?.clearCustomBg?.();
    syncRvSettings(v);
    rvToast('已清除图片背景');
  });

  /* 歌词扫光 */
  v.querySelector('#rvsKaraoke').addEventListener('click', () => {
    const on = !v.querySelector('#rvsKaraoke').classList.contains('on');
    document.body.classList.toggle('rv-karaoke-on', on);
    save('rvKaraoke', on);
    syncRvSettings(v);
  });

  await syncRvSettings(v);
  v.classList.add('rvs-open');
}

async function syncRvSettings(v) {
  let s = {};
  try { s = (await window.api.getSettings()) || {}; } catch { /* noop */ }
  const follow = s.uiHue == null || s.uiHue === 'follow';
  v.querySelector('#rvsFollow')?.classList.toggle('on', follow);
  v.querySelectorAll('#rvsDots .rvs-dot').forEach((d) =>
    d.classList.toggle('on', !follow && String(s.uiHue) === d.dataset.hue));
  v.querySelector('#rvsGalaxy')?.classList.toggle('on', s.splash === 'mr-galaxy');
  v.querySelector('#rvsKaraoke')?.classList.toggle('on', document.body.classList.contains('rv-karaoke-on'));
  v.querySelectorAll('#rvsPresets .rvs-preset').forEach((p) =>
    p.classList.toggle('on', s.bgPreset === p.dataset.key && !s.bg));
}

/* 我的页：设置入口卡（打开手机专属设置页 rvSettings） */
function buildSettingsCard() {
  if ($('#rvMineSet')) return;
  const sec = $('#myPlSec');
  if (!sec) return;
  const card = document.createElement('button');
  card.id = 'rvMineSet';
  card.innerHTML = `<span class="rva-ic">⚙️</span>
    <span class="rva-meta"><b>设置</b><i>主题 · 启动页 · 背景与歌词</i></span>
    <span class="rva-go">›</span>`;
  card.addEventListener('click', openRvSettings);
  const acc = $('#rvAccount');
  if (acc) acc.after(card); else sec.prepend(card);
}

/* 首页顶部招呼区（bridge 自注入 #rvHeroTop，不依赖桌面 .home-hero——
   桌面 hero 依赖 body.home-active 链路，在手机端部分时序下会被隐藏）：
   时段问候 + 发光时钟 + 快捷 chips，随首页 Tab 显隐 */
let rvHeroTimer = null;
function heroGreetText() {
  const h = new Date().getHours();
  if (h < 5) return '夜深了';
  if (h < 9) return '早上好';
  if (h < 12) return '上午好';
  if (h < 14) return '中午好';
  if (h < 18) return '下午好';
  return '晚上好';
}
function heroRefresh() {
  const g = $('#rvGreet');
  if (g) g.textContent = heroGreetText();
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dt = $('#rvDate'), tm = $('#rvTime');
  if (dt) dt.textContent = `${d.getMonth() + 1}月${d.getDate()}日 · 周${'日一二三四五六'[d.getDay()]}`;
  if (tm) tm.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function buildHeroTop() {
  if ($('#rvHeroTop')) return;
  const home = $('#home');
  if (!home) return;
  const top = document.createElement('div');
  top.id = 'rvHeroTop';
  top.innerHTML = `
    <div class="rvh-kicker">RHYTHMVIZ · 私人视觉电台</div>
    <div class="rvh-greet" id="rvGreet">晚上好</div>
    <div class="rvh-clock"><div id="rvTime">--:--</div><div id="rvDate">—</div></div>`;
  home.prepend(top);
  heroRefresh();
  if (!rvHeroTimer) rvHeroTimer = setInterval(heroRefresh, 10000);
}

/* 首页快捷入口 chips（跟在招呼区下方）：
   随机播放/最近播放/热歌榜 = 直接触发桌面端已绑定的轨道卡片点击（同链路播放）；
   我的收藏 = 本地 favSongs 歌单直接进移动端歌单列表 */
function buildHeroChips() {
  if ($('#rvHeroChips')) return;
  const anchor = $('#rvHeroTop');
  if (!anchor) return;
  const bar = document.createElement('div');
  bar.id = 'rvHeroChips';
  bar.innerHTML = `
    <button data-act="rand"><b>⚡</b><span>随机播放</span></button>
    <button data-act="recent"><b>🕘</b><span>最近播放</span></button>
    <button data-act="fav"><b>♥</b><span>我的收藏</span></button>
    <button data-act="hot"><b>🔥</b><span>热歌榜</span></button>`;
  bar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'rand') {
      const cards = $$('#hotRail .rail-item, #recSongsRail .rail-item');
      const pick = cards[Math.floor(Math.random() * cards.length)];
      if (pick) pick.click(); else rvToast('推荐内容还没加载好，稍后再试');
    } else if (act === 'recent') {
      const first = $('#homeRecent .rail-item');
      if (first) first.click(); else rvToast('还没有播放记录');
    } else if (act === 'fav') {
      const pl = localPlaylistByName('我喜欢的音乐');
      if (!pl || !pl.tracks?.length) { rvToast('还没有收藏的歌曲'); return; }
      openPlView({ name: '我喜欢的音乐', cover: '', tracks: pl.tracks });
    } else if (act === 'hot') {
      const first = $('#hotRail .rail-item');
      if (first) first.click(); else rvToast('热歌榜还没加载好');
    }
  });
  anchor.after(bar);
}

/* ============================================================
   二、歌单详情（普通竖向列表，替代桌面端歌单拼图）
   ============================================================ */
let plDetailTracks = [];

function buildPlView() {
  if ($('#rvPlView')) return;
  const v = document.createElement('section');
  v.id = 'rvPlView';
  v.innerHTML = `
    <div class="rvp-head">
      <button class="rvp-back" title="返回">‹</button>
      <img class="rvp-cover" alt="" referrerpolicy="no-referrer" />
      <div class="rvp-meta"><b class="rvp-name">歌单</b><i class="rvp-count"></i></div>
      <button class="rvp-fav" title="收藏">♡</button>
    </div>
    <button class="rvp-playall">▶ 播放全部</button>
    <div class="rvp-list"></div>`;
  document.body.appendChild(v);
  v.querySelector('.rvp-back').addEventListener('click', closePlView);
  v.querySelector('.rvp-fav').addEventListener('click', () => $('#btnPfFav')?.click());
  v.querySelector('.rvp-playall').addEventListener('click', () => playFrom(0));
}
function openPlView(meta) {
  buildPlView();
  const v = $('#rvPlView');
  v.classList.add('on');
  v.querySelector('.rvp-cover').src = meta.cover || '';
  v.querySelector('.rvp-name').textContent = meta.name || '歌单';
  v.querySelector('.rvp-count').textContent = '加载中…';
  v.querySelector('.rvp-list').innerHTML = '<div class="rvp-empty">加载中…</div>';
  plDetailTracks = [];
  renderPlTracks(meta.tracks || []);
}
function renderPlTracks(tracks) {
  plDetailTracks = tracks || [];
  const list = $('#rvPlView .rvp-list');
  const cnt = $('#rvPlView .rvp-count');
  cnt.textContent = tracks.length ? `共 ${tracks.length} 首` : '';
  if (!tracks.length) {
    list.innerHTML = '<div class="rvp-empty">歌单为空或加载失败</div>';
    return;
  }
  list.innerHTML = '';
  tracks.forEach((s, i) => {
    const row = document.createElement('button');
    row.className = 'rvp-row';
    const cover = s.coverUrl
      ? `<img class="rvp-cov" src="${s.coverUrl}" alt="" referrerpolicy="no-referrer" loading="lazy">`
      : '<span class="rvp-cov rvp-cov-empty">♪</span>';
    row.innerHTML = `${cover}
      <span class="rvp-txt"><b>${s.name || '未知歌曲'}</b><i>${s.artist || ''}</i></span>`;
    row.addEventListener('click', () => playFrom(i));
    list.appendChild(row);
  });
}
function playFrom(i) {
  const app = window.__app;
  if (!app || !plDetailTracks.length) { rvToast('歌单还没加载好'); return; }
  // 手机端「点歌单里的歌」= 用该歌单替换当前队列（网易云行为），杜绝队列累加错位
  app.engine.clear();
  app.playOnlineAll(plDetailTracks, i);
  // 进入播放页（网易云点歌即进唱片页），同时收起歌单列表避免遮挡
  closePlView();
  app.toggleNp?.(true);
}
function closePlView() {
  $('#rvPlView')?.classList.remove('on');
  if (!document.body.classList.contains('np-open')) document.body.classList.add('home-active');
}

/* 拦截「歌单拼图」打开：转为移动歌单列表。
   主通道：ui.js openPlaylistDetail 里的 window.__rvOpenPl(pl) 钩子（直接拿到歌单对象，含 id/tracks）。
   兜底：#plFolia class 观察器（任何其他打开路径也能把拼图页压回去）。 */
let rvPlHandledAt = 0;

function suppressFolia() {
  const folia = $('#plFolia');
  folia?.classList.add('hidden');
  document.body.classList.remove('pf-open', 'pl-full');
  $$('.pf-portal').forEach((n) => n.remove());
}

window.__rvOpenPl = (pl) => {
  if (!pl) return;
  rvPlHandledAt = Date.now();
  suppressFolia();
  if (pl.id === '__local__') { $('#btnList')?.click(); return; }
  const meta = { name: pl.name || '歌单', cover: pl.coverUrl || pl.cover || '' };
  // 本地歌单（我喜欢 / 自建）：曲目随对象传入，直接渲染
  if (Array.isArray(pl.tracks)) {
    openPlView(meta);
    renderPlTracks(pl.tracks.map(songShape));
    return;
  }
  // 云端歌单/专辑：自己请求详情，不再依赖 pendingCloud 时序
  openPlView(meta);
  window.api.sourcePlaylistDetail(pl.id)
    .then((det) => {
      if (det?.name) $('#rvPlView .rvp-name').textContent = det.name;
      renderPlTracks((det?.tracks || []).map(songShape));
    })
    .catch(() => renderPlTracks([]));
};

whenDom(() => {
  const folia = $('#plFolia');
  if (!folia || folia._rvHooked) return;
  folia._rvHooked = true;
  // 注意：hidden 是 class 切换，必须监听 class 属性（监听 hidden 属性永远不会触发）
  new MutationObserver(() => {
    if (folia.classList.contains('hidden')) return;
    suppressFolia();
    // __rvOpenPl 刚处理过（同一次点击）→ 不重复打开
    if (Date.now() - rvPlHandledAt < 600) return;
    openPlView({ name: $('#pfName')?.textContent || '歌单', cover: '' });
  }).observe(folia, { attributes: true, attributeFilter: ['class'] });
});

/* 防死页兜底：任何路径让 home-active 掉了且没有任何浮层开着 → 自动回首页，
   手机上永远不给圆环频谱变成「出不去的页面」的机会 */
whenDom(() => {
  const anyOverlay = () =>
    document.body.classList.contains('np-open') ||
    document.body.classList.contains('pf-open') ||
    document.body.classList.contains('full-lyric') ||
    document.body.classList.contains('focus-mode') ||
    $('#rvPlView')?.classList.contains('on') ||
    $('#loginPop')?.classList.contains('open') ||
    $('#drawer')?.classList.contains('open') ||
    $('#fxPanel')?.classList.contains('open') ||
    $('#lyricPop')?.classList.contains('open');
  new MutationObserver(() => {
    if (!anyOverlay() && !document.body.classList.contains('home-active')) {
      document.body.classList.add('home-active');
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

/* ============================================================
   三、系统返回键：逐级返回，根页再按一次退出
   ============================================================ */
let exitArmed = false;
function back() {
  const body = document.body;
  const activeInput = document.activeElement;
  if (activeInput && (activeInput.tagName === 'INPUT' || activeInput.tagName === 'TEXTAREA')) {
    activeInput.blur();
    return;
  }
  if ($('#rvSettings')?.classList.contains('rvs-open')) { closeRvSettings(); return; }
  if ($('#rvPlView')?.classList.contains('on')) { closePlView(); return; }
  if (!$('#songMenu')?.classList.contains('hidden')) { $('#songMenu').classList.add('hidden'); return; }
  if ($('#loginPop')?.classList.contains('open')) { $('#loginPopClose')?.click(); return; }
  if ($('#lyricPop')?.classList.contains('open')) { $('#lyricPopClose')?.click(); return; }
  if ($('#fxPanel')?.classList.contains('open')) { $('#btnFxClose')?.click(); return; }
  if ($('#drawer')?.classList.contains('open')) { $('#btnCloseDrawer')?.click(); return; }
  if (!$('#hsDrop')?.classList.contains('hidden')) { $('#hsDrop')?.classList.add('hidden'); return; }
  if (body.classList.contains('full-lyric')) { window.__app?.toggleFullLyric(false); return; }
  if (body.classList.contains('focus-mode')) { window.__app?.toggleFocus(); return; }
  if (!$('#plFolia')?.classList.contains('hidden')) { $('#btnPfBack')?.click(); return; }
  if (!$('#homeSearchSec')?.classList.contains('hidden')) { $('#homeSearchClear')?.click(); return; }
  if (curTab !== 'home') { switchTab('home'); return; }
  if ($('#np')?.classList.contains('open')) { $('#btnNpBack')?.click(); return; }
  if (!body.classList.contains('home-active')) { $('#btnStageBack')?.click(); return; }

  if (exitArmed) { App.exitApp(); return; }
  exitArmed = true;
  rvToast('再按一次退出律动');
  setTimeout(() => { exitArmed = false; }, 2000);
}

/* 播放态：无歌曲时隐藏底部迷你条；移动端歌词关闭鼓点弹跳（高亮与平滑滚动保留） */
function wirePlaybackState() {
  const app = window.__app;
  if (!app?.engine) { setTimeout(wirePlaybackState, 300); return; }
  const sync = () => document.body.classList.toggle('rv-has-track', !!app.engine.current);
  app.engine.addEventListener('track', sync);
  app.engine.addEventListener('queue', sync);
  sync();
  if (app.lyrics) app.lyrics.bounce = false;
}
whenDom(wirePlaybackState);

/* 播放页视图切换（网易云式）：黑胶唱片 ⇄ 歌词
   点唱片 → 进歌词视图；歌词视图里点播放页任意非按钮区 → 回唱片。
   .lyrics 在 app.css 中 pointer-events:none（桌面设计），点击事件落到 #np 系容器，
   因此切回监听放在 #np 根上（比绑 .np-right 覆盖面大，歌词行/空白处都能切回） */
whenDom(() => {
  const npOpen = () => document.body.classList.contains('np-open');
  const inLyrics = () => document.body.classList.contains('rv-np-lyrics');
  document.querySelector('#np .np-cover-wrap')?.addEventListener('click', (e) => {
    if (!npOpen() || inLyrics()) return;
    e.stopPropagation();
    document.body.classList.add('rv-np-lyrics');
  });
  document.getElementById('np')?.addEventListener('click', (e) => {
    if (!npOpen() || !inLyrics()) return;
    // 按钮/返回键/操作区不触发切回（它们有自己的职责）
    if (e.target.closest('button, .np-back, .np-acts, input, a, .hs-drop')) return;
    document.body.classList.remove('rv-np-lyrics');
  });
  // 播放页关闭时复位。守卫不可省：部分 Android WebView 中，在 class 变更回调里
  // 对 classList 执行 remove（即使目标类不存在）也会再次投递一条属性变更记录，
  // 无守卫时会形成无限微任务回调风暴（CPU 100%、卡死启动页直至 OOM）。
  new MutationObserver(() => {
    if (!document.body.classList.contains('np-open') && document.body.classList.contains('rv-np-lyrics')) {
      document.body.classList.remove('rv-np-lyrics');
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

whenDom(() => {
  buildTabbar();
  buildHeroTop();
  buildAccountCard();
  buildSettingsCard();
  buildHeroChips();
  buildPlView();
  injectPwdLogin();
  bindMediaNotification();
  bindNpCoverPalette();
  /* 播放时间移入进度行（np-open dock 的「时间 · 进度 · 时间」排布；
     迷你条时由 CSS 隐藏时间，不留空位） */
  const pb = document.getElementById('progressBar');
  if (pb && !pb.querySelector('.time')) {
    const ct = document.getElementById('curTime');
    const dtt = document.getElementById('durTime');
    if (ct) pb.prepend(ct);
    if (dtt) pb.appendChild(dtt);
  }
  /* 歌词扫光设置恢复（默认关） */
  try {
    const on = ((JSON.parse(localStorage.getItem('rv-settings') || '{}') || {}).rvKaraoke);
    document.body.classList.toggle('rv-karaoke-on', !!on);
  } catch { /* noop */ }
  if (isNative) {
    App.addListener('backButton', () => {
      try { back(); } catch (e) { console.error('[rv] back error', e); }
    });
  } else {
    // 浏览器调试：Esc 模拟返回键
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') back();
    });
  }
});

/* 登录成功后刷新「我的」账号卡 */
_qrSuccessCbs.add(() => setTimeout(refreshAccountCard, 200));

/* ============================================================
   三之二、通知栏 / 锁屏媒体控制器联动
   engine 'track' → start+update(含封面)；'state' → update 播放态
   原生 'action' 事件 → engine.playPause/next/prev
   ============================================================ */
/* 通知栏「喜欢」状态判断（与 ui.js trackToSong/isFavSong 同语义：仅在线曲目可收藏） */
function favOf(t) {
  if (!t || t.source !== 'online' || !t.songId) return false;
  const id = t.songId, srcId = t.srcId || 'netease';
  let list = [];
  try { list = JSON.parse(localStorage.getItem('rv-settings') || '{}')?.favSongs || []; }
  catch { /* noop */ }
  return list.some((x) => x.id === id && x.srcId === srcId);
}

function bindMediaNotification() {
  if (!isNative) return;
  const tryBind = () => {
    const eng = window.__app?.engine;
    if (!eng) { setTimeout(tryBind, 400); return; }

    let started = false;
    let artUrlUsed = '';
    let artRetry = 0;

    /* 封面 → 缩放到 480px 的 JPEG base64（blob: 同源直绘；http 走原生无 CORS 抓取） */
    const shrinkArt = async (t) => {
      let url = t.coverBlob || '';
      if (!url && t.coverUrl && /^https?:/.test(t.coverUrl)) {
        try {
          const bin = await window.api.sourceBinary(t.coverUrl, {});
          if (bin?.data && bin.data.byteLength) {
            const blob = new Blob([bin.data], { type: bin.contentType || 'image/jpeg' });
            url = URL.createObjectURL(blob);
          }
        } catch { /* 无封面也能播 */ }
      }
      if (!url) return { b64: null, url: '' };
      try {
        const img = new Image();
        await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
        const max = 640;
        const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.max(1, Math.round(img.naturalWidth * k));
        c.height = Math.max(1, Math.round(img.naturalHeight * k));
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        const b64 = await new Promise((res) => {
          c.toBlob((b) => {
            if (!b) return res(null);
            const r = new FileReader();
            r.onload = () => res(String(r.result).split(',')[1]);
            r.onerror = () => res(null);
            r.readAsDataURL(b);
          }, 'image/jpeg', 0.82);
        });
        return { b64, url: t.coverBlob || t.coverUrl || '' };
      } catch { return { b64: null, url: '' }; }
    };

    const sync = async (withArt) => {
      const t = eng.current;
      if (!t) {
        if (started) { try { await MediaNotif.stop(); } catch { /* noop */ } started = false; artUrlUsed = ''; artRetry = 0; }
        return;
      }
      const payload = {
        title: String(t.title || '未知曲目').slice(0, 120),
        artist: String(t.artist || '律动 RhythmViz').slice(0, 120),
        album: String(t.album || '').slice(0, 120),
        playing: !!eng.playing,
        fav: favOf(t),
        position: Math.floor(Math.max(0, eng.time || 0) * 1000),
        duration: Math.floor(Math.max(0, eng.duration || 0) * 1000)
      };
      if (withArt) {
        const { b64, url } = await shrinkArt(t);
        if (b64) { payload.artB64 = b64; artUrlUsed = url; }
      }
      try {
        if (!started) { await MediaNotif.start(); started = true; }
        await MediaNotif.update(payload);
      } catch (e) { console.warn('[rv] 媒体通知同步失败', e); }
    };

    eng.addEventListener('track', () => {
      artRetry = 0;
      // 封面 blob 可能稍后才就绪：先立即同步一次，2.5s 内还没封面就补一次
      sync(true);
      setTimeout(() => {
        const t2 = eng.current;
        if (t2 && artRetry < 1) {
          artRetry++;
          const want = t2.coverBlob || t2.coverUrl || '';
          if (want && want !== artUrlUsed) sync(true);
        }
      }, 2500);
    });
    eng.addEventListener('state', () => { sync(false); });

    MediaNotif.addListener('action', ({ action }) => {
      try {
        if (action === 'play' || action === 'pause') eng.playPause();
        else if (action === 'next') eng.next();
        else if (action === 'prev') eng.prev();
        else if (action === 'fav') {
          // 复用播放页喜欢按钮：ui.js toggleFavSong(engine.current) + 状态回刷
          $('#npFav')?.click();
          setTimeout(() => { sync(false); }, 120);
        }
      } catch (e) { console.warn('[rv] 通知动作执行失败', action, e); }
    });
  };
  tryBind();
}

/* ============================================================
   三之三、播放页背景随封面取色（写入 body 变量 --npA-rgb / --npB-rgb，
   mobile.css 的 np-open #np 双色氛围渐变读取这两个变量）
   16×16 canvas 采样 → 桶加权选主色 A；次色 B 取与 A 色相差 ≥26° 的
   次强桶，无则由 A 旋转 32° 派生。blob 同源直绘；http 封面走原生
   sourceBinary 转 blob 防 canvas 污染（跨域无 CORS 头时 getImageData
   抛错 → 静默保留上一首颜色，不影响播放）
   ============================================================ */
function rgbToHsl(r, g, b) {
  const rr = r / 255, gg = g / 255, bb = b / 255;
  const mx = Math.max(rr, gg, bb), mn = Math.min(rr, gg, bb);
  let h = 0, s = 0;
  const l = (mx + mn) / 2;
  if (mx !== mn) {
    const d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    if (mx === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
    else if (mx === gg) h = (bb - rr) / d + 2;
    else h = (rr - gg) / d + 4;
    h *= 60;
  }
  return [h, s, l];
}
function hslToRgb(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}
function pickCoverColors(data) {
  const buckets = new Map();
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const lum = (mx + mn) / 510;
    if (lum < 0.06 || lum > 0.96) continue; // 纯黑/纯白像素不参与
    const sat = mx ? (mx - mn) / mx : 0;
    const key = (r >> 4) + ',' + (g >> 4) + ',' + (b >> 4);
    const bk = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0, w: 0 };
    bk.n++; bk.r += r; bk.g += g; bk.b += b;
    // 权重：出现次数为主，饱和度与中间亮度加成（避免被背景大面积灰黑带走）
    bk.w += 1 + sat * 2.6 + (lum > 0.14 && lum < 0.92 ? 0.8 : 0);
    buckets.set(key, bk);
  }
  if (!buckets.size) return null;
  const list = [...buckets.values()].sort((a, b) => b.w - a.w);
  const avg = (bk) => [Math.round(bk.r / bk.n), Math.round(bk.g / bk.n), Math.round(bk.b / bk.n)];
  const A = avg(list[0]);
  const [hA] = rgbToHsl(A[0], A[1], A[2]);
  let B = null;
  for (let i = 1; i < list.length && !B; i++) {
    const c = avg(list[i]);
    const [hc] = rgbToHsl(c[0], c[1], c[2]);
    let dh = Math.abs(hc - hA);
    if (dh > 180) dh = 360 - dh;
    if (dh >= 26) B = c;
  }
  if (!B) {
    const [h, s, l] = rgbToHsl(A[0], A[1], A[2]);
    B = hslToRgb(h + 32, Math.min(1, s * 1.05), Math.max(0.18, Math.min(0.8, l * 0.72 + 0.1)));
  }
  return { A, B };
}
function bindNpCoverPalette() {
  const eng = window.__app?.engine;
  if (!eng) { setTimeout(bindNpCoverPalette, 400); return; }
  let sampledKey = '';
  const apply = async () => {
    const t = eng.current;
    if (!t) return;
    const key = t.coverBlob || t.coverUrl || '';
    if (!key || key === sampledKey) return;
    let url = t.coverBlob || '';
    let tmp = null;
    try {
      if (!url && /^https?:/.test(t.coverUrl || '')) {
        const bin = await window.api.sourceBinary(t.coverUrl, {});
        if (bin?.data && bin.data.byteLength) {
          url = tmp = URL.createObjectURL(new Blob([bin.data], { type: bin.contentType || 'image/jpeg' }));
        }
      }
      if (!url) return;
      const img = new Image();
      await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
      const c = document.createElement('canvas');
      c.width = 16; c.height = 16;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0, 16, 16);
      const picked = pickCoverColors(x.getImageData(0, 0, 16, 16).data);
      if (picked) {
        document.body.style.setProperty('--npA-rgb', picked.A.join(','));
        document.body.style.setProperty('--npB-rgb', picked.B.join(','));
        sampledKey = key; // 仅成功采样后记账：失败时下轮事件/重试仍可补采
      }
    } catch { /* canvas 污染或加载失败：保留上一首颜色 */ }
    finally { if (tmp) URL.revokeObjectURL(tmp); }
  };
  eng.addEventListener('track', () => {
    apply();
    setTimeout(apply, 2600); // coverBlob 可能晚于 track 事件就绪：延迟补采一次
  });
}

/* ============================================================
   四、账号密码登录（扫码之外的第二种登录方式）
   - 网易云：手机号/邮箱 + 密码（weapi 加密直登，qrlogin.js pwdLoginNetease）
   - QQ音乐：App 内 WebView 打开官方登录页（页面自带密码/扫码登录，不唤起手机 QQ）
   ============================================================ */
function injectPwdLogin() {
  const platView = $('#loginPlatView');
  const fxBody = platView?.parentElement;
  if (!platView || !fxBody || platView.dataset.rvPwd) return;
  platView.dataset.rvPwd = '1';
  const qrView = $('#loginQrView');

  /* 入口块：两个密码登录按钮。挂在 #loginPlatView 内、平台列表之后——
     ui.js renderLoginList 只重渲 #loginPlatList，本块存活不受影响 */
  const block = document.createElement('div');
  block.className = 'rv-pwd-block';
  block.innerHTML =
    '<div class="rv-pwd-label">PASSWORD · 账号密码登录</div>' +
    '<div class="rv-pwd-row">' +
    '<button type="button" class="rv-pwd-btn" data-p="netease"><span class="rv-pwd-ic">🎵</span>' +
    '<span class="rv-pwd-tx"><b>网易云</b><i>手机号 / 邮箱 + 密码</i></span></button>' +
    '<button type="button" class="rv-pwd-btn" data-p="qq"><span class="rv-pwd-ic">🐧</span>' +
    '<span class="rv-pwd-tx"><b>QQ音乐</b><i>官方登录页 · 密码登录</i></span></button>' +
    '</div>';
  platView.appendChild(block);

  /* 网易密码表单视图：与平台/扫码视图同级，同窗内切换 */
  const pwdView = document.createElement('div');
  pwdView.id = 'rvPwdView';
  pwdView.className = 'hidden';
  pwdView.innerHTML =
    '<div class="rv-pwd-form">' +
    '<input id="rvPwdAcc" class="rv-pwd-in" type="text" placeholder="手机号 / 邮箱" autocomplete="username">' +
    '<input id="rvPwdPass" class="rv-pwd-in" type="password" placeholder="密码" autocomplete="current-password">' +
    '<div id="rvPwdStatus" class="rv-pwd-status"></div>' +
    '<button id="rvPwdGo" type="button" class="rv-pwd-go">登 录</button>' +
    '<button id="rvPwdBack" type="button" class="rv-pwd-back">返回选择登录方式</button>' +
    '</div>';
  fxBody.appendChild(pwdView);

  const hidePwdView = () => pwdView.classList.add('hidden');
  const backToPlat = () => {
    hidePwdView();
    platView.classList.remove('hidden');
    $('#loginQrBack')?.classList.add('hidden');
    const t = $('#loginPopTitle');
    if (t) t.textContent = '账号登录';
  };
  /* ui.js 把平台/扫码视图切回可见时（含关窗复位），同步收起密码视图 */
  const syncPwd = () => {
    if (pwdView.classList.contains('hidden')) return;
    if (!platView.classList.contains('hidden') || !qrView?.classList.contains('hidden')) hidePwdView();
  };
  new MutationObserver(syncPwd).observe(platView, { attributes: true, attributeFilter: ['class'] });
  if (qrView) new MutationObserver(syncPwd).observe(qrView, { attributes: true, attributeFilter: ['class'] });

  const statusEl = pwdView.querySelector('#rvPwdStatus');
  const setStatus = (msg, warn) => {
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('warn', !!warn);
  };

  /* ---- 网易云：密码表单直登 ---- */
  const startNeteasePwd = () => {
    platView.classList.add('hidden');
    qrView?.classList.add('hidden');
    pwdView.classList.remove('hidden');
    $('#loginQrBack')?.classList.add('hidden');
    const t = $('#loginPopTitle');
    if (t) t.textContent = '网易云账号登录';
    setStatus('', false);
    setTimeout(() => pwdView.querySelector('#rvPwdAcc')?.focus(), 150);
  };
  const submitNeteasePwd = async () => {
    const acc = pwdView.querySelector('#rvPwdAcc')?.value || '';
    const pwd = pwdView.querySelector('#rvPwdPass')?.value || '';
    const go = pwdView.querySelector('#rvPwdGo');
    if (!acc.trim()) { setStatus('请输入手机号或邮箱', true); return; }
    if (!pwd) { setStatus('请输入密码', true); return; }
    go.disabled = true;
    setStatus('正在登录…', false);
    try {
      const { qr } = await _ready;
      await qr.pwdLoginNetease(acc, pwd);
      // 成功事件由 ui.js 统一收尾（toast + 拉云歌单 + 刷首页）；此处关窗复位
      $('#loginPopClose')?.click();
      backToPlat();
    } catch (e) {
      setStatus(e?.message || '登录失败', true);
    } finally {
      go.disabled = false;
    }
  };

  /* ---- QQ音乐：官方登录页 WebView（页面内完成密码登录） ---- */
  const startQqPwd = async () => {
    if (!isNative) { rvToast('请在安卓 App 内使用 QQ 密码登录'); return; }
    const qrBox = $('.login-qr-box');
    const refreshBtn = $('#loginQrRefresh');
    const st = $('#loginQrStatus');
    $('#loginPopTitle').textContent = 'QQ音乐账号登录';
    $('#loginQrName').textContent = 'QQ音乐';
    if (qrBox) qrBox.style.display = 'none';
    refreshBtn?.classList.add('hidden');
    platView.classList.add('hidden');
    qrView?.classList.remove('hidden');
    if (st) st.textContent = '正在打开 QQ 官方登录页…';
    try {
      const { qr } = await _ready;
      const res = await QqLogin.open();
      if (st) st.textContent = '登录成功，正在同步…';
      await qr.finishQqFromCookies(res?.cookies || []);
      $('#loginPopClose')?.click();
    } catch (e) {
      rvToast(e?.message === 'cancelled' ? '已取消' : ('QQ 登录失败：' + (e?.message || '未知错误')));
    } finally {
      if (qrBox) qrBox.style.display = '';
      if (!$('#loginPop')?.classList.contains('open')) {
        platView.classList.remove('hidden');
        qrView?.classList.add('hidden');
        $('#loginPopTitle').textContent = '账号登录';
      }
    }
  };

  block.querySelector('[data-p="netease"]').addEventListener('click', startNeteasePwd);
  block.querySelector('[data-p="qq"]').addEventListener('click', startQqPwd);
  pwdView.querySelector('#rvPwdGo').addEventListener('click', submitNeteasePwd);
  pwdView.querySelector('#rvPwdBack').addEventListener('click', backToPlat);
  pwdView.querySelector('#rvPwdPass').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitNeteasePwd();
  });
}

console.log('[rv] 移动端垫片已安装，平台:', window.Capacitor?.getPlatform?.() || 'web');

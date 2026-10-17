/* RhythmViz 移动端 window.api 垫片：对齐桌面 preload.cjs 全部接口，
   音源走移动宿主（原生 RhythmNet），设置/Cookie 走 localStorage。 */
import { installGlobals } from './buffer-poly.js';
import { MobileSourceManager } from './host/manager.js';
import { QrLoginManager } from './host/qrlogin.js';

installGlobals();

/* ---------------- 方向 / 平台标记 ---------------- */
document.documentElement.classList.add('rv-mobile', 'rv-android');
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
  /* 本地文件（移动端不支持，静默返回空，UI 入口在 mobile.css 中隐藏） */
  getPathForFile: () => null,
  openAudioDialog: () => Promise.resolve([]),
  openAudioFolder: () => Promise.resolve([]),
  pickBackground: () => Promise.resolve(null),
  pickBackgroundVideo: () => Promise.resolve(null),
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

  /* 扫码登录 */
  qrLoginStart: (platform) => _ready.then(({ qr }) => qr.start(platform)),
  qrLoginCancel: (platform) => { _qr?.cancel(platform); return Promise.resolve(true); },
  onLoginQrUpdate: (cb) => { _qrUpdateCbs.add(cb); },
  onLoginSuccess: (cb) => { _qrSuccessCbs.add(cb); },
  sourceLogout: (srcId) => _ready.then(({ mgr }) => mgr.logout(srcId)),
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
   4. QQ 音乐快捷登录（App 内 WebView 唤起本机 QQ，一键授权）
   ============================================================ */
import { App } from '@capacitor/app';
import { registerPlugin } from '@capacitor/core';

const QqLogin = registerPlugin('QqLogin');
const MediaNotif = registerPlugin('MediaNotif');
const isNative = !!window.Capacitor?.isNativePlatform?.();

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

/* 播放页沉浸模式：点唱片切换底部控制条显隐（网易云式）；退出播放页自动复位 */
whenDom(() => {
  const vinyl = document.querySelector('#np .np-cover-wrap');
  vinyl?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!document.body.classList.contains('np-open')) return;
    document.body.classList.toggle('rv-np-chrome-off');
  });
  document.body.addEventListener('click', (e) => {
    // 控制条隐藏时，点歌词/页面空白处也能呼出
    if (!document.body.classList.contains('rv-np-chrome-off')) return;
    if (e.target.closest('#bottombar') || e.target.closest('.np-cover-wrap') || e.target.closest('.np-back')) return;
    if (e.target.closest('#np')) document.body.classList.remove('rv-np-chrome-off');
  });
  // 播放页关闭时复位
  new MutationObserver(() => {
    if (!document.body.classList.contains('np-open')) {
      document.body.classList.remove('rv-np-chrome-off');
    }
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
});

whenDom(() => {
  buildTabbar();
  buildAccountCard();
  buildPlView();
  injectQqQuickLogin();
  bindMediaNotification();
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
        const max = 480;
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
        playing: !!eng.playing,
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
      } catch (e) { console.warn('[rv] 通知动作执行失败', action, e); }
    });
  };
  tryBind();
}

/* ============================================================
   四、QQ 音乐快捷登录（本机 QQ 一键授权）
   ============================================================ */
function injectQqQuickLogin() {
  const list = $('#loginPlatList');
  if (!list || list.dataset.rvQq) return;
  list.dataset.rvQq = '1';
  const btn = document.createElement('button');
  btn.className = 'rv-qq-quick';
  btn.innerHTML = '<span class="rv-qq-ic">🐧</span><span class="rv-qq-tx"><b>QQ 一键登录</b><i>本机 QQ 授权 · 无需扫码</i></span>';
  btn.addEventListener('click', startQqQuick);
  list.parentElement.insertBefore(btn, list);
}

async function startQqQuick() {
  if (!isNative) { rvToast('请在安卓 App 内使用 QQ 一键登录'); return; }
  const platView = $('#loginPlatView');
  const qrView = $('#loginQrView');
  const status = $('#loginQrStatus');
  const qrBox = $('.login-qr-box');
  const refreshBtn = $('#loginQrRefresh');
  $('#loginPopTitle').textContent = 'QQ音乐快捷登录';
  $('#loginQrName').textContent = 'QQ音乐';
  if (qrBox) qrBox.style.display = 'none';
  refreshBtn?.classList.add('hidden');
  platView?.classList.add('hidden');
  qrView?.classList.remove('hidden');
  if (status) status.textContent = '正在打开手机 QQ 授权页…';

  try {
    const { qr } = await _ready;
    const res = await QqLogin.open();
    if (status) status.textContent = '授权成功，正在登录…';
    await qr.finishQqFromCookies(res?.cookies || []);
    // 成功事件会关闭登录弹层；复位视图状态
    $('#loginPopClose')?.click();
  } catch (e) {
    rvToast(e?.message === 'cancelled' ? '已取消，可改用扫码登录' : ('快捷登录失败：' + (e?.message || '未知错误')));
  } finally {
    if (qrBox) qrBox.style.display = '';
    if (!$('#loginPop')?.classList.contains('open')) {
      platView?.classList.remove('hidden');
      qrView?.classList.add('hidden');
      $('#loginPopTitle').textContent = '账号登录';
    }
  }
}

console.log('[rv] 移动端垫片已安装，平台:', window.Capacitor?.getPlatform?.() || 'web');

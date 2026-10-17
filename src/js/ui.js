/* ============ UI 交互：标题栏 / 首页 / 视觉控制台 / 底栏 / 抽屉 ============ */
import { fmtTime, clamp, makeTrack } from './audio.js';
import { LYRIC_PRESETS } from './lyrics.js';
import { ThemeEngine } from './theme.js';
import { FoliaSphere } from './folia-sphere.js';

const $ = (s) => document.querySelector(s);

/* 封面兜底：缺失 / 防盗链失败时显示 Folia 风格深色渐变占位（不再留白） */
const COVER_FALLBACK = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='480' height='480'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%230f1b1d'/%3E%3Cstop offset='0.55' stop-color='%230b1016'/%3E%3Cstop offset='1' stop-color='%230a0d12'/%3E%3C/linearGradient%3E%3CradialGradient id='h' cx='0.32' cy='0.28' r='0.8'%3E%3Cstop offset='0' stop-color='%2300f5d4' stop-opacity='0.16'/%3E%3Cstop offset='1' stop-color='%2300f5d4' stop-opacity='0'/%3E%3C/radialGradient%3E%3C/defs%3E%3Crect width='480' height='480' fill='url(%23g)'/%3E%3Crect width='480' height='480' fill='url(%23h)'/%3E%3Ccircle cx='240' cy='240' r='92' fill='none' stroke='%2300f5d4' stroke-opacity='0.32' stroke-width='5'/%3E%3Ctext x='240' y='278' font-size='118' text-anchor='middle' fill='%2300f5d4' fill-opacity='0.72'%3E%E2%99%AA%3C/text%3E%3C/svg%3E";

export function toast(msg, ms = 2400) {
  const box = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 400);
  }, ms);
}

export function setupUI(app) {
  const { engine, scenes } = app;
  app.theme = new ThemeEngine(app); // 封面取色自适应主题
  const els = {
    play: $('#btnPlay'), prev: $('#btnPrev'), next: $('#btnNext'), shuffle: $('#btnShuffle'),
    cur: $('#curTime'), dur: $('#durTime'), progressBar: $('#progressBar'), seekPlayed: $('#seekPlayed'), seekKnob: $('#seekKnob'),
    volume: $('#volume'), btnVolume: $('#btnVolume'),
    tTitle: $('#tTitle'), tArtist: $('#tArtist'), coverThumb: $('#coverThumb'),
    drawer: $('#drawer'), playList: $('#playList'), listEmpty: $('#listEmpty'),
    btnList: $('#btnList'), btnCloseDrawer: $('#btnCloseDrawer'),
    btnImport: $('#btnImport'), btnImportDir: $('#btnImportDir'), btnClearList: $('#btnClearList'),
    btnFxImport: $('#btnFxImport'), btnFxImportDir: $('#btnFxImportDir'),
    btnDemo: $('#btnDemo'),
    btnLyric: $('#btnLyric'), btnFull: $('#btnFull'),
    btnLogin: $('#btnLogin'), loginPop: $('#loginPop'),
    btnFx: $('#btnFx'), btnFxClose: $('#btnFxClose'), fxPanel: $('#fxPanel'),
    btnFxFull: $('#btnFxFull'), btnFxLyric: $('#btnFxLyric'),
    lyrics: $('#lyrics'),
    btnHome: $('#btnHome'),
    homeDate: $('#homeDate'), homeTime: $('#homeTime'), homeStats: $('#homeStats'),
    homeRecentRow: $('#homeRecentRow'),
    btnNp: $('#btnNp'),
    npCover: $('#npCover'), npTitle: $('#npTitle'), npArtist: $('#npArtist'),
    albumBg: $('#albumBg'),
    hotRailRow: $('#hotRailRow'), hotNote: $('#hotNote'),
    recSongsRow: $('#recSongsRow'), recSongsNote: $('#recSongsNote'),
    plGrid: $('#plGrid'), plNote: $('#plNote'),
    tabPlBtn: $('#tabPlBtn'),
    plDetailCover: $('#plDetailCover'), plDetailName: $('#plDetailName'),
    plDetailCount: $('#plDetailCount'), btnPlayAll: $('#btnPlayAll'), plDetailList: $('#plDetailList'),
    btnFavDetail: $('#btnFavDetail'),
    homeSearchInput: $('#homeSearchInput'), homeSearchBtn: $('#homeSearchBtn'),
    homeSearchClear: $('#homeSearchClear'), homeSearchSec: $('#homeSearchSec'),
    homeSearchGrid: $('#homeSearchGrid'), homeSearchNote: $('#homeSearchNote'),
    homeSearchBox: $('#homeSearchBox'), hsDrop: $('#hsDrop'),
    hsdHist: $('#hsdHist'), hsdHistSec: $('#hsdHistSec'), hsdHot: $('#hsdHot'),
    homeGreet: $('#homeGreet'),
    myPlGrid: $('#myPlGrid'), myPlEmpty: $('#myPlEmpty'), myPlNote: $('#myPlNote'),
    btnBgPick: $('#btnBgPick'), btnBgClear: $('#btnBgClear'), btnBgVideo: $('#btnBgVideo'),
    fxGlow: $('#fxGlow'), fxStroke: $('#fxStroke'), fxShadow: $('#fxShadow'),
    fxGlowV: $('#fxGlowV'), fxStrokeV: $('#fxStrokeV'), fxShadowV: $('#fxShadowV'),
    fxBgBlur: $('#fxBgBlur'), fxBgBright: $('#fxBgBright'), fxGlass: $('#fxGlass'),
    fxBgBlurV: $('#fxBgBlurV'), fxBgBrightV: $('#fxBgBrightV'), fxGlassV: $('#fxGlassV'),
    glBright: $('#glBright'), glBrightV: $('#glBrightV'),
    tglTheme: $('#tglTheme'), tglBounce: $('#tglBounce'), tglAnim: $('#tglAnim'),
    btnFullLyric: $('#btnFullLyric'), btnFocus: $('#btnFocus'), btnMini: $('#btnMini'),
    btnStageBack: $('#btnStageBack'),
    plViewSeg: $('#plViewSeg')
  };

  /* --- 窗口控制 --- */
  $('#btnMin').addEventListener('click', () => window.api.minimizeWindow?.());
  $('#btnMax').addEventListener('click', () => window.api.toggleMaximize?.());
  $('#btnClose').addEventListener('click', () => window.api.closeWindow?.());
  if (window.api.onMaximized) {
    window.api.onMaximized((m) => $('#btnMax').classList.toggle('active', m));
  }

  /* --- 启动页 --- */
  const splash = $('#splash');
  splash.addEventListener('click', () => app.dismissSplash());

  /* --- 首页时钟 + 时段问候 --- */
  const pad = (n) => String(n).padStart(2, '0');
  const tickClock = () => {
    const d = new Date();
    els.homeDate.textContent = `${d.getMonth() + 1}月${d.getDate()}日`;
    els.homeTime.textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const h = d.getHours();
    els.homeGreet.textContent =
      h < 6 ? '夜深了，音乐正当时' :
      h < 11 ? '早上好' :
      h < 14 ? '中午好' :
      h < 18 ? '下午好' : '晚上好';
  };
  tickClock();
  setInterval(tickClock, 5000);

  /* --- 播放控制 --- */
  els.play.addEventListener('click', () => engine.playPause());
  els.prev.addEventListener('click', () => engine.prev());
  els.next.addEventListener('click', () => engine.next());
  /* 播放模式三态循环：顺序循环 → 单曲循环 → 随机播放（单按钮轮转，持久化 playMode） */
  const PLAY_MODES = ['list', 'one', 'shuffle'];
  const MODE_META = {
    list: { icon: '→', tip: '播放模式：顺序循环（点击切换）', msg: '顺序播放（列表循环）' },
    one: { icon: '↺', tip: '播放模式：单曲循环（点击切换）', msg: '单曲循环' },
    shuffle: { icon: '⇄', tip: '播放模式：随机播放（点击切换）', msg: '随机播放' }
  };
  const applyModeBtn = () => {
    const m = engine.playMode || 'list';
    els.shuffle.textContent = MODE_META[m].icon;
    els.shuffle.title = MODE_META[m].tip;
    els.shuffle.classList.toggle('active', m !== 'list');
    els.shuffle.classList.toggle('mode-one', m === 'one');
  };
  applyModeBtn(); // 启动时按 engine.playMode（boot 已从设置恢复）同步按钮
  els.shuffle.addEventListener('click', () => {
    const cur = PLAY_MODES.indexOf(engine.playMode);
    engine.setPlayMode(PLAY_MODES[(cur + 1) % PLAY_MODES.length]);
    applyModeBtn();
    app.saveSettings();
    toast(MODE_META[engine.playMode].msg);
  });
  els.btnDemo.addEventListener('click', async () => {
    if (engine.current?.source === 'demo') { toast('演示曲已在播放'); return; }
    try {
      await engine.playDemo();
      await app.applyDemoTrack();
      toast('演示曲播放中 — 打开「视觉」切换场景');
    } catch (e) { toast('演示曲启动失败：' + e.message); }
  });

  /* --- 首页入口：回主页时关闭播放页，让用户能随时退出歌曲页 --- */
  const goHome = (show) => {
    document.body.classList.toggle('home-active', show);
    if (show) {
      app.toggleNp(false);
      renderHomeRecent(app);
    }
  };
  els.btnHome.addEventListener('click', () => goHome(!document.body.classList.contains('home-active')));

  /* --- 播放页返回按钮：回到主页 --- */
  $('#btnNpBack').addEventListener('click', () => goHome(true));

  /* --- 舞台返回按钮：非主页且非播放页/歌单拼图时显示，点击回主页 --- */
  const syncStageBack = () => {
    const show = !document.body.classList.contains('home-active')
      && !app.npOpen
      && !document.body.classList.contains('pf-open')
      && !document.body.classList.contains('full-lyric')
      && !document.body.classList.contains('focus-mode');
    els.btnStageBack.classList.toggle('hidden', !show);
  };
  els.btnStageBack.addEventListener('click', () => goHome(true));
  new MutationObserver(syncStageBack).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  syncStageBack();

  /* --- 首页直搜：结果直接展示在首页 --- */
  const homeSearchTargets = ['#hotRail', '#homeRecent', '#myPlSec', '.home-pl'];

  /* QQ 音乐式下拉：搜索历史 + 热门搜索 */
  let hotSongsForDrop = []; // loadHotRail 成功后填充
  const pushSearchHistory = (q) => {
    const hist = (app.settings.searchHistory || []).filter(x => x !== q);
    hist.unshift(q);
    app.settings.searchHistory = hist.slice(0, 10);
    window.api.setSetting('searchHistory', app.settings.searchHistory);
  };
  const hideDrop = () => els.hsDrop.classList.add('hidden');
  const renderDrop = () => {
    const hist = app.settings.searchHistory || [];
    els.hsdHistSec.style.display = hist.length ? '' : 'none';
    els.hsdHist.innerHTML = '';
    hist.slice(0, 8).forEach((q) => {
      const t = document.createElement('button');
      t.className = 'hsd-tag';
      t.textContent = q;
      t.addEventListener('click', () => { els.homeSearchInput.value = q; doHomeSearch(); hideDrop(); });
      els.hsdHist.appendChild(t);
    });
    els.hsdHot.innerHTML = '';
    hotSongsForDrop.slice(0, 6).forEach((s, i) => {
      const it = document.createElement('button');
      it.className = 'hsd-item';
      const idx = document.createElement('span');
      idx.className = 'hsd-idx';
      idx.textContent = String(i + 1).padStart(2, '0');
      const nm = document.createElement('span');
      nm.className = 'hsd-name'; // 配合 CSS 单行省略，超长「歌名 - 歌手」不撑破下拉
      nm.textContent = `${s.name} - ${s.artist || ''}`;
      const meta = document.createElement('span');
      meta.className = 'hsd-hot';
      meta.textContent = s.album || '';
      it.append(idx, nm, meta);
      it.addEventListener('click', () => {
        els.homeSearchInput.value = [s.name, s.artist].filter(Boolean).join(' ');
        doHomeSearch();
        hideDrop();
      });
      els.hsdHot.appendChild(it);
    });
  };
  const showDrop = () => {
    if (document.body.classList.contains('home-active')) {
      renderDrop();
      els.hsDrop.classList.remove('hidden');
    }
  };
  els.homeSearchInput.addEventListener('focus', showDrop);
  document.addEventListener('pointerdown', (e) => {
    if (els.homeSearchBox && !els.homeSearchBox.contains(e.target)) hideDrop();
  });

  // placeholder 轮播（QQ 音乐式「大家都在搜」）
  const phWords = ['搜索歌曲 / 歌手，回车播放', '周杰伦 · 晴天', '试试搜「热歌榜第一」', '林俊杰 · 修炼爱情', '经典粤语精选'];
  let phI = 0;
  setInterval(() => {
    if (document.activeElement !== els.homeSearchInput && !els.homeSearchInput.value) {
      phI = (phI + 1) % phWords.length;
      els.homeSearchInput.placeholder = phWords[phI];
    }
  }, 4000);

  /* 搜索结果（歌曲 + 歌手）缓存在闭包里，歌手→专辑→返回 不重复请求 */
  let lastSearch = { q: '', list: [], artists: [] };
  const renderHomeSearch = () => {
    const { q, list, artists } = lastSearch;
    els.homeSearchGrid.innerHTML = '';
    els.homeSearchNote.textContent = `“${q}” · ${list.length} 首${artists.length ? ` · 歌手：${artists[0].name}` : ''}`;
    if (artists.length) {
      const label = document.createElement('div');
      label.className = 'hs-label';
      label.textContent = 'ARTIST · 歌手';
      els.homeSearchGrid.appendChild(label);
      artists.forEach((a) => {
        const item = document.createElement('button');
        item.className = 'hs-item hs-art';
        const img = coverImg(a.coverUrl);
        const txt = document.createElement('div');
        txt.className = 'hs-txt';
        const name = document.createElement('div');
        name.className = 'hs-name';
        name.textContent = a.name;
        const sub = document.createElement('div');
        sub.className = 'hs-artist';
        sub.textContent = a.alias ? `别名：${a.alias}` : '点击查看原唱歌曲';
        txt.append(name, sub);
        const go = document.createElement('span');
        go.className = 'hs-play';
        go.textContent = '›';
        item.append(img, txt, go);
        item.addEventListener('click', () => openArtistAlbums(a));
        els.homeSearchGrid.appendChild(item);
      });
      const label2 = document.createElement('div');
      label2.className = 'hs-label';
      label2.textContent = 'SONGS · 歌曲';
      els.homeSearchGrid.appendChild(label2);
    }
    list.forEach((s) => {
      const item = document.createElement('button');
      item.className = 'hs-item';
      const img = coverImg(s.coverUrl);
      const txt = document.createElement('div');
      txt.className = 'hs-txt';
      const name = document.createElement('div');
      name.className = 'hs-name';
      name.textContent = s.name;
      const artist = document.createElement('div');
      artist.className = 'hs-artist';
      artist.textContent = [s.artist, s.album].filter(Boolean).join(' · ');
      const play = document.createElement('span');
      play.className = 'hs-play';
      play.textContent = '▶';
      txt.append(name, artist);
      item.append(img, txt, play);
      item.addEventListener('click', () => app.playOnline(s));
      els.homeSearchGrid.appendChild(item);
    });
  };
  /* 歌手页：歌手大图在顶部 + 下方原唱热门歌曲列表 + 「存为歌单」；
     音源无热门歌曲接口时降级到专辑列表视图 */
  const openArtistAlbums = async (a) => {
    els.homeSearchNote.textContent = `歌手 · ${a.name} · 加载中…`;
    els.homeSearchGrid.innerHTML = '';
    const back = document.createElement('button');
    back.className = 'hs-item hs-back';
    back.innerHTML = '<span class="hs-play">‹</span><div class="hs-txt"><div class="hs-name">返回搜索结果</div></div>';
    back.addEventListener('click', renderHomeSearch);
    els.homeSearchGrid.appendChild(back);
    // 优先：歌手原唱热门歌曲视图（匿名接口偶发限流返回空，空结果延迟重试一次再降级）
    let top = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        top = await window.api.sourceArtistTop(a.srcId, a.id, a.name);
        if (top?.songs?.length) break;
      } catch { top = null; }
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1600));
    }
    if (top?.songs?.length) {
        const pic = top.coverUrl || a.coverUrl;
        els.homeSearchNote.textContent = `歌手 · ${top.artist || a.name} · 热门原唱 ${top.songs.length} 首`;
        const hero = document.createElement('div');
        hero.className = 'hs-arthero';
        hero.appendChild(coverImg(pic));
        const hname = document.createElement('div');
        hname.className = 'hs-arthero-name';
        hname.textContent = top.artist || a.name;
        const hsub = document.createElement('div');
        hsub.className = 'hs-arthero-sub';
        hsub.textContent = `热门原唱 ${top.songs.length} 首`;
        const saveBtn = document.createElement('button');
        saveBtn.className = 'pill-btn hs-art-save';
        saveBtn.textContent = '♥ 存为歌单';
        saveBtn.addEventListener('click', () => {
          const ups = [...(app.settings.userPlaylists || [])];
          ups.push({
            id: 'upl-' + Date.now(),
            name: `${top.artist || a.name} · 热门`,
            coverUrl: pic || null,
            tracks: top.songs
          });
          app.settings.userPlaylists = ups;
          window.api.setSetting('userPlaylists', ups);
          renderMyPl();
          toast(`已存为歌单「${top.artist || a.name} · 热门」（${top.songs.length} 首）`);
        });
        hero.append(hname, hsub, saveBtn);
        els.homeSearchGrid.appendChild(hero);
        const label = document.createElement('div');
        label.className = 'hs-label';
        label.textContent = 'TOP SONGS · 原唱热门';
        els.homeSearchGrid.appendChild(label);
        top.songs.forEach((s) => {
          const item = document.createElement('button');
          item.className = 'hs-item';
          const img = coverImg(s.coverUrl || pic);
          const txt = document.createElement('div');
          txt.className = 'hs-txt';
          const name = document.createElement('div');
          name.className = 'hs-name';
          name.textContent = s.name;
          const artist = document.createElement('div');
          artist.className = 'hs-artist';
          artist.textContent = [s.artist, s.album].filter(Boolean).join(' · ');
          const play = document.createElement('span');
          play.className = 'hs-play';
          play.textContent = '▶';
          txt.append(name, artist);
          item.append(img, txt, play);
          item.addEventListener('click', () => app.playOnline(s));
          els.homeSearchGrid.appendChild(item);
        });
        return;
    }
    // 降级：专辑列表视图（点专辑进 Folia 歌单页，曲目即专辑曲）
    try {
      const r = await window.api.sourceArtistAlbums(a.srcId, a.id);
      els.homeSearchNote.textContent = r.albums.length ? `歌手 · ${r.artist || a.name} · ${r.albums.length} 张专辑` : `歌手 · ${a.name} · 暂无专辑`;
      const label = document.createElement('div');
      label.className = 'hs-label';
      label.textContent = 'ALBUMS · 专辑';
      els.homeSearchGrid.appendChild(label);
      r.albums.forEach((al) => {
        const item = document.createElement('button');
        item.className = 'hs-item';
        const img = coverImg(al.coverUrl);
        const txt = document.createElement('div');
        txt.className = 'hs-txt';
        const name = document.createElement('div');
        name.className = 'hs-name';
        name.textContent = al.name;
        const sub = document.createElement('div');
        sub.className = 'hs-artist';
        sub.textContent = [al.year, al.count ? `${al.count} 首` : ''].filter(Boolean).join(' · ');
        txt.append(name, sub);
        const go = document.createElement('span');
        go.className = 'hs-play';
        go.textContent = '›';
        item.append(img, txt, go);
        item.addEventListener('click', () => openPlaylistDetail({ id: `pl:${a.srcId}:album:${al.id}`, name: al.name, coverUrl: al.coverUrl }, item));
        els.homeSearchGrid.appendChild(item);
      });
    } catch {
      els.homeSearchNote.textContent = '专辑加载失败，请检查网络';
    }
  };

  const doHomeSearch = async () => {
    const q = els.homeSearchInput.value.trim();
    if (!q) return;
    pushSearchHistory(q);
    hideDrop();
    els.homeSearchSec.classList.remove('hidden');
    els.homeSearchNote.textContent = '搜索中…';
    els.homeSearchGrid.innerHTML = '';
    els.homeSearchClear.classList.remove('hidden');
    homeSearchTargets.forEach(sel => $(sel).classList.add('hidden'));
    try {
      const [list, artists] = await Promise.all([
        window.api.sourceSearchAll(q), // 聚合所有已启用音源（全部为外部插件）
        window.api.sourceSearchArtist(q).catch(() => []) // 歌手搜索（可选能力，源不支持则为空）
      ]);
      if (!list.length && !artists.length) { els.homeSearchNote.textContent = '没有找到结果，换个关键词试试'; return; }
      lastSearch = { q, list, artists };
      renderHomeSearch();
    } catch {
      els.homeSearchNote.textContent = '搜索失败，请检查网络';
    }
  };
  const exitHomeSearch = () => {
    els.homeSearchSec.classList.add('hidden');
    els.homeSearchGrid.innerHTML = '';
    els.homeSearchInput.value = '';
    els.homeSearchClear.classList.add('hidden');
    homeSearchTargets.forEach(sel => $(sel).classList.remove('hidden'));
  };
  els.homeSearchBtn.addEventListener('click', doHomeSearch);
  els.homeSearchClear.addEventListener('click', exitHomeSearch);
  els.homeSearchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doHomeSearch(); });

  /* --- 音量 --- */
  els.volume.addEventListener('input', () => {
    engine.setVolume(els.volume.value / 100);
    app.saveSettings();
  });
  let lastVol = 80;
  els.btnVolume.addEventListener('click', () => {
    const v = +els.volume.value;
    if (v > 0) { lastVol = v; els.volume.value = 0; } else els.volume.value = lastVol;
    engine.setVolume(els.volume.value / 100);
    app.saveSettings();
  });

  /* --- 进度条（底栏顶部细线） --- */
  let dragging = false;
  const seekTo = (e) => {
    const r = els.progressBar.getBoundingClientRect();
    const k = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (engine.duration) engine.seek(k * engine.duration);
  };
  els.progressBar.addEventListener('pointerdown', (e) => {
    dragging = true;
    els.progressBar.classList.add('dragging');
    els.progressBar.setPointerCapture(e.pointerId);
    seekTo(e);
  });
  els.progressBar.addEventListener('pointermove', (e) => { if (dragging) seekTo(e); });
  els.progressBar.addEventListener('pointerup', () => { dragging = false; els.progressBar.classList.remove('dragging'); });

  /* --- 场景切换（视觉控制台预设卡） --- */
  /* --- 场景专属设置容器（预设页 #fxSceneCfg）：点击场景卡只显示对应 data-cfg-scene 分区，默认全隐藏；
         cover/ring/reactor/aurora/flow/wave/collide/field 有专属分区，其余场景（含 pv）显示 generic 通用占位说明；
         启动时 app.js 已恢复场景并置 .scene-btn active → 下方按当前场景同步显示一次 --- */
  const syncSceneCfg = (key) => {
    const has = ['cover', 'ring', 'reactor', 'aurora', 'flow', 'wave', 'collide', 'field', 'mirror'].includes(key);
    document.querySelectorAll('#fxSceneCfg [data-cfg-scene]').forEach(el =>
      el.classList.toggle('hidden', el.dataset.cfgScene !== (has ? key : 'generic')));
    const note = $('#fxSceneCfgNote');
    if (note) note.textContent = key === 'pv' ? '该场景的专属设置见「歌词MV」页。' : '该场景暂无专属设置。';
    requestAnimationFrame(() => keepPanelInView()); // 分区高度变化后复核（箭头延迟求值，规避 const 声明前引用）；面板整体不出视口
  };
  document.querySelectorAll('.scene-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.scene-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      // 图片/视频背景会隐藏动态舞台 → 切场景时恢复舞台
      if (document.body.classList.contains('user-bg')) { app.clearCustomBg(); toast('已切回动态舞台'); }
      scenes.setScene(btn.dataset.scene);
      syncSceneCfg(btn.dataset.scene); // 场景设置容器跟随显示
      app.saveSettings();
      // 主页只允许圆环频谱背景：非 ring 选择已记住，进播放页/Folia 后自动生效
      if (document.body.classList.contains('home-active') && btn.dataset.scene !== 'ring') {
        toast('已记住该视觉效果 — 主页保持圆环频谱，进入播放界面后生效');
      }
      // 播放页开着时选场景 → 自动回到舞台，立即看到新视觉效果
      if (app.npOpen) app.toggleNp(false);
    });
  });
  syncSceneCfg(app.scenes.current); // 启动恢复：按已恢复的当前场景显示对应设置分区

  /* --- 场景配色跟随（预设页 COLOR 分区）：theme 跟随主题 / bg 跟随背景 / cover 跟随封面 →
         theme.setColorSrc 切换所有可视化场景的调色板来源（仅场景，UI 主题色仍由外观页 uiHue 控制） --- */
  const CS_LABEL = { theme: '跟随主题', bg: '跟随背景', cover: '跟随封面' };
  const applyColorSrc = (v, silent) => {
    const src = (v === 'bg' || v === 'cover') ? v : 'theme';
    app.settings.colorSrc = src;
    window.api.setSetting('colorSrc', src);
    app.theme.setColorSrc(src);
    document.querySelectorAll('#palSrcSeg [data-cs]').forEach(x => x.classList.toggle('active', x.dataset.cs === src));
    if (!silent) toast('场景配色：' + CS_LABEL[src]);
  };
  document.querySelectorAll('#palSrcSeg [data-cs]').forEach(b => {
    b.addEventListener('click', () => applyColorSrc(b.dataset.cs));
  });
  applyColorSrc(app.settings.colorSrc || 'theme', true); // 启动恢复（静默，仅同步按钮态与调色板）

  /* --- 随机颜色（COLOR 分区）：开启后每到节奏点随机换所有场景颜色（scenes 渐变过渡）；
         关闭时调 theme.applyFromTrack 渐变回归当前配色来源 --- */
  const tglPalRandom = $('#tglPalRandom');
  if (tglPalRandom) {
    const syncPalRandom = () => tglPalRandom.classList.toggle('on', !!app.settings.palRandom);
    syncPalRandom();
    app.scenes.setPaletteRandom?.(!!app.settings.palRandom); // 启动恢复
    tglPalRandom.addEventListener('click', () => {
      const on = !app.settings.palRandom;
      app.settings.palRandom = on;
      window.api.setSetting('palRandom', on);
      syncPalRandom();
      app.scenes.setPaletteRandom?.(on);
      if (!on) app.theme.applyFromTrack?.(app.engine?.current || null); // 渐变回归配色来源
      toast(on ? '随机颜色：开（节奏点渐变换色）' : '随机颜色：关（回归配色跟随）');
    });
  }

  /* 换色速度滑块（COLOR 分区）：1-5s 过渡时长，持久化 settings.palSpeed；触发时机仍跟随节奏点 */
  const palSpeedIn = $('#fxPalSpeed'), palSpeedV = $('#fxPalSpeedV');
  if (palSpeedIn) {
    const spd = clamp(+(app.settings.palSpeed ?? 2.2) || 2.2, 1, 5);
    palSpeedIn.value = spd; palSpeedV.textContent = spd + 's'; // 启动恢复
    app.scenes.setPaletteSpeed?.(spd);
    palSpeedIn.addEventListener('input', () => {
      const v = clamp(+palSpeedIn.value || 2.2, 1, 5);
      palSpeedV.textContent = v + 's';
      app.settings.palSpeed = v;
      window.api.setSetting('palSpeed', v);
      app.scenes.setPaletteSpeed?.(v);
    });
  }

  /* 换色触发模式（COLOR 分区）：跟随节奏 / 随机时间 / 固定时间；随机与固定用「换色间隔」滑块定周期 */
  const trigBtns = [...document.querySelectorAll('.pal-trig')];
  const palGapRow = $('#fxPalGapRow'), palGapIn = $('#fxPalGap'), palGapV = $('#fxPalGapV');
  if (trigBtns.length) {
    const syncTrig = () => {
      const mode = app.settings.palTrig || 'beat';
      trigBtns.forEach((b) => b.classList.toggle('on', b.dataset.trig === mode));
      palGapRow?.classList.toggle('hidden', mode === 'beat');
    };
    app.scenes.setPaletteTrig?.(app.settings.palTrig || 'beat'); // 启动恢复
    syncTrig();
    trigBtns.forEach((b) => b.addEventListener('click', () => {
      const mode = b.dataset.trig;
      app.settings.palTrig = mode;
      window.api.setSetting('palTrig', mode);
      app.scenes.setPaletteTrig?.(mode);
      syncTrig();
    }));
  }
  if (palGapIn) {
    const gap = clamp(+(app.settings.palGap ?? 6) || 6, 3, 15);
    palGapIn.value = gap; palGapV.textContent = gap + 's'; // 启动恢复
    app.scenes.setPaletteGap?.(gap);
    palGapIn.addEventListener('input', () => {
      const v = clamp(+palGapIn.value || 6, 3, 15);
      palGapV.textContent = v + 's';
      app.settings.palGap = v;
      window.api.setSetting('palGap', v);
      app.scenes.setPaletteGap?.(v);
    });
  }

  /* --- 视觉控制台 / 音效 / 设置（同一面板，按入口分组显示分区） --- */
  // vis 视觉（预设/动态）| eq 音效（均衡器）| set 设置（外观/歌词/高级·音源）
  const FX_GRP_TITLE = { vis: '视觉控制台', eq: '音效', set: '设置' };
  const openFxGroup = (grp) => {
    // 仅「视觉」入口回舞台（看效果需要舞台）；音效/设置面板 z-index 高于播放页，直接盖在歌词页上打开
    if (grp === 'vis' && app.npOpen) app.toggleNp(false);
    const panel = els.fxPanel;
    const sameGrp = panel.dataset.grp === grp;
    panel.dataset.grp = grp;
    panel.querySelector('.fx-title').textContent = FX_GRP_TITLE[grp] || '设置';
    // 只显示本组分区 Tab
    panel.querySelectorAll('.fx-tab').forEach(b => {
      b.style.display = b.dataset.grp === grp ? '' : 'none';
    });
    // 当前激活页不在本组时，切到本组第一个分区
    const active = panel.querySelector('.fx-tab.active');
    if (!active || active.dataset.grp !== grp) {
      const first = panel.querySelector(`.fx-tab[data-grp="${grp}"]`);
      if (first) fxTabSync(first.dataset.ft);
    }
    if (sameGrp && panel.classList.contains('open')) panel.classList.remove('open'); // 同组再点=收起
    else panel.classList.add('open');
    restorePanelPos(); // 打开时复核位置：分辨率/窗口尺寸变化后仍完整落在视口内
    els.drawer.classList.remove('open');
    closeLyricPop(); // 二级菜单互斥：一次只开一个
    closeLoginPop();
  };
  els.btnFx.addEventListener('click', () => openFxGroup('vis'));
  $('#btnEq')?.addEventListener('click', () => openFxGroup('eq'));
  $('#btnSys')?.addEventListener('click', () => openFxGroup('set'));
  els.btnFxClose.addEventListener('click', () => els.fxPanel.classList.remove('open'));

  /* --- 设置面板定位与拖拽：默认屏幕正中（CSS left/top 50% + translate(-50%,-50%)）；
         按住标题栏 .fx-head 拖动（pointer 事件 + setPointerCapture，关闭按钮除外，面板内控件点击不受影响）；
         位置以「中心点坐标」持久化到 settings.panelPos，重启恢复；无记录清空内联样式回到 CSS 居中 --- */
  // 中心点夹取：用 offsetWidth/Height（不受 transform 缩放影响）保证半宽/半高精确，始终整体留在视口内
  const clampPanelCenter = (cx, cy) => {
    const halfW = els.fxPanel.offsetWidth / 2, halfH = els.fxPanel.offsetHeight / 2;
    const x = Math.min(Math.max(cx, halfW), window.innerWidth - halfW);
    const y = Math.min(Math.max(cy, halfH), window.innerHeight - halfH);
    els.fxPanel.style.left = `${x}px`;
    els.fxPanel.style.top = `${y}px`;
  };
  // 恢复/复核面板位置：有记录则夹取回视口内（换分辨率兜底），无记录回 CSS 默认居中
  const restorePanelPos = () => {
    const p = app.settings.panelPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) clampPanelCenter(p.x, p.y);
    else { els.fxPanel.style.left = ''; els.fxPanel.style.top = ''; }
  };
  // 面板打开时按当前高度复核一次（切到更高分区后顶边不出屏）
  const keepPanelInView = () => {
    if (!els.fxPanel.classList.contains('open')) return;
    const r = els.fxPanel.getBoundingClientRect();
    clampPanelCenter(r.left + r.width / 2, r.top + r.height / 2);
  };
  restorePanelPos();

  const fxHeadEl = els.fxPanel.querySelector('.fx-head');
  let fxDrag = null;
  fxHeadEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#btnFxClose')) return; // 仅左键且非关闭按钮才启动拖拽
    const r = els.fxPanel.getBoundingClientRect();
    fxDrag = { dx: e.clientX - r.left - r.width / 2, dy: e.clientY - r.top - r.height / 2 };
    fxHeadEl.setPointerCapture(e.pointerId); // 指针移出面板也持续跟踪
    document.body.classList.add('fx-dragging'); // 拖拽中禁文本选中 + grabbing 光标
  });
  fxHeadEl.addEventListener('pointermove', (e) => {
    if (fxDrag) clampPanelCenter(e.clientX - fxDrag.dx, e.clientY - fxDrag.dy); // 实时跟手
  });
  const endFxDrag = () => {
    if (!fxDrag) return;
    fxDrag = null;
    document.body.classList.remove('fx-dragging');
    app.settings.panelPos = { x: parseFloat(els.fxPanel.style.left), y: parseFloat(els.fxPanel.style.top) };
    window.api.setSetting('panelPos', app.settings.panelPos); // 位置记忆
  };
  fxHeadEl.addEventListener('pointerup', endFxDrag);
  fxHeadEl.addEventListener('pointercancel', endFxDrag);
  const toggleFull = () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  };
  els.btnFull.addEventListener('click', toggleFull);
  els.btnFxFull.addEventListener('click', toggleFull);
  els.btnFxLyric.addEventListener('click', () => app.toggleNp());

  const syncStyleUI = () => {
    document.querySelectorAll('#lyricStyleSeg button').forEach(b =>
      b.classList.toggle('active', b.dataset.ls === app.lyricStyle));
  };
  const setLyricStyle = (s) => {
    app.lyricStyle = s;
    els.lyrics.className = `lyrics style-${s}`;
    app.saveSettings();
    syncStyleUI();
    toast('歌词样式：' + (LYRIC_PRESETS.find(p => p.id === s)?.name || s));
  };
  document.querySelectorAll('#lyricStyleSeg button').forEach(b =>
    b.addEventListener('click', () => setLyricStyle(b.dataset.ls)));
  syncStyleUI();

  /* --- 歌词字体选择（歌词面板 / 舞台悬浮 / PV 字幕场景统一生效） --- */
  const setLyricFont = (f, silent) => {
    app.lyrics.setFont(f);
    scenes.setLyricFont?.(f);
    app.settings.lyricFont = f;
    window.api.setSetting('lyricFont', f);
    document.querySelectorAll('#lyricFontSeg button').forEach(b =>
      b.classList.toggle('active', b.dataset.lf === f));
    if (!silent) toast('歌词字体：' + (document.querySelector(`#lyricFontSeg button[data-lf="${CSS.escape(f)}"]`)?.textContent || '默认'));
  };
  document.querySelectorAll('#lyricFontSeg button').forEach(b =>
    b.addEventListener('click', () => setLyricFont(b.dataset.lf)));
  if (app.settings.lyricFont) setLyricFont(app.settings.lyricFont, true);
  else document.querySelector('#lyricFontSeg button[data-lf=""]')?.classList.add('active');

  /* --- 歌词同步偏移：人声与歌词时间轴对齐微调（正值=歌词延后，负值=提前） --- */
  const lyrOffEl = $('#fxLyrOffset'), lyrOffV = $('#fxLyrOffsetV');
  const setLyricOffset = (v, silent) => {
    v = Math.max(-3, Math.min(3, Math.round((+v || 0) * 10) / 10));
    app.lyricOffset = v;
    app.settings.lyricOffset = v;
    lyrOffEl.value = String(v);
    lyrOffV.textContent = (v > 0 ? '+' : '') + v.toFixed(1);
    window.api.setSetting('lyricOffset', v);
    if (!silent) toast(v ? `歌词同步：${v > 0 ? '延后' : '提前'} ${Math.abs(v).toFixed(1)}s` : '歌词同步：已归零');
  };
  lyrOffEl.addEventListener('input', () => setLyricOffset(+lyrOffEl.value, true));
  lyrOffEl.addEventListener('change', () => setLyricOffset(+lyrOffEl.value));
  setLyricOffset(app.settings.lyricOffset || 0, true);

  /* --- 歌词动画场景：20 种风格 × 字号/位置/暗度（配置整体持久化为 pvCfg.style） --- */
  const PV_STYLE_NAMES = {
    noir: '黑白默片', crimson: '绯红', caution: '警示黄', magenta: '品红',
    paper: '纸张', hud: 'HUD', mint: '薄荷', specimen: '标本',
    transit: '换乘指示', blueprint: '蓝图', rouge: '胭脂', mono: '单色',
    aurora: '极光', cyber: '赛博', sunset: '落日', ink: '水墨',
    neon: '霓虹', vintage: '复古', matrix: '矩阵', dream: '梦境'
  };
  const pvSld = { dim: [$('#fxPvDim'), $('#fxPvDimV'), 65] }; // 亮度滑块：值 = 100 - dim*100（内层仍是暗度 dim）
  const setPvCfg = (patch, silent) => {
    app.settings.pvCfg = Object.assign({ style: 'noir', size: 1, y: 0.52, dim: 0.35 }, app.settings.pvCfg, patch);
    const c = app.settings.pvCfg;
    if (!PV_STYLE_NAMES[c.style]) c.style = 'noir'; // 旧配置残留的未知风格归位到默认
    scenes.setPvConfig?.(c);
    window.api.setSetting('pvCfg', c);
    document.querySelectorAll('#pvStyleSeg button').forEach(b => b.classList.toggle('active', b.dataset.ps === c.style));
    pvSld.dim[0].value = Math.round((1 - c.dim) * 100); pvSld.dim[1].textContent = Math.round((1 - c.dim) * 100);
    if (!silent && patch && patch.style) toast('歌词动画：' + (PV_STYLE_NAMES[patch.style] || patch.style));
  };
  document.querySelectorAll('#pvStyleSeg button').forEach(b => b.addEventListener('click', () => setPvCfg({ style: b.dataset.ps })));
  pvSld.dim[0].addEventListener('input', () => setPvCfg({ dim: (100 - +pvSld.dim[0].value) / 100 }, true));
  setPvCfg(null, true);

  /* --- 设置中心：分区切换 --- */
  const fxTabSync = (ft) => {
    document.querySelectorAll('.fx-tab').forEach(x => x.classList.toggle('active', x.dataset.ft === ft));
    document.querySelectorAll('.ft-page').forEach(p => p.classList.toggle('hidden', p.id !== 'ft-' + ft));
    requestAnimationFrame(keepPanelInView); // 分区高度变化后复核，面板整体不出视口
  };
  document.querySelectorAll('.fx-tab').forEach(b => b.addEventListener('click', () => fxTabSync(b.dataset.ft)));
  fxTabSync('preset'); // 默认分区

  /* --- 预设分区：场景快捷切换（同步场景设置容器显示） --- */
  document.querySelectorAll('.scene-quick').forEach(btn => {
    btn.addEventListener('click', () => {
      if (document.body.classList.contains('user-bg')) { app.clearCustomBg(); toast('已切回动态舞台'); }
      scenes.setScene(btn.dataset.scene);
      document.querySelectorAll('.scene-btn').forEach(b => b.classList.toggle('active', b.dataset.scene === btn.dataset.scene));
      syncSceneCfg(btn.dataset.scene);
      app.saveSettings();
      if (app.npOpen) app.toggleNp(false);
    });
  });

  /* --- 音效：五段 EQ + 预设 + 混响 / 回声 / 空间音频 / 压缩 / 播放速度 --- */
  const eqIn = { sub: $('#eqSub'), low: $('#eqLow'), mid: $('#eqMid'), high: $('#eqHigh'), pres: $('#eqPres') };
  const eqV = { sub: $('#eqSubV'), low: $('#eqLowV'), mid: $('#eqMidV'), high: $('#eqHighV'), pres: $('#eqPresV') };
  const EQ_KEYS = ['sub', 'low', 'mid', 'high', 'pres'];
  // 五段预设 [sub, low, mid, high, pres]，单位 dB
  // 10 种音效预设：每条含 EQ 五段 + 混响 wet + 回声 {time,fb,wet}，一键设置整条音效链
  const EQ_PRESETS = {
    flat:       { eq: [0, 0, 0, 0, 0],       reverb: 0,    echo: { time: 0.28, fb: 0.35, wet: 0 } },
    bass:       { eq: [8, 6, -2, 0, 1],      reverb: 0,    echo: { time: 0.28, fb: 0.35, wet: 0 } },
    vocal:      { eq: [-1, -2, 4, 3, 2],     reverb: 0.12, echo: { time: 0.22, fb: 0.28, wet: 0.08 } },
    treble:     { eq: [0, -1, -2, 4, 6],     reverb: 0,    echo: { time: 0.28, fb: 0.35, wet: 0 } },
    electronic: { eq: [5, 4, 1, 3, 5],       reverb: 0.18, echo: { time: 0.32, fb: 0.42, wet: 0.18 } },
    rock:       { eq: [4, 3, -1, 2, 4],      reverb: 0.15, echo: { time: 0.26, fb: 0.30, wet: 0.06 } },
    live:       { eq: [3, 2, 0, 1, 2],       reverb: 0.55, echo: { time: 0.38, fb: 0.38, wet: 0.22 } },  // 演唱会：大厅混响
    ktv:        { eq: [2, 1, 5, 2, 1],       reverb: 0.35, echo: { time: 0.30, fb: 0.45, wet: 0.30 } },  // KTV：人声突出+回声
    studio:     { eq: [1, 0, 2, 1, 0],       reverb: 0.08, echo: { time: 0.20, fb: 0.20, wet: 0.02 } },  // 录音棚：干声微润
    ethereal:   { eq: [0, -1, 0, 2, 3],      reverb: 0.80, echo: { time: 0.45, fb: 0.50, wet: 0.28 } },  // 空灵：大混响长回声
  };
  const applyEqSliders = (eq) => {
    for (const k of EQ_KEYS) { eqIn[k].value = eq[k] ?? 0; eqV[k].textContent = eq[k] ?? 0; }
  };
  const saveEq = (eq) => {
    engine.setEQ(eq);
    app.settings.eq = eq;
    window.api.setSetting('eq', eq);
  };
  // 音效预设选中态：点击预设高亮（.on 跟随主题色）并持久化；
  // 手动调 EQ/混响/回声即偏离预设 → 清除高亮（空 key 全部不选）
  const markEqPreset = (key) => {
    document.querySelectorAll('.eq-preset').forEach(x => x.classList.toggle('on', x.dataset.eqp === key));
    app.settings.eqPreset = key || '';
    window.api.setSetting('eqPreset', key || '');
  };
  markEqPreset(app.settings.eqPreset || ''); // 启动恢复上次选中的预设高亮
  applyEqSliders(engine.eq);
  for (const k of EQ_KEYS) {
    eqIn[k].addEventListener('input', () => {
      eqV[k].textContent = eqIn[k].value;
      saveEq(EQ_KEYS.reduce((o, key) => (o[key] = +eqIn[key].value, o), {}));
      markEqPreset(''); // 手动调 EQ 偏离预设
    });
  }
  document.querySelectorAll('.eq-preset').forEach(b => b.addEventListener('click', () => {
    const p = EQ_PRESETS[b.dataset.eqp];
    if (!p) return;
    // EQ
    const eq = { sub: p.eq[0], low: p.eq[1], mid: p.eq[2], high: p.eq[3], pres: p.eq[4] };
    applyEqSliders(eq); saveEq(eq);
    // 混响
    engine.setReverb(p.reverb);
    app.settings.reverb = p.reverb; window.api.setSetting('reverb', p.reverb);
    reverbIn.value = Math.round(p.reverb * 100); reverbV.textContent = reverbIn.value + '%';
    // 回声
    echoCfg.time = p.echo.time; echoCfg.fb = p.echo.fb; echoCfg.wet = p.echo.wet;
    echoTimeIn.value = Math.round(p.echo.time * 1000); echoTimeV.textContent = echoTimeIn.value + 'ms';
    echoFbIn.value = Math.round(p.echo.fb * 100); echoFbV.textContent = echoFbIn.value + '%';
    echoWetIn.value = Math.round(p.echo.wet * 100); echoWetV.textContent = echoWetIn.value + '%';
    saveEcho();
    markEqPreset(b.dataset.eqp); // 选中高亮 + 持久化（放在最末，上面程序化赋值不触发 input 事件）
    toast('音效预设：' + b.textContent.trim());
  }));

  // —— 混响 ——
  const reverbIn = $('#fxReverb'), reverbV = $('#fxReverbV');
  const setReverbUi = (wet) => { reverbIn.value = Math.round(wet * 100); reverbV.textContent = reverbIn.value + '%'; };
  setReverbUi(app.settings.reverb ?? 0);
  engine.setReverb(app.settings.reverb ?? 0);
  reverbIn.addEventListener('input', () => {
    const wet = +reverbIn.value / 100;
    reverbV.textContent = reverbIn.value + '%';
    engine.setReverb(wet);
    app.settings.reverb = wet;
    window.api.setSetting('reverb', wet);
    markEqPreset(''); // 手动调混响偏离预设
  });

  // —— 回声 ——
  const echoTimeIn = $('#fxEchoTime'), echoTimeV = $('#fxEchoTimeV');
  const echoFbIn = $('#fxEchoFb'), echoFbV = $('#fxEchoFbV');
  const echoWetIn = $('#fxEchoWet'), echoWetV = $('#fxEchoWetV');
  const echoCfg = { time: (app.settings.echo?.time ?? 0.28), fb: (app.settings.echo?.fb ?? 0.35), wet: (app.settings.echo?.wet ?? 0) };
  echoTimeIn.value = Math.round(echoCfg.time * 1000); echoTimeV.textContent = echoTimeIn.value + 'ms';
  echoFbIn.value = Math.round(echoCfg.fb * 100); echoFbV.textContent = echoFbIn.value + '%';
  echoWetIn.value = Math.round(echoCfg.wet * 100); echoWetV.textContent = echoWetIn.value + '%';
  engine.setEcho(echoCfg);
  const saveEcho = () => {
    echoCfg.time = +echoTimeIn.value / 1000;
    echoCfg.fb = +echoFbIn.value / 100;
    echoCfg.wet = +echoWetIn.value / 100;
    engine.setEcho(echoCfg);
    app.settings.echo = { ...echoCfg };
    window.api.setSetting('echo', app.settings.echo);
  };
  echoTimeIn.addEventListener('input', () => { echoTimeV.textContent = echoTimeIn.value + 'ms'; saveEcho(); markEqPreset(''); });
  echoFbIn.addEventListener('input', () => { echoFbV.textContent = echoFbIn.value + '%'; saveEcho(); markEqPreset(''); });
  echoWetIn.addEventListener('input', () => { echoWetV.textContent = echoWetIn.value + '%'; saveEcho(); markEqPreset(''); });

  // —— 空间音频 ——
  const spatialSeg = $('#spatialSeg');
  const spatialMode = app.settings.spatial ?? 'off';
  engine.setSpatial(spatialMode);
  spatialSeg.querySelectorAll('button').forEach(b => {
    b.classList.toggle('active', b.dataset.sp === spatialMode);
    b.addEventListener('click', () => {
      const mode = b.dataset.sp;
      spatialSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      engine.setSpatial(mode);
      app.settings.spatial = mode;
      window.api.setSetting('spatial', mode);
    });
  });

  // —— 压缩器 ——
  const compOnBtn = $('#fxCompOn'), compThrIn = $('#fxCompThr'), compThrV = $('#fxCompThrV'),
        compRatioIn = $('#fxCompRatio'), compRatioV = $('#fxCompRatioV');
  const compCfg = {
    on: app.settings.comp?.on ?? true,
    threshold: app.settings.comp?.threshold ?? -18,
    ratio: app.settings.comp?.ratio ?? 3,
  };
  const applyCompUi = () => {
    compOnBtn.classList.toggle('active', compCfg.on);
    compOnBtn.textContent = compCfg.on ? '压缩：开' : '压缩：关';
    compThrIn.value = compCfg.threshold; compThrV.textContent = compCfg.threshold + 'dB';
    compRatioIn.value = compCfg.ratio; compRatioV.textContent = compCfg.ratio + ':1';
  };
  applyCompUi();
  engine.setComp(compCfg);
  const saveComp = () => {
    engine.setComp(compCfg);
    app.settings.comp = { ...compCfg };
    window.api.setSetting('comp', app.settings.comp);
  };
  compOnBtn.addEventListener('click', () => { compCfg.on = !compCfg.on; applyCompUi(); saveComp(); });
  compThrIn.addEventListener('input', () => { compCfg.threshold = +compThrIn.value; compThrV.textContent = compCfg.threshold + 'dB'; saveComp(); });
  compRatioIn.addEventListener('input', () => { compCfg.ratio = +compRatioIn.value; compRatioV.textContent = compCfg.ratio + ':1'; saveComp(); });

  // —— 播放速度（固定倍数：0.5x / 0.75x / 1.0x / 1.25x / 1.5x / 1.75x / 2.0x）——
  const speedIn = $('#fxSpeed'), speedV = $('#fxSpeedV');
  const SPEED_STEPS = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  const snapSpeed = (v) => SPEED_STEPS.reduce((a, b) => Math.abs(b - v) < Math.abs(a - v) ? b : a);
  const speed = snapSpeed(+app.settings.speed || 1);
  speedIn.value = Math.round(speed * 100);
  speedV.textContent = speed.toFixed(2) + 'x';
  engine.setSpeed(speed);
  speedIn.addEventListener('input', () => {
    const raw = +speedIn.value / 100;
    const s = snapSpeed(raw);
    speedIn.value = Math.round(s * 100);
    speedV.textContent = s.toFixed(2) + 'x';
    engine.setSpeed(s);
    app.settings.speed = s;
    window.api.setSetting('speed', s);
  });

  /* --- 动态：视觉灵敏度 --- */
  const fxSens = $('#fxSens'), fxSensV = $('#fxSensV');
  fxSens.value = Math.round((engine.sensitivity || 1) * 100);
  fxSensV.textContent = fxSens.value;
  fxSens.addEventListener('input', () => {
    const v = +fxSens.value;
    fxSensV.textContent = v;
    engine.sensitivity = v / 100;
    window.api.setSetting('sensitivity', v / 100);
  });

  /* --- 歌词设置浮窗 #lyricPop：侧边悬浮歌词（位置/旋转/行数，控件自歌词MV页迁入但 id 不变，写入 settings 即时生效） ---
     body 上挂 --sl-tilt/--sl-rows/--sl-x 变量，CSS 侧驱动旋转角度/可视行数/水平位置；
     行数改变会改容器高度 → 置 _slDirty 标记，由下方 updateStageLyric 消费后重贴滚动位置 */
  const applySlCfg = () => {
    // Number(?? 默认值)：settings 未写入时回默认（直接 +undefined 得 NaN 会污染 CSS 变量）
    const tilt = Math.max(0, Math.min(360, Math.round(Number(app.settings.slTilt ?? 46)))); // 旋转角：绕列中间轴自转，0/360 正对观众
    const rows = Math.max(3, Math.min(15, Math.round(Number(app.settings.slRows ?? 5))));
    const pos = Math.max(0, Math.min(100, Math.round(Number(app.settings.slPosY ?? 50)))); // 垂直位置：0 顶 / 100 底，50 居中
    const size = Math.max(60, Math.min(180, Math.round(Number(app.settings.slSize ?? 100)))); // 大小：基础字号的百分比缩放
    const posX = Math.max(0, Math.min(100, Math.round(Number(app.settings.slPosX ?? 0)))); // 左右：0 贴左 / 100 贴右
    // 自动旋转时 --sl-tilt 由摇摆 rAF 每帧驱动，这里不能用手拖角覆盖（会闪回静态角一帧）
    if (app.settings.slAuto !== true) document.body.style.setProperty('--sl-tilt', String(tilt));
    document.body.style.setProperty('--sl-rows', String(rows));
    document.body.style.setProperty('--sl-pos', String(pos));
    document.body.style.setProperty('--sl-x', String(posX));
    document.body.style.setProperty('--sl-scale', (size / 100).toFixed(2));
    document.body.dataset.slSide = posX >= 50 ? 'right' : 'left'; // 过半切右对齐（文字朝屏幕内侧）
    app._slDirty = true;
    return { tilt, rows, pos, size, posX };
  };
  const slTiltIn = $('#fxSlTilt'), slTiltV = $('#fxSlTiltV'), slRowsIn = $('#fxSlRows'), slRowsV = $('#fxSlRowsV');
  slTiltIn.addEventListener('input', () => {
    // 手拖「旋转」即退出自动旋转（自动模式每帧会覆盖滑杆值，不退出就拖不动）
    if (app.settings.slAuto === true) {
      app.settings.slAuto = false;
      window.api.setSetting('slAuto', false);
      applySlAuto();
    }
    const v = +slTiltIn.value;
    slTiltV.textContent = v;
    app.settings.slTilt = v;
    window.api.setSetting('slTilt', v);
    applySlCfg();
    slApply3dExt();   // 体块挤出方向与明暗都跟着旋转角变（光源固定在页面中间）
  });

  /* --- 悬浮歌词「自动旋转」：开启后整列以正面（0°）为中心左右自动摇摆（±55° 正弦，周期约 6.5s） ---
     摇摆角只写 --sl-tilt + 每帧重建 3D 挤出链（15 级字符串，开销可忽略），不写 settings ——
     settings 里保留手拖的角度，关闭自动时原样回到手拖角度；滑杆显示跟随摇摆（程序赋值不触发 input）。 */
  const slAutoBtn = $('#slAutoBtn');
  let slAutoRaf = 0;
  const slAutoTick = (now) => {
    const a = Math.round((55 * Math.sin(now / 6500 * 2 * Math.PI) + 360) % 360);
    document.body.style.setProperty('--sl-tilt', String(a));
    slTiltIn.value = a;
    slTiltV.textContent = a;
    slApply3dExt(a);   // 体块/光照必须按摇摆角重建（settings.slTilt 是静态手拖角）
    slAutoRaf = requestAnimationFrame(slAutoTick);
  };
  const applySlAuto = () => {
    const on = app.settings.slAuto === true;
    slAutoBtn.textContent = on ? '自动旋转：开' : '自动旋转：关';
    slAutoBtn.classList.toggle('active', on);
    if (on) { if (!slAutoRaf) slAutoRaf = requestAnimationFrame(slAutoTick); }
    else if (slAutoRaf) { cancelAnimationFrame(slAutoRaf); slAutoRaf = 0; applySlCfg(); slApply3dExt(); }
    return on;
  };
  slAutoBtn.addEventListener('click', () => {
    app.settings.slAuto = !(app.settings.slAuto === true);
    window.api.setSetting('slAuto', app.settings.slAuto);
    applySlAuto();
  });
  applySlAuto(); // 启动恢复
  slRowsIn.addEventListener('input', () => {
    const v = +slRowsIn.value;
    slRowsV.textContent = v;
    app.settings.slRows = v;
    window.api.setSetting('slRows', v);
    applySlCfg();
  });
  const slPosIn = $('#fxSlPosY'), slPosV = $('#fxSlPosYV'); // 垂直位置（0-100，50=居中）
  slPosIn.addEventListener('input', () => {
    const v = +slPosIn.value;
    slPosV.textContent = v;
    app.settings.slPosY = v;
    window.api.setSetting('slPosY', v);
    applySlCfg();
  });
  const slPosXIn = $('#fxSlPosX'), slPosXV = $('#fxSlPosXV'); // 左右（0 贴左 / 100 贴右，过半自动右对齐）
  slPosXIn.addEventListener('input', () => {
    const v = +slPosXIn.value;
    slPosXV.textContent = v;
    app.settings.slPosX = v;
    window.api.setSetting('slPosX', v);
    applySlCfg();
  });
  const slSizeIn = $('#fxSlSize'), slSizeV = $('#fxSlSizeV'); // 大小（60-180%，100=默认）
  slSizeIn.addEventListener('input', () => {
    const v = +slSizeIn.value;
    slSizeV.textContent = v;
    app.settings.slSize = v;
    window.api.setSetting('slSize', v);
    applySlCfg();
  });
  const slInit = applySlCfg(); // 启动恢复：应用持久化配置并回填滑块
  slTiltIn.value = slInit.tilt; slTiltV.textContent = slInit.tilt;
  slRowsIn.value = slInit.rows; slRowsV.textContent = slInit.rows;
  slPosIn.value = slInit.pos; slPosV.textContent = slInit.pos;
  slPosXIn.value = slInit.posX; slPosXV.textContent = slInit.posX;
  slSizeIn.value = slInit.size; slSizeV.textContent = slInit.size;

  /* --- 悬浮歌词独立字体（#lyricPop「SL FONT」）：与歌词面板 --lyric-font 分开 ---
         follow=跟随面板字体（默认，移除 --sl-font 回落 --lyric-font）；其余写入具体字体族 --sl-font，
         由 #stageLyricTilt/#stageLyricStack → .sl-row 消费；绑定/回填模式照抄歌词面板 lyricFontSeg */
  const applySlFont = () => {
    const f = app.settings.slFont || 'follow';
    if (f === 'follow') document.documentElement.style.removeProperty('--sl-font');
    else document.documentElement.style.setProperty('--sl-font', `"${f}", "PingFang SC", "Microsoft YaHei", sans-serif`);
    document.querySelectorAll('#slFontSeg button').forEach(b =>
      b.classList.toggle('active', b.dataset.slf === f));
    return f;
  };
  document.querySelectorAll('#slFontSeg button').forEach(b => b.addEventListener('click', () => {
    app.settings.slFont = b.dataset.slf;
    window.api.setSetting('slFont', b.dataset.slf);
    applySlFont();
    toast('悬浮歌词字体：' + b.textContent);
  }));
  applySlFont(); // 启动恢复

  /* --- 悬浮歌词独立风格（#lyricPop「SL STYLE」）：scene=跟随场景配色（默认，现状）；数字=固定色相 ---
         非 scene 时 body 挂 data-sl-style="custom" + --sl-style-hue（纯白 0 走低饱和 --sl-style-sat:12%），
         CSS 侧让 .sl-row 配色/辉光改用固定色相覆盖场景规则，其余距离档同色系变暗 */
  const SL_STYLES = [
    { v: 'scene', name: '跟随场景' }, { v: 0, name: '纯白' }, { v: 160, name: '薄荷' },
    { v: 42, name: '香槟金' }, { v: 330, name: '樱粉' }, { v: 195, name: '冰蓝' }
  ];
  const applySlStyle = () => {
    const v = app.settings.slStyle == null ? 'scene' : app.settings.slStyle;
    if (v === 'scene') {
      delete document.body.dataset.slStyle;
      document.body.style.removeProperty('--sl-style-hue');
      document.body.style.removeProperty('--sl-style-sat');
    } else {
      const hue = ((Math.round(+v) || 0) % 360 + 360) % 360;
      document.body.dataset.slStyle = 'custom';
      document.body.style.setProperty('--sl-style-hue', String(hue));
      document.body.style.setProperty('--sl-style-sat', hue === 0 ? '12%' : '85%'); // 纯白=近无饱和，其余=鲜明色相
    }
    document.querySelectorAll('#slStyleSeg button').forEach(b =>
      b.classList.toggle('active', String(b.dataset.sls) === String(v)));
    return v;
  };
  document.querySelectorAll('#slStyleSeg button').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.sls === 'scene' ? 'scene' : +b.dataset.sls;
    app.settings.slStyle = v;
    window.api.setSetting('slStyle', v);
    applySlStyle();
    toast('悬浮歌词风格：' + (SL_STYLES.find(s => String(s.v) === String(v))?.name || ''));
  }));
  applySlStyle(); // 启动恢复

  /* --- 悬浮歌词 3D 立体字开关：body 挂 data-sl-3d="on" + 按旋转角生成「实心挤出体块」阴影串 --sl-ext ---
     两条都必须跟着角度 θ 一起算，否则转到背面就会穿帮：

     ① 挤出偏移 —— 体块是沿 -Z（远离观众）挤出后投影到屏幕上的：屏幕横向位移 = 厚度 × sinθ。
        text-shadow 的偏移写在「面板局部坐标系」，而局部 x 被视角压扁 cosθ 倍，
        所以要得到固定的屏幕位移，局部 x 必须再除以 cosθ（即 tanθ）；θ→90° 时发散：
        夹紧到 |cosθ|≥0.22，同时整条链按 |cosθ| 淡出 —— 正好和「面板侧对观众、本身投影成一条线」
        同步消失，观感自然。级间在屏幕上恒为 SL_EXT_DEPTH/STEPS、同色且模糊为 0 → 并成连续实心侧壁，
        不会出现「很多层堆起来」的色带（这是之前逐级改色导致的）。

        厚度很小（5px）是关键：CJK 19px 字号下，挤出体块一旦超过约 4~5px 就会把相邻笔画之间的
        空隙填满，整行糊成一团（实测 12px 时 45° 几乎不可读）；配合 --sl-face-dim 压暗后，
        薄体块既保留立体感又不牺牲可读性。

     ② 光追（光源在页面中间）—— 面板法线 n = (sinθ, 0, cosθ)；左侧列指向页面中心的光向
        L = (1, 0.3, 0.55)。受光面亮度 = dot(n, L)：θ=0 正面中等偏亮、转到背面（θ≈180°）为负 → 压暗，
        整列同时乘 --sl-face-dim（正面 1 → 背面 0.58），使「镜像字」读作背光的那一面而不是 bug；
        棱光永远贴在朝光源那侧（屏幕右侧）：局部偏移 = 屏幕偏移 / cosθ，cosθ<0 时自动翻到另一侧
        （背面镜像后仍然对得上光）。 */
  const sl3dBtn = $('#sl3dBtn');
  const SL_EXT_STEPS = 14;    // 体块级数（级间屏幕位移 = SL_EXT_DEPTH / STEPS，亚像素贴合无缝）
  const SL_EXT_DEPTH = 5;     // 体块厚度：屏幕上横向位移的最大值（px）—— 过大即糊，见上
  const SL_EXT_DROP = 0.5;    // 体块的固定向下分量（= 厚度 × 0.5）：正对观众（0°）时也有可见厚度
  const SL_EXT_LIT = 2;       // 贴文字的前 2 级做迎光斜面，其余为背光主体
  const slApply3dExt = (degOverride) => {
    const st = document.body.style;
    if (app.settings.sl3d !== true) { st.removeProperty('--sl-ext'); st.removeProperty('--sl-face-dim'); return; }
    // degOverride：「左右自动」摇摆每帧传入实时角；否则用手拖的 settings.slTilt
    const th = (((Math.round(degOverride ?? Number(app.settings.slTilt ?? 46)) % 360) + 360) % 360) * Math.PI / 180;
    const c = Math.cos(th), s = Math.sin(th);
    // 背面压暗：θ=0/360 正面最亮；θ≥90°（侧对→背面）整列压到 0.58 ——
    // 0.42 会让「已在距离阶梯里调过透明度的暗行」叠加后几乎读不出来，0.58 仍明显暗于正面又保住可读性
    const bf = 0.58 + 0.42 * Math.max(0, c);
    st.setProperty('--sl-face-dim', bf.toFixed(3));
    // 侧对观众时整条链淡出；此时面板本身也投影成一条线，同步消失才自然
    const fade = Math.min(1, Math.abs(c) / 0.34);
    if (fade <= 0.02) { st.removeProperty('--sl-ext'); return; }
    // 局部 x = 屏幕位移 / cosθ（cosθ→0 发散 → 夹到 0.22；符号保留：背面自动镜像）
    const kInv = c < 0 ? -1 / Math.max(0.22, -c) : 1 / Math.max(0.22, c);
    const scrX = -s * SL_EXT_DEPTH;                 // 横向：沿 -Z 挤出（θ>90° 时自动反向）
    const scrY = SL_EXT_DEPTH * SL_EXT_DROP;        // 纵向：rotateY 不压缩 y，局部 = 屏幕
    // 受光/背光两档：随 bf 变明暗（同级同色 → 并成实心，无级间色带）
    const litL = Math.round(30 + 38 * bf), bodyL = Math.round(10 + 14 * bf);
    const lit = `hsla(var(--pal-hue, 210), 60%, ${litL}%, ${fade.toFixed(2)})`;
    const body = `hsla(var(--pal-hue, 210), 46%, ${bodyL}%, ${fade.toFixed(2)})`;
    const list = [];
    for (let i = 1; i <= SL_EXT_STEPS; i++) {
      const f = i / SL_EXT_STEPS;
      list.push(`${(scrX * f * kInv).toFixed(2)}px ${(scrY * f).toFixed(2)}px 0 ${i <= SL_EXT_LIT ? lit : body}`);
    }
    // 受光侧棱光：朝页面中心（光源）一侧的白色亮边 —— 屏幕位移固定 0.9px，被正面字形遮住的部分不可见
    list.push(`${(0.9 * kInv).toFixed(2)}px 0 0 rgba(255, 255, 255, ${(0.45 * fade).toFixed(2)})`);
    st.setProperty('--sl-ext', list.join(', '));
  };
  const applySl3d = () => {
    const on = app.settings.sl3d === true;
    // 注意：dataset.sl3d 会生成 data-sl3d（无连字符）与 CSS 的 data-sl-3d 不匹配，必须 setAttribute
    if (on) document.body.setAttribute('data-sl-3d', 'on'); else document.body.removeAttribute('data-sl-3d');
    sl3dBtn.textContent = on ? '立体字：开' : '立体字：关';
    sl3dBtn.classList.toggle('active', on);
    slApply3dExt();
    return on;
  };
  sl3dBtn.addEventListener('click', () => {
    app.settings.sl3d = !(app.settings.sl3d === true);
    window.api.setSetting('sl3d', app.settings.sl3d);
    applySl3d();
  });
  applySl3d();

  /* --- 悬浮歌词卡拉OK开关：当前行逐字进度填充（CSS --sl-lit 驱动 clip） --- */
  const slKaraokeBtn = $('#slKaraokeBtn');
  const applySlKaraoke = () => {
    const on = app.settings.slKaraoke === true;
    if (on) document.body.dataset.slKaraoke = 'on'; else delete document.body.dataset.slKaraoke;
    slKaraokeBtn.textContent = on ? '卡拉OK：开' : '卡拉OK：关';
    slKaraokeBtn.classList.toggle('active', on);
    return on;
  };
  slKaraokeBtn.addEventListener('click', () => {
    app.settings.slKaraoke = !(app.settings.slKaraoke === true);
    window.api.setSetting('slKaraoke', app.settings.slKaraoke);
    applySlKaraoke();
  });
  applySlKaraoke();

  /* --- 预设分区：反应堆场景（滴水间隔/透视倾角/高度增益/整体大小/网格密度/流星频率/自转开关，
         写入 settings → scenes.setReactorConfig → mgr.reactorCfg 每帧实时生效；密度变化由场景内部比对重建网格） --- */
  const numOr = (v, d) => (v == null || Number.isNaN(+v) ? d : +v); // 设置缺省/坏值兜底
  const applyRplCfg = () => {
    const freq = clamp(numOr(app.settings.rplFreq, 3.5), 1, 8);
    const tilt = clamp(numOr(app.settings.rplTilt, 4), 0, 10);
    const gain = clamp(numOr(app.settings.rplGain, 100) / 100, 0.5, 2);
    const scale = clamp(numOr(app.settings.rplScale, 100) / 100, 0.5, 2);
    const grid = Math.round(clamp(numOr(app.settings.rplGrid, 96), 32, 512));
    const mtrFreq = clamp(numOr(app.settings.rplMtr, 55), 0, 100);
    const spin = app.settings.rplSpin !== false;
    const rnd = clamp(numOr(app.settings.rplRnd, 100) / 100, 0, 2);
    const metal = clamp(numOr(app.settings.rplMetal, 100) / 100, 0.3, 2);
    scenes.setReactorConfig?.({ freq, tilt, gain, scale, grid, mtrFreq, spin, rnd, metal });
    return { freq, tilt, gain, scale, grid, mtrFreq, spin, rnd, metal };
  };
  const rplFreqIn = $('#fxRplFreq'), rplFreqV = $('#fxRplFreqV');
  const rplTiltIn = $('#fxRplTilt'), rplTiltV = $('#fxRplTiltV');
  const rplGainIn = $('#fxRplGain'), rplGainV = $('#fxRplGainV');
  const rplScaleIn = $('#fxRplScale'), rplScaleV = $('#fxRplScaleV');
  const rplGridIn = $('#fxRplGrid'), rplGridV = $('#fxRplGridV');
  const rplMtrIn = $('#fxRplMtr'), rplMtrV = $('#fxRplMtrV');
  const rplRndIn = $('#fxRplRnd'), rplRndV = $('#fxRplRndV');
  const rplMetalIn = $('#fxRplMetal'), rplMetalV = $('#fxRplMetalV');
  const tglRplSpin = $('#tglRplSpin');
  rplFreqIn.addEventListener('input', () => {
    const v = +rplFreqIn.value;
    rplFreqV.textContent = v + 's';
    app.settings.rplFreq = v;
    window.api.setSetting('rplFreq', v);
    applyRplCfg();
  });
  rplTiltIn.addEventListener('input', () => {
    const v = +rplTiltIn.value;
    rplTiltV.textContent = v;
    app.settings.rplTilt = v;
    window.api.setSetting('rplTilt', v);
    applyRplCfg();
  });
  rplGainIn.addEventListener('input', () => {
    const v = +rplGainIn.value;
    rplGainV.textContent = v + '%';
    app.settings.rplGain = v;
    window.api.setSetting('rplGain', v);
    applyRplCfg();
  });
  rplScaleIn.addEventListener('input', () => {
    const v = +rplScaleIn.value;
    rplScaleV.textContent = v + '%';
    app.settings.rplScale = v;
    window.api.setSetting('rplScale', v);
    applyRplCfg();
  });
  rplGridIn.addEventListener('input', () => {
    const v = +rplGridIn.value;
    rplGridV.textContent = v + '×' + v;
    app.settings.rplGrid = v;
    window.api.setSetting('rplGrid', v);
    applyRplCfg();
  });
  rplMtrIn.addEventListener('input', () => {
    const v = +rplMtrIn.value;
    rplMtrV.textContent = v === 0 ? '关' : v + '%';
    app.settings.rplMtr = v;
    window.api.setSetting('rplMtr', v);
    applyRplCfg();
  });
  rplRndIn.addEventListener('input', () => {
    const v = +rplRndIn.value;
    rplRndV.textContent = v + '%';
    app.settings.rplRnd = v;
    window.api.setSetting('rplRnd', v);
    applyRplCfg();
  });
  rplMetalIn.addEventListener('input', () => {
    const v = +rplMetalIn.value;
    rplMetalV.textContent = v + '%';
    app.settings.rplMetal = v;
    window.api.setSetting('rplMetal', v);
    applyRplCfg();
  });
  tglRplSpin.addEventListener('click', () => {
    const on = !tglRplSpin.classList.contains('on');
    tglRplSpin.classList.toggle('on', on);
    app.settings.rplSpin = on;
    window.api.setSetting('rplSpin', on);
    applyRplCfg();
    toast('地形自动旋转：' + (on ? '开' : '关'));
  });
  const rplInit = applyRplCfg(); // 启动恢复：应用持久化配置并回填滑块
  rplFreqIn.value = rplInit.freq; rplFreqV.textContent = rplInit.freq + 's';
  rplTiltIn.value = rplInit.tilt; rplTiltV.textContent = rplInit.tilt;
  rplGainIn.value = Math.round(rplInit.gain * 100); rplGainV.textContent = Math.round(rplInit.gain * 100) + '%';
  rplScaleIn.value = Math.round(rplInit.scale * 100); rplScaleV.textContent = Math.round(rplInit.scale * 100) + '%';
  rplGridIn.value = rplInit.grid; rplGridV.textContent = rplInit.grid + '×' + rplInit.grid;
  rplMtrIn.value = rplInit.mtrFreq; rplMtrV.textContent = rplInit.mtrFreq === 0 ? '关' : rplInit.mtrFreq + '%';
  rplRndIn.value = Math.round(rplInit.rnd * 100); rplRndV.textContent = Math.round(rplInit.rnd * 100) + '%';
  rplMetalIn.value = Math.round(rplInit.metal * 100); rplMetalV.textContent = Math.round(rplInit.metal * 100) + '%';
  tglRplSpin.classList.toggle('on', rplInit.spin);

  /* --- 预设分区：封面粒子场景（真 3D）：整体缩放 / 粒子密度 / 自动旋转+速度 ---
         写入 settings → scenes.setCoverConfig → mgr.coverCfg 每帧实时生效；粒子数量变化由场景内部重建 geometry */
  const PCV_CNT_MIN = 300, PCV_CNT_MAX = 99999; // 粒子数上下限（上限 99999）
  const PCV_LNK = Math.log(PCV_CNT_MAX / PCV_CNT_MIN);
  /* 滑块 0-100 ↔ 粒子数对数映射：线性滑块在 300-99999 跨四个数量级时低端几乎拉不开 */
  const pcvSliderToCount = (t) => Math.round(PCV_CNT_MIN * Math.exp((t / 100) * PCV_LNK));
  const pcvCountToSlider = (n) => Math.round((Math.log(clamp(n, PCV_CNT_MIN, PCV_CNT_MAX) / PCV_CNT_MIN) / PCV_LNK) * 100);
  const applyPcvCfg = () => {
    const scale = clamp(numOr(app.settings.pcvScale, 100) / 100, 0.5, 2);
    const count = Math.round(clamp(numOr(app.settings.pcvCount, 1000), PCV_CNT_MIN, PCV_CNT_MAX)); // 上限 99999
    const spin = app.settings.pcvSpin !== false;
    const spd = clamp(numOr(app.settings.pcvSpd, 30), 0, 100) / 100;
    scenes.setCoverConfig?.({ scale, count, spin, spd });
    return { scale, count, spin, spd };
  };
  const pcvScaleIn = $('#fxPcvScale'), pcvScaleV = $('#fxPcvScaleV');
  const pcvCountIn = $('#fxPcvCount'), pcvCountV = $('#fxPcvCountV');
  const pcvSpdIn = $('#fxPcvSpd'), pcvSpdV = $('#fxPcvSpdV');
  const tglPcvSpin = $('#tglPcvSpin');
  pcvScaleIn.addEventListener('input', () => {
    const v = +pcvScaleIn.value;
    pcvScaleV.textContent = v + '%';
    app.settings.pcvScale = v;
    window.api.setSetting('pcvScale', v);
    applyPcvCfg();
  });
  pcvCountIn.addEventListener('input', () => {
    const v = pcvSliderToCount(+pcvCountIn.value); // 滑块位（对数）→ 实际粒子数
    pcvCountV.textContent = v;
    app.settings.pcvCount = v;
    window.api.setSetting('pcvCount', v);
    applyPcvCfg();
  });
  pcvSpdIn.addEventListener('input', () => {
    const v = +pcvSpdIn.value;
    pcvSpdV.textContent = v;
    app.settings.pcvSpd = v;
    window.api.setSetting('pcvSpd', v);
    applyPcvCfg();
  });
  tglPcvSpin.addEventListener('click', () => {
    const on = !tglPcvSpin.classList.contains('on');
    tglPcvSpin.classList.toggle('on', on);
    app.settings.pcvSpin = on;
    window.api.setSetting('pcvSpin', on);
    applyPcvCfg();
    toast('粒子云自动旋转：' + (on ? '开' : '关'));
  });
  const pcvInit = applyPcvCfg(); // 启动恢复：应用持久化配置并回填控件
  pcvScaleIn.value = Math.round(pcvInit.scale * 100); pcvScaleV.textContent = Math.round(pcvInit.scale * 100) + '%';
  pcvCountIn.value = pcvCountToSlider(pcvInit.count); pcvCountV.textContent = pcvInit.count; // 回填存的是实际粒子数，滑块位反解
  pcvSpdIn.value = Math.round(pcvInit.spd * 100); pcvSpdV.textContent = Math.round(pcvInit.spd * 100);
  tglPcvSpin.classList.toggle('on', pcvInit.spin);

  /* --- 预设分区：圆环频谱脉冲强度（settings.ringPulse 50-200% → mgr.ringCfg.pulse） --- */
  const applyRingCfg = () => {
    const pulse = clamp(numOr(app.settings.ringPulse, 100) / 100, 0.5, 2);
    scenes.setRingConfig?.({ pulse });
    return pulse;
  };
  const ringPulseIn = $('#fxRingPulse'), ringPulseV = $('#fxRingPulseV');
  ringPulseIn.addEventListener('input', () => {
    const v = +ringPulseIn.value;
    ringPulseV.textContent = v + '%';
    app.settings.ringPulse = v;
    window.api.setSetting('ringPulse', v);
    applyRingCfg();
  });
  const ringInit = applyRingCfg(); // 启动恢复：应用持久化配置并回填滑块
  ringPulseIn.value = Math.round(ringInit * 100); ringPulseV.textContent = Math.round(ringInit * 100) + '%';

  /* --- 预设分区：CD弹出场景（旋转速度/弹出幅度/整体亮度，settings.aur* 百分比 → mgr.auroraCfg 每帧实时生效） --- */
  const applyAurCfg = () => {
    const spd = clamp(numOr(app.settings.aurSpd, 100) / 100, 0.2, 2);
    const den = clamp(numOr(app.settings.aurDen, 100) / 100, 0.4, 1.6);
    const brt = clamp(numOr(app.settings.aurBrt, 100) / 100, 0.5, 2);
    scenes.setAuroraConfig?.({ spd, den, brt });
    return { spd, den, brt };
  };
  const aurSpdIn = $('#fxAurSpd'), aurSpdV = $('#fxAurSpdV');
  const aurDenIn = $('#fxAurDen'), aurDenV = $('#fxAurDenV');
  const aurBrtIn = $('#fxAurBrt'), aurBrtV = $('#fxAurBrtV');
  aurSpdIn.addEventListener('input', () => {
    const v = +aurSpdIn.value;
    aurSpdV.textContent = v + '%';
    app.settings.aurSpd = v;
    window.api.setSetting('aurSpd', v);
    applyAurCfg();
  });
  aurDenIn.addEventListener('input', () => {
    const v = +aurDenIn.value;
    aurDenV.textContent = v + '%';
    app.settings.aurDen = v;
    window.api.setSetting('aurDen', v);
    applyAurCfg();
  });
  aurBrtIn.addEventListener('input', () => {
    const v = +aurBrtIn.value;
    aurBrtV.textContent = v + '%';
    app.settings.aurBrt = v;
    window.api.setSetting('aurBrt', v);
    applyAurCfg();
  });
  const aurInit = applyAurCfg(); // 启动恢复：应用持久化配置并回填滑块
  aurSpdIn.value = Math.round(aurInit.spd * 100); aurSpdV.textContent = Math.round(aurInit.spd * 100) + '%';
  aurDenIn.value = Math.round(aurInit.den * 100); aurDenV.textContent = Math.round(aurInit.den * 100) + '%';
  aurBrtIn.value = Math.round(aurInit.brt * 100); aurBrtV.textContent = Math.round(aurInit.brt * 100) + '%';

  /* --- 预设分区：迪斯科球（镜面数量/转速/光点大小，settings.flw* → mgr.flowCfg；数量变化场景内重建） --- */
  const applyFlwCfg = () => {
    const count = Math.round(clamp(numOr(app.settings.flwCount, 6000), 800, 15000));
    const spd = clamp(numOr(app.settings.flwSpd, 100) / 100, 0.2, 2);
    const size = clamp(numOr(app.settings.flwSize, 100) / 100, 0.5, 2);
    scenes.setFlowConfig?.({ count, spd, size });
    return { count, spd, size };
  };
  const flwCountIn = $('#fxFlwCount'), flwCountV = $('#fxFlwCountV');
  const flwSpdIn = $('#fxFlwSpd'), flwSpdV = $('#fxFlwSpdV');
  const flwSizeIn = $('#fxFlwSize'), flwSizeV = $('#fxFlwSizeV');
  flwCountIn.addEventListener('input', () => {
    const v = +flwCountIn.value;
    flwCountV.textContent = v;
    app.settings.flwCount = v;
    window.api.setSetting('flwCount', v);
    applyFlwCfg();
  });
  flwSpdIn.addEventListener('input', () => {
    const v = +flwSpdIn.value;
    flwSpdV.textContent = v + '%';
    app.settings.flwSpd = v;
    window.api.setSetting('flwSpd', v);
    applyFlwCfg();
  });
  flwSizeIn.addEventListener('input', () => {
    const v = +flwSizeIn.value;
    flwSizeV.textContent = v + '%';
    app.settings.flwSize = v;
    window.api.setSetting('flwSize', v);
    applyFlwCfg();
  });
  const flwInit = applyFlwCfg(); // 启动恢复
  flwCountIn.value = flwInit.count; flwCountV.textContent = flwInit.count;
  flwSpdIn.value = Math.round(flwInit.spd * 100); flwSpdV.textContent = Math.round(flwInit.spd * 100) + '%';
  flwSizeIn.value = Math.round(flwInit.size * 100); flwSizeV.textContent = Math.round(flwInit.size * 100) + '%';

  /* --- 预设分区：声波涟漪（波高/涟漪/流速，settings.wav* → mgr.waveCfg 每帧实时生效） --- */
  const applyWavCfg = () => {
    const amp = clamp(numOr(app.settings.wavAmp, 100) / 100, 0.3, 2);
    const rip = clamp(numOr(app.settings.wavRip, 100) / 100, 0, 2);
    const spd = clamp(numOr(app.settings.wavSpd, 100) / 100, 0.3, 2);
    scenes.setWaveConfig?.({ amp, rip, spd });
    return { amp, rip, spd };
  };
  const wavAmpIn = $('#fxWavAmp'), wavAmpV = $('#fxWavAmpV');
  const wavRipIn = $('#fxWavRip'), wavRipV = $('#fxWavRipV');
  const wavSpdIn = $('#fxWavSpd'), wavSpdV = $('#fxWavSpdV');
  wavAmpIn.addEventListener('input', () => {
    const v = +wavAmpIn.value;
    wavAmpV.textContent = v + '%';
    app.settings.wavAmp = v;
    window.api.setSetting('wavAmp', v);
    applyWavCfg();
  });
  wavRipIn.addEventListener('input', () => {
    const v = +wavRipIn.value;
    wavRipV.textContent = v + '%';
    app.settings.wavRip = v;
    window.api.setSetting('wavRip', v);
    applyWavCfg();
  });
  wavSpdIn.addEventListener('input', () => {
    const v = +wavSpdIn.value;
    wavSpdV.textContent = v + '%';
    app.settings.wavSpd = v;
    window.api.setSetting('wavSpd', v);
    applyWavCfg();
  });
  const wavInit = applyWavCfg(); // 启动恢复
  wavAmpIn.value = Math.round(wavInit.amp * 100); wavAmpV.textContent = Math.round(wavInit.amp * 100) + '%';
  wavRipIn.value = Math.round(wavInit.rip * 100); wavRipV.textContent = Math.round(wavInit.rip * 100) + '%';
  wavSpdIn.value = Math.round(wavInit.spd * 100); wavSpdV.textContent = Math.round(wavInit.spd * 100) + '%';

  /* --- 预设分区：粒子碰撞（数量/弹性/冲击波/拖影，settings.col* → mgr.collideCfg；数量变化场景内重建） --- */
  const applyColCfg = () => {
    const count = Math.round(clamp(numOr(app.settings.colCount, 1300), 300, 2400));
    const rest = clamp(numOr(app.settings.colRest, 92) / 100, 0.5, 1);
    const shock = clamp(numOr(app.settings.colShock, 100) / 100, 0, 2);
    const trail = clamp(numOr(app.settings.colTrail, 45) / 100, 0, 0.9);
    scenes.setCollideConfig?.({ count, rest, shock, trail });
    return { count, rest, shock, trail };
  };
  const colCountIn = $('#fxColCount'), colCountV = $('#fxColCountV');
  const colRestIn = $('#fxColRest'), colRestV = $('#fxColRestV');
  const colShockIn = $('#fxColShock'), colShockV = $('#fxColShockV');
  const colTrailIn = $('#fxColTrail'), colTrailV = $('#fxColTrailV');
  colCountIn.addEventListener('input', () => {
    const v = +colCountIn.value;
    colCountV.textContent = v;
    app.settings.colCount = v;
    window.api.setSetting('colCount', v);
    applyColCfg();
  });
  colRestIn.addEventListener('input', () => {
    const v = +colRestIn.value;
    colRestV.textContent = (v / 100).toFixed(2);
    app.settings.colRest = v;
    window.api.setSetting('colRest', v);
    applyColCfg();
  });
  colShockIn.addEventListener('input', () => {
    const v = +colShockIn.value;
    colShockV.textContent = v + '%';
    app.settings.colShock = v;
    window.api.setSetting('colShock', v);
    applyColCfg();
  });
  colTrailIn.addEventListener('input', () => {
    const v = +colTrailIn.value;
    colTrailV.textContent = v + '%';
    app.settings.colTrail = v;
    window.api.setSetting('colTrail', v);
    applyColCfg();
  });
  const colInit = applyColCfg(); // 启动恢复
  colCountIn.value = colInit.count; colCountV.textContent = colInit.count;
  colRestIn.value = Math.round(colInit.rest * 100); colRestV.textContent = colInit.rest.toFixed(2);
  colShockIn.value = Math.round(colInit.shock * 100); colShockV.textContent = Math.round(colInit.shock * 100) + '%';
  colTrailIn.value = Math.round(colInit.trail * 100); colTrailV.textContent = Math.round(colInit.trail * 100) + '%';

  /* --- 预设分区：微信对话（玻璃面板透明度，settings.wxOp 5-70 → body --wx-op，CSS 即时生效） --- */
  const applyWxCfg = () => {
    const op = Math.max(5, Math.min(70, Math.round(Number(app.settings.wxOp ?? 26))));
    document.body.style.setProperty('--wx-op', (op / 100).toFixed(2));
    return op;
  };
  const wxOpIn = $('#fxWxOp'), wxOpV = $('#fxWxOpV');
  wxOpIn.addEventListener('input', () => {
    const v = +wxOpIn.value;
    wxOpV.textContent = v + '%';
    app.settings.wxOp = v;
    window.api.setSetting('wxOp', v);
    applyWxCfg();
  });
  const wxOpInit = applyWxCfg(); // 启动恢复
  wxOpIn.value = wxOpInit; wxOpV.textContent = wxOpInit + '%';

  /* --- 预设分区：粒子能量场（数量/爆发强度/镜头震动，settings.fld* → mgr.fieldCfg；数量变化场景内重建） --- */
  const applyFldCfg = () => {
    const count = Math.round(clamp(numOr(app.settings.fldCount, 900), 300, 2400));
    const power = clamp(numOr(app.settings.fldPower, 100) / 100, 0.5, 2);
    const shake = clamp(numOr(app.settings.fldShake, 70) / 100, 0, 1);
    scenes.setFieldConfig?.({ count, power, shake });
    return { count, power, shake };
  };
  const fldCountIn = $('#fxFldCount'), fldCountV = $('#fxFldCountV');
  const fldPowerIn = $('#fxFldPower'), fldPowerV = $('#fxFldPowerV');
  const fldShakeIn = $('#fxFldShake'), fldShakeV = $('#fxFldShakeV');
  fldCountIn.addEventListener('input', () => {
    const v = +fldCountIn.value;
    fldCountV.textContent = v;
    app.settings.fldCount = v;
    window.api.setSetting('fldCount', v);
    applyFldCfg();
  });
  fldPowerIn.addEventListener('input', () => {
    const v = +fldPowerIn.value;
    fldPowerV.textContent = v + '%';
    app.settings.fldPower = v;
    window.api.setSetting('fldPower', v);
    applyFldCfg();
  });
  fldShakeIn.addEventListener('input', () => {
    const v = +fldShakeIn.value;
    fldShakeV.textContent = v + '%';
    app.settings.fldShake = v;
    window.api.setSetting('fldShake', v);
    applyFldCfg();
  });
  const fldInit = applyFldCfg(); // 启动恢复
  fldCountIn.value = fldInit.count; fldCountV.textContent = fldInit.count;
  fldPowerIn.value = Math.round(fldInit.power * 100); fldPowerV.textContent = Math.round(fldInit.power * 100) + '%';
  fldShakeIn.value = Math.round(fldInit.shake * 100); fldShakeV.textContent = Math.round(fldInit.shake * 100) + '%';

  /* --- 预设分区：镜像波形（波形幅度/辉光强度/粒子数量，settings.mir* → mgr.mirrorCfg 每帧实时生效） --- */
  const applyMirCfg = () => {
    const amp = clamp(numOr(app.settings.mirAmp, 100) / 100, 0.5, 2);
    const glow = clamp(numOr(app.settings.mirGlow, 100) / 100, 0.5, 2);
    const pcount = Math.round(clamp(numOr(app.settings.mirCount, 140), 0, 300));
    scenes.setMirrorConfig?.({ amp, glow, pcount });
    return { amp, glow, pcount };
  };
  const mirAmpIn = $('#fxMirAmp'), mirAmpV = $('#fxMirAmpV');
  const mirGlowIn = $('#fxMirGlow'), mirGlowV = $('#fxMirGlowV');
  const mirCountIn = $('#fxMirCount'), mirCountV = $('#fxMirCountV');
  mirAmpIn.addEventListener('input', () => {
    const v = +mirAmpIn.value;
    mirAmpV.textContent = v + '%';
    app.settings.mirAmp = v;
    window.api.setSetting('mirAmp', v);
    applyMirCfg();
  });
  mirGlowIn.addEventListener('input', () => {
    const v = +mirGlowIn.value;
    mirGlowV.textContent = v + '%';
    app.settings.mirGlow = v;
    window.api.setSetting('mirGlow', v);
    applyMirCfg();
  });
  mirCountIn.addEventListener('input', () => {
    const v = +mirCountIn.value;
    mirCountV.textContent = v;
    app.settings.mirCount = v;
    window.api.setSetting('mirCount', v);
    applyMirCfg();
  });
  const mirInit = applyMirCfg(); // 启动恢复
  mirAmpIn.value = Math.round(mirInit.amp * 100); mirAmpV.textContent = Math.round(mirInit.amp * 100) + '%';
  mirGlowIn.value = Math.round(mirInit.glow * 100); mirGlowV.textContent = Math.round(mirInit.glow * 100) + '%';
  mirCountIn.value = mirInit.pcount; mirCountV.textContent = mirInit.pcount;

  /* --- 高级分区：打开音源管理 --- */
  $('#btnFxSrcMgr')?.addEventListener('click', () => {
    els.fxPanel.classList.remove('open');
    openDrawer('src');
  });

  /* --- 高级分区：清除音频缓存 --- */
  $('#btnClearCache')?.addEventListener('click', async () => {
    try {
      const r = await window.api.audioCacheClear?.();
      if (!r || !r.count) { toast('缓存已是空的'); return; }
      const mb = (r.freed / 1048576).toFixed(1);
      toast(`已清除 ${r.count} 条缓存，释放 ${mb} MB${r.kept ? `（${r.kept} 条正在播放保留）` : ''}`);
    } catch { toast('清除失败'); }
  });

  /* --- 高级分区：关闭行为（每次询问 / 最小化到托盘 / 直接退出，主进程 closeAction 读取） --- */
  const applyCloseAct = (v) => {
    document.querySelectorAll('#closeActSeg .fx-ghost').forEach((b) => b.classList.toggle('active', b.dataset.ca === v));
  };
  document.querySelectorAll('#closeActSeg .fx-ghost').forEach((b) => b.addEventListener('click', () => {
    applyCloseAct(b.dataset.ca);
    app.settings.closeAction = b.dataset.ca;
    window.api.setSetting('closeAction', b.dataset.ca);
    toast('关闭行为：' + b.textContent);
  }));
  applyCloseAct(app.settings.closeAction || 'ask');

  /* --- 播放页（大封面 + 歌词，汽水音乐式） --- */
  els.btnNp.addEventListener('click', () => app.toggleNp());

  /* --- 歌词设置二级浮窗：顶栏「词」toggle（原设置中心「歌词」分区已迁入 #lyricPop，内部控件 id 不变）；
         打开时优先恢复记忆位置（settings.lyricPopPos，clamp 回视口），无记录则锚定「词」按钮下方；
         标题栏可拖拽（与设置中心同款交互），Esc / 点击浮窗外区域关闭，窗口缩放时复核位置 --- */
  const lyricPop = $('#lyricPop');
  const syncLyricPopActive = () => els.btnLyric.classList.toggle('active', lyricPop.classList.contains('open')); // 「词」按钮 active 态
  // 左上角定位 + 视口夹取（顶边 ≥52 避免钻入标题栏，四边留 8px）
  const clampPopPos = (x, y) => {
    const maxX = Math.max(8, window.innerWidth - lyricPop.offsetWidth - 8);
    const maxY = Math.max(52, window.innerHeight - lyricPop.offsetHeight - 8);
    lyricPop.style.left = `${Math.min(Math.max(x, 8), maxX)}px`;
    lyricPop.style.top = `${Math.min(Math.max(y, 52), maxY)}px`;
  };
  const placeLyricPop = () => {
    const p = app.settings.lyricPopPos;
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) { clampPopPos(p.x, p.y); return; }
    const r = els.btnLyric.getBoundingClientRect();
    clampPopPos(r.left + r.width / 2 - lyricPop.offsetWidth / 2, r.bottom + 8);
  };
  const closeLyricPop = () => { lyricPop.classList.remove('open'); syncLyricPopActive(); };
  els.btnLyric.addEventListener('click', () => {
    const opening = !lyricPop.classList.contains('open');
    if (opening) { // 二级菜单互斥：一次只开一个
      els.fxPanel.classList.remove('open');
      els.drawer.classList.remove('open');
      closeLoginPop();
    }
    lyricPop.classList.toggle('open');
    if (opening) placeLyricPop();
    syncLyricPopActive();
  });
  // 标题栏拖拽：pointer 事件 + setPointerCapture，关闭按钮除外；结束记忆位置（拖拽结束才写，实时跟手不落盘）
  const popHeadEl = lyricPop.querySelector('.lyric-pop-head');
  let popDrag = null;
  popHeadEl.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target.closest('#lyricPopClose')) return;
    const r = lyricPop.getBoundingClientRect();
    popDrag = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    popHeadEl.setPointerCapture(e.pointerId); // 指针移出浮窗也持续跟踪
    document.body.classList.add('fx-dragging'); // 复用设置中心拖拽态：禁文本选中 + grabbing 光标
  });
  popHeadEl.addEventListener('pointermove', (e) => {
    if (popDrag) clampPopPos(e.clientX - popDrag.dx, e.clientY - popDrag.dy);
  });
  const endPopDrag = () => {
    if (!popDrag) return;
    popDrag = null;
    document.body.classList.remove('fx-dragging');
    app.settings.lyricPopPos = { x: parseFloat(lyricPop.style.left), y: parseFloat(lyricPop.style.top) };
    window.api.setSetting('lyricPopPos', app.settings.lyricPopPos); // 位置记忆
  };
  popHeadEl.addEventListener('pointerup', endPopDrag);
  popHeadEl.addEventListener('pointercancel', endPopDrag);
  $('#lyricPopClose')?.addEventListener('click', closeLyricPop);
  document.addEventListener('click', (e) => { // 点击浮窗外区域关闭（捕获阶段，不受内部 stopPropagation 影响）
    if (lyricPop.classList.contains('open') && !lyricPop.contains(e.target) && !els.btnLyric.contains(e.target)) closeLyricPop();
  }, true);
  document.addEventListener('keydown', (e) => { // Esc 优先关浮窗，阻断后续全局 Esc（避免同时收起播放页等）
    if (e.key === 'Escape' && lyricPop.classList.contains('open')) { closeLyricPop(); e.stopPropagation(); }
  }, true);
  window.addEventListener('resize', () => { if (lyricPop.classList.contains('open')) placeLyricPop(); });

  /* --- 账号登录浮窗：顶栏「登录」toggle → 二级「选择平台」→ 三级「二维码」同窗内切换；
         扫码全程由主进程托管（start-qr-login）：双平台均为后台隐藏窗口打开官方登录网页，
         从页面抓取/截屏二维码（不使用官方接口）；登录识别靠主进程轮询会话 Cookie 与页面文本；
         状态变化经 login-qr-update / login-success 事件推送，渲染层不轮询；
         全程只显示二维码本身，不打开任何网页窗口 --- */
  const loginPop = els.loginPop;
  let closeLoginPop = () => {}; // 未找到浮窗时降级空操作，供其它菜单互斥调用
  if (loginPop) {
    const platView = $('#loginPlatView');
    const qrView = $('#loginQrView');
    const qrImg = $('#loginQrImg');
    const qrPh = $('#loginQrPh');
    const qrName = $('#loginQrName');
    const qrHint = $('#loginQrHint');
    const qrStatus = $('#loginQrStatus');
    const qrRefresh = $('#loginQrRefresh');
    const qrBack = $('#loginQrBack');
    const popTitle = $('#loginPopTitle');
    let curPlat = null;  // 当前正在扫码的平台 { id, name }
    let qrSeq = 0;       // 扫码会话序号：防止快速重复点刷新时旧响应把旧码画回界面
    let qrToken = null;  // 主进程当前会话 token：丢弃旧会话迟到的刷新/状态事件

    const syncLoginActive = () => els.btnLogin.classList.toggle('active', loginPop.classList.contains('open'));
    // 锚定「登录」按钮下方并夹取回视口（顶边 ≥52 避免钻入标题栏）
    const placeLoginPop = () => {
      const r = els.btnLogin.getBoundingClientRect();
      const maxX = Math.max(8, window.innerWidth - loginPop.offsetWidth - 8);
      loginPop.style.left = `${Math.min(Math.max(r.left + r.width / 2 - loginPop.offsetWidth / 2, 8), maxX)}px`;
      loginPop.style.top = `${r.bottom + 8}px`;
    };

    /** 按需让主进程销毁后台扫码会话（返回 / 关窗 / 刷新时调用） */
    const stopQr = async (cancel = true) => {
      if (cancel && curPlat) { try { await window.api.qrLoginCancel(curPlat.id); } catch { /* noop */ } }
    };
    const showQrStatus = (text, warn = false) => {
      if (!qrStatus) return;
      qrStatus.textContent = text;
      qrStatus.classList.toggle('warn', !!warn);
    };
    /** 二维码画面：宿主已给图片直接展示，纯文本用内置 qrcode.js 本地生成 */
    const paintQr = (src) => {
      if (!qrImg) return;
      if (src) { qrImg.src = src; qrImg.classList.add('on'); if (qrPh) qrPh.hidden = true; }
      else { qrImg.removeAttribute('src'); qrImg.classList.remove('on'); if (qrPh) qrPh.hidden = false; }
    };
    const textToQr = (text) => {
      if (typeof window.qrcode !== 'function' || !text) return '';
      try {
        const q = window.qrcode(0, 'M'); // typeNumber 0 = 按内容长度自动选版本
        q.addData(text);
        q.make();
        return q.createDataURL(6, 2);
      } catch { return ''; }
    };
    /** 回到二级「选择平台」视图 */
    const showPlatView = async () => {
      await stopQr();
      curPlat = null;
      qrView?.classList.add('hidden');
      platView?.classList.remove('hidden');
      qrBack?.classList.add('hidden');
      if (popTitle) popTitle.textContent = '账号登录';
      renderLoginList();
    };
    /* 关闭浮窗只收起界面，**不销毁**主进程扫码会话：否则随手点一下屏幕就把二维码作废，
       手机上再确认也回不来（这是 QQ 扫码反复失败的主因）。会话保留到扫码成功或过期。 */
    closeLoginPop = () => {
      qrView?.classList.add('hidden');
      platView?.classList.remove('hidden');
      qrBack?.classList.add('hidden');
      if (popTitle) popTitle.textContent = '账号登录';
      loginPop.classList.remove('open');
      syncLoginActive();
    };

    /** 发起 / 刷新扫码：进入三级二维码视图；后续状态由主进程事件推送（login-qr-update / login-success） */
    const startQr = async (plat) => {
      const mySeq = ++qrSeq;
      qrToken = null;
      await stopQr(); // 刷新时先结束上一会话
      curPlat = plat;
      qrView?.classList.remove('hidden');
      platView?.classList.add('hidden');
      qrBack?.classList.remove('hidden');
      if (popTitle) popTitle.textContent = '扫码登录';
      if (qrName) qrName.textContent = plat.name;
      if (qrHint) qrHint.textContent = plat.hint || '';
      qrRefresh?.classList.add('hidden');
      paintQr('');
      showQrStatus('正在获取二维码…');
      let r;
      try { r = await window.api.qrLoginStart(plat.id); } catch (e) { r = { ok: false, msg: e.message }; }
      if (mySeq !== qrSeq || !curPlat || curPlat.id !== plat.id) return; // 已被更新的一次发起顶掉，旧响应不得回画
      if (!r?.ok) { showQrStatus(r?.msg || '二维码获取失败', true); qrRefresh?.classList.remove('hidden'); return; }
      qrToken = r.qrToken || null;
      if (r.hint && qrHint) qrHint.textContent = r.hint;
      if (r.reused) { showQrStatus(r.msg || '登录态仍有效，已直接复用'); return; } // 凭证未过期：主进程直接完成登录
      if (r.webWindow) { showQrStatus('已打开 QQ音乐官方登录窗口，请在窗口内完成登录'); return; } // 网页登录：二维码在官方窗口里
      if (r.debugWindow) { showQrStatus('调试窗口已打开，请在窗口中手动登录'); return; } // 诊断模式：不开码，改用可见窗口
      const src = r.qrSrc || textToQr(r.content); // QQ 直接给 img src；网易云给纯文本本地生成
      paintQr(src);
      if (!src) { showQrStatus('二维码渲染失败', true); qrRefresh?.classList.remove('hidden'); return; }
      showQrStatus('等待扫码…');
    };

    /* 主进程事件订阅（一次性）：二维码刷新 / 已扫待确认 / 已过期 */
    window.api.onLoginQrUpdate((d) => {
      if (!curPlat || !d || d.platform !== curPlat.id) return;
      if (d.token && qrToken && d.token !== qrToken) return; // 旧会话迟到事件
      if (d.type === 'refresh' && d.qrSrc) { paintQr(d.qrSrc); showQrStatus('等待扫码…'); return; }
      if (d.type === 'scanned') { showQrStatus('已扫描，请在手机上确认登录'); return; }
      if (d.type === 'expired') { // 会话已被主进程关闭；保留 curPlat 供「刷新二维码」重新发起
        showQrStatus('二维码已过期，请刷新后重试', true);
        qrRefresh?.classList.remove('hidden');
      }
      if (d.type === 'closed') { // 官方登录窗口被用户关闭，登录未完成
        showQrStatus('登录窗口已关闭，登录未完成', true);
        qrRefresh?.classList.remove('hidden');
      }
    });
    window.api.onLoginSuccess((info) => {
      if (!info || !info.platform) return;
      const sid = info.platform === 'qqmusic' ? 'qq' : info.platform;
      const nm = (curPlat && curPlat.id === info.platform) ? curPlat.name : (info.name || info.platform);
      // 浮窗可能已被收起：登录成功必须照常收尾（弹提示、回显登录态、拉云歌单、刷首页）
      if (curPlat && curPlat.id === info.platform) { curPlat = null; showPlatView(); }
      const nick = info.profile?.nickname;
      toast(`「${nm}」登录成功${nick ? `：${nick}` : ''}，VIP 歌曲已解锁`);
      // 确定性事件：Cookie 落库成功后立即拉账号云歌单 + 刷新首页（登录态解锁更多曲目）
      app.refreshAccountPls?.(sid ? [sid] : undefined);
      app.reloadFeed?.();
    });

    /** 渲染平台列表：内置双平台（网易云 / QQ音乐）恒在、不依赖音源插件，并回显登录态；
        平台前带单选圆点：选中后首页推荐歌单/热歌与账号歌单跟随该平台（defaultSource） */
    const renderLoginList = async () => {
      const box = $('#loginPlatList');
      if (!box) return;
      let plats = [];
      try { plats = await window.api.sourceLoginPlatforms(); } catch { /* noop */ }
      let defSrc = '';
      try { defSrc = (await window.api.sourceConfigGet())?.defaultSource || 'netease'; } catch { /* noop */ }
      /** 选中平台：切 defaultSource → 首页 feed（推荐歌单+热歌）与「我的歌单」账号分组跟随该平台 */
      const pickDefault = async (s) => {
        const sid = s.id === 'qqmusic' ? 'qq' : s.id;
        if (sid === defSrc) return;
        try { await window.api.sourceConfigSet({ defaultSource: sid }); } catch { /* noop */ }
        defSrc = sid;
        app.refreshAccountPls?.();   // 双平台云歌单继续缓存，切换平台即时可见
        app.syncDefaultSrc?.();      // 我的歌单只保留当前平台那一组
        app.reloadFeed?.();
        toast(`已选中「${s.name}」：首页推荐、热歌榜与账号歌单已切换`);
        renderLoginList(); // 回显选中态
      };
      box.innerHTML = '';
      if (!plats.length) {
        const empty = document.createElement('div');
        empty.className = 'fx-note';
        empty.textContent = '暂无可登录的平台';
        box.appendChild(empty);
        return;
      }
      for (const s of plats) {
        const off = s.kind === 'none'; // 平台官方扫码页失效 → 置灰不可点
        const sid = s.id === 'qqmusic' ? 'qq' : s.id;
        const isDefault = sid === defSrc;
        const row = document.createElement('div');
        row.className = 'login-row';
        const pick = document.createElement('button');
        pick.className = 'login-pick' + (isDefault ? ' on' : '');
        pick.title = isDefault ? `当前首页加载「${s.name}」的歌单与推荐` : `选中后首页加载「${s.name}」的歌单与推荐`;
        pick.addEventListener('click', (e) => { e.stopPropagation(); pickDefault(s); });
        row.appendChild(pick);
        const btn = document.createElement('button');
        btn.className = 'login-plat' + (s.loggedIn ? ' on' : '') + (off ? ' off' : '');
        btn.title = off ? (s.hint || '暂不支持扫码登录')
          : (s.loggedIn ? `重新扫码登录「${s.name}」` : `扫码登录「${s.name}」`);
        const prof = s.loggedIn && s.profile ? s.profile : null;
        if (prof?.avatar) { // 已登录：显示抓取的账号头像
          const av = document.createElement('img');
          av.className = 'login-avatar';
          av.referrerPolicy = 'no-referrer';
          av.src = prof.avatar;
          av.alt = '';
          av.draggable = false;
          btn.appendChild(av);
        }
        const nm = document.createElement('b');
        nm.textContent = s.name;
        const st = document.createElement('span');
        st.textContent = off ? '暂不可用'
          : (s.loggedIn ? `已登录${prof?.nickname ? ` · ${prof.nickname}` : ''}` : '未登录');
        btn.append(nm, st);
        btn.addEventListener('click', () => {
          if (off) { toast(s.hint || `「${s.name}」暂不支持扫码登录`, 4600); return; }
          startQr(s);
        });
        row.appendChild(btn);
        if (s.loggedIn) { // 已登录的行附带退出入口（清空该音源 Cookie，回落匿名态）
          const out = document.createElement('button');
          out.className = 'login-out';
          out.textContent = '退出';
          out.title = '退出登录（清空该音源账号 Cookie）';
          out.addEventListener('click', async () => {
            await window.api.sourceLogout(s.id);
            const sid = s.id === 'qqmusic' ? 'qq' : s.id;
            app.clearAccountPls?.(sid);
            app.reloadFeed?.();
            toast(`「${s.name}」已退出登录，后续请求回落匿名态`);
            renderLoginList();
          });
          row.appendChild(out);
        }
        box.appendChild(row);
      }
    };

    els.btnLogin.addEventListener('click', () => {
      const opening = !loginPop.classList.contains('open');
      if (opening) { // 二级菜单互斥：一次只开一个
        els.fxPanel.classList.remove('open');
        els.drawer.classList.remove('open');
        closeLyricPop();
      }
      loginPop.classList.toggle('open');
      if (opening) { placeLoginPop(); showPlatView(); }
      syncLoginActive();
    });
    qrBack?.addEventListener('click', () => showPlatView());
    qrRefresh?.addEventListener('click', () => { if (curPlat) startQr(curPlat); });
    $('#loginPopClose')?.addEventListener('click', () => closeLoginPop());
    document.addEventListener('pointerdown', (e) => {
      if (loginPop.classList.contains('open') && !loginPop.contains(e.target) && !els.btnLogin.contains(e.target)) closeLoginPop();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && loginPop.classList.contains('open')) { closeLoginPop(); e.stopPropagation(); }
    }, true);
    window.addEventListener('resize', () => { if (loginPop.classList.contains('open')) placeLoginPop(); });
  }

  /* --- 抽屉 & 标签页 --- */
  const openDrawer = (tab) => {
    els.drawer.classList.add('open');
    els.fxPanel.classList.remove('open');
    closeLyricPop(); // 二级菜单互斥：一次只开一个
    closeLoginPop();
    if (tab) switchTab(tab);
  };
  const switchTab = (tab) => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('#tab-list').classList.toggle('hidden', tab !== 'list');
    $('#tab-pl').classList.toggle('hidden', tab !== 'pl');
    $('#tab-src').classList.toggle('hidden', tab !== 'src');
  };
  els.btnList.addEventListener('click', () => {
    els.fxPanel.classList.remove('open');
    closeLyricPop(); // 二级菜单互斥：一次只开一个
    closeLoginPop();
    els.drawer.classList.toggle('open');
  });
  els.btnCloseDrawer.addEventListener('click', () => els.drawer.classList.remove('open'));
  document.querySelectorAll('.tab-btn[data-tab]').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  /* --- 导入 --- */
  els.btnImport.addEventListener('click', async () => {
    const paths = await window.api.openAudioDialog();
    if (paths.length) await app.importPaths(paths);
  });
  els.btnImportDir.addEventListener('click', async () => {
    const paths = await window.api.openAudioFolder();
    if (paths.length) await app.importPaths(paths);
    else if (paths && !paths.length) toast('该文件夹未找到音频文件');
  });
  /* 设置中心「高级 · 本地曲库」导入入口：与抽屉按钮同一链路 */
  els.btnFxImport?.addEventListener('click', async () => {
    const paths = await window.api.openAudioDialog();
    if (paths.length) await app.importPaths(paths);
  });
  els.btnFxImportDir?.addEventListener('click', async () => {
    const paths = await window.api.openAudioFolder();
    if (paths.length) await app.importPaths(paths);
    else if (paths && !paths.length) toast('该文件夹未找到音频文件');
  });
  els.btnClearList.addEventListener('click', () => { engine.clear(); app.saveSettings(); });

  /* --- 引擎事件 --- */
  engine.addEventListener('queue', () => {
    renderLocalList(els.playList, engine.queue, engine.index, {
      play: (i) => engine.playIndex(i),
      remove: (i) => engine.removeAt(i)
    });
    els.listEmpty.style.display = engine.queue.length ? 'none' : '';
    renderMyPl(); // 本地歌曲卡跟随队列增减
    app.saveSettings();
  });
  /* --- 封面统一更新：底栏缩略图 / 播放页大封面 / 氛围色晕层 --- */
  const updateCoverViews = (t) => {
    const src = t?.coverBlob || t?.coverUrl || '';
    const shown = src || COVER_FALLBACK;
    const onErr = (e) => { e.currentTarget.onerror = null; e.currentTarget.src = COVER_FALLBACK; };
    els.coverThumb.onerror = onErr;
    els.coverThumb.src = shown;
    els.coverThumb.style.visibility = 'visible';
    els.npCover.onerror = onErr;
    els.npCover.src = shown;
    els.npCover.style.visibility = 'visible';
    document.getElementById('np').classList.toggle('no-cover', !src);
    // 播放时不把封面加载到主页面背景（保留底栏缩略图与播放页大封面即可）
    els.albumBg.classList.remove('on');
    els.albumBg.style.backgroundImage = '';
  };

  engine.addEventListener('track', () => {
    const t = engine.current;
    document.body.classList.toggle('has-track', !!t); // 有曲目时主页也显示底部控制器
    els.tTitle.textContent = t ? t.title : '未播放';
    els.tArtist.textContent = t ? t.artist || '' : '从首页开始 · 拖入音乐或在线搜索';
    updateCoverViews(t);
    els.npTitle.textContent = t ? t.title : '未播放';
    els.npArtist.textContent = t ? [t.artist, t.album].filter(Boolean).join(' · ') : '播放音乐时这里会展示封面与歌词';
    document.title = t ? `${t.title} · 律动 RhythmViz` : '律动 RhythmViz';
    if (t) {
      // 视图记忆（用户要求 2026-10-14）：切歌不再自动弹播放页 ——
      // np 开着 → 保持打开并自动刷新内容；没开 → 维持当前视图
      // （主页 / 视觉场景 / 歌词MV 现在看什么，下一首还是什么，不用重新点）
      if (app.npOpen || t.source === 'demo') document.body.classList.remove('home-active');
      // 切歌同步歌词：有缓存立即显示；未加载先清空（避免残留上一首），加载完成由 lyric 事件刷新
      if (t.lyricText != null) app.setLyric(t.lyricText, t.transText, t.pureMusic);
      else if (t.source !== 'demo') app.lyrics.clear();
    }
    renderHomeRecent(app);
    app._syncFolia?.(); // 歌单拼图：切歌时刷新正在播放封面标记与内嵌控制器
  });
  engine.addEventListener('cover', () => {
    const t = engine.current;
    if (!t) return;
    updateCoverViews(t);
    scenes.setCoverFromTrack(t);
    app.theme?.applyFromTrack(t); // 封面取色 → 自适应主题
  });
  engine.addEventListener('lyric', () => {
    const t = engine.current;
    if (t?.lyricText != null) app.setLyric(t.lyricText, t.transText, t.pureMusic);
  });
  engine.addEventListener('state', () => {
    els.play.textContent = engine.playing ? '⏸' : '▶';
    window.api.sendMiniState?.({ title: engine.current?.title, artist: engine.current?.artist, playing: engine.playing });
  });
  engine.addEventListener('error', (e) => toast(e.detail?.msg || '播放失败'));
  // 在线加载/缓冲指示：播放按钮呼吸转圈
  engine.addEventListener('loading', (e) => document.body.classList.toggle('buffering', !!e.detail?.on));
  engine.addEventListener('palette', () => { /* CSS 变量已由引擎更新 */ });

  /* --- 每帧：进度 & 歌词 --- */
  // 舞台歌词：侧边竖排堆叠悬浮列（播放页/首页/PV与反应堆场景时隐藏）
  // 结构：#stageLyric（贴边定位）> #stageLyricTilt（倾斜+上下渐隐 mask）> #stageLyricStack（JS 驱动 translateY 上滚）
  const slBox = $('#stageLyric'), slTilt = $('#stageLyricTilt'), slStack = $('#stageLyricStack'), slPh = $('#stageLyricPh');
  let slLineEls = [];      // 行 div 缓存（与 app.lyrics.lines 一一对应）
  let slOffsets = [0];     // 每行顶部累计偏移（px），实测行高累加（带翻译的行更高）
  let slTextMetrics = [];  // 每行卡拉OK填充素材 { l: 文字左起, w: 文字宽, cw: 容器宽 }（布局单位）
  let slCurLines = null;   // 当前行数组引用：换歌（引用变化）才重建 DOM
  let slIdx = -999;        // 上次高亮行：activeIdx 变化才重排类名与滚动，绝不每帧重建
  let slLastLt = -999;     // 上一帧歌词时间：seek 跳变检测（跳变时滚动瞬移，不做 0.62s 缓动爬行）

  /* 构建整列行 DOM（换歌时调用一次）：原文一行，带翻译的行下挂小字翻译行；
     每行内含 .sl-base（底色）+ .sl-fill（卡拉OK亮色填充层，宽度由 --sl-lit/--sl-cn 驱动 clip） */
  const slBuild = () => {
    slStack.innerHTML = '';
    slLineEls = [];
    for (const line of app.lyrics.lines) {
      const div = document.createElement('div');
      div.className = 'sl-row';
      const t = document.createElement('span');
      t.className = 'sl-t';
      // 间奏空行：占位音符，不留白
      const text = line.text.trim() ? line.text : '♪';
      const chars = [...text];
      const base = document.createElement('span'); base.className = 'sl-base';
      const fill = document.createElement('span'); fill.className = 'sl-fill';
      for (const ch of chars) {
        const bs = document.createElement('span'); bs.className = 'sl-char';
        bs.textContent = ch === ' ' ? '\u00A0' : ch;
        base.appendChild(bs);
        fill.appendChild(bs.cloneNode(true));
      }
      t.appendChild(base); t.appendChild(fill);
      div.appendChild(t);
      if (line.trans) {
        const tr = document.createElement('span');
        tr.className = 'sl-tr';
        tr.textContent = line.trans;
        div.appendChild(tr);
      }
      slStack.appendChild(div);
      slLineEls.push(div);
    }
    // 实测行高（rAF 等一帧布局 + 延迟复核兜底字体异步加载导致的行高变化）
    slMeasure();
    requestAnimationFrame(slMeasure);
    setTimeout(slMeasure, 400);
  };

  /* 逐行累计 offsetHeight → slOffsets（行布局字号统一、state 只用 transform，行高恒定可安全缓存）；
     同时缓存卡拉OK逐字裁剪所需的「文字左起 / 文字宽 / 容器宽」。
     必须用 offsetLeft/offsetWidth（布局空间，不受祖先任何 transform 影响）：旧版用
     getBoundingClientRect ÷ 行缩放反推，面板一绕中间轴旋转，横向尺寸还会乘 cosθ 且带透视非线性
     → 逐字进度立刻错位。offset* 直接给出行内文字在 .sl-t 里的真实起止，任意角度都稳。 */
  function slMeasure() {
    let y = 0;
    slOffsets = [0];
    slTextMetrics = [];
    for (const el of slLineEls) {
      y += el.offsetHeight;
      slOffsets.push(y);
      const t = el.querySelector('.sl-t'), b = el.querySelector('.sl-base');
      if (!t || !b) { slTextMetrics.push(null); continue; }
      const cw = t.offsetWidth, l = b.offsetLeft, w = b.offsetWidth;
      slTextMetrics.push((cw > 0 && w > 0 && isFinite(l) && isFinite(w))
        ? { l, w, cw }
        : null);
    }
  }

  /* 滚动定位：当前行中心恒贴容器中线 —— 滚动层自身 top:50% 已提供半高偏移，
     位移只需行中心的内容 offset（再减容器半高会把当前行钉到容器底边）；
     anim=false 时瞬时归位（重建/改行数），true 走 CSS transition 上滚 */
  const slScrollTo = (idx, anim) => {
    if (idx < 0 || idx >= slLineEls.length || slOffsets.length < 2) return;
    const h = slOffsets[idx + 1] - slOffsets[idx];
    const y = slOffsets[idx] + h / 2;
    slStack.classList.toggle('sl-noanim', !anim);
    slStack.style.transform = `translateY(${(-y).toFixed(1)}px)`;
    if (!anim) { void slStack.offsetWidth; slStack.classList.remove('sl-noanim'); } // 瞬移后恢复过渡
  };

  const updateStageLyric = () => {
    const t = engine.current;
    const show = !app.npOpen
      && !document.body.classList.contains('home-active')
      && scenes.current !== 'pv' && scenes.current !== 'reactor' // PV 字幕 / 反应堆（3D 地形）场景自带大字歌词，避免重复
      && scenes.current !== 'wxchat'                             // 微信对话场景歌词打在气泡里，悬浮歌词整列隐藏
      && !!t?.lyricText
      && app.lyrics.lines.length > 0;
    slBox.classList.toggle('on', !!show);
    if (!show) { slIdx = -999; return; }
    // 换歌（lines 引用变化）才重建整列 DOM；activeIdx 变化只改类名 + 滚动位移
    if (app.lyrics.lines !== slCurLines) {
      slCurLines = app.lyrics.lines;
      slBuild();
      slIdx = -999; // 强制下方重排
    }
    // 行数设置改变容器高度（_slDirty 由设置区写入）→ 中线不变但偏移要重贴
    if (app._slDirty) { app._slDirty = false; slMeasure(); slScrollTo(slIdx, false); }
    const idx = app.lyrics.activeIdx;
    // seek 跳变检测：时间位移 >1.2s 视为拖拽 → 行滚动瞬移归位，不做缓动爬行
    const ltNow = engine.time - (app.lyricOffset || 0);
    const slJumped = slLastLt > -900 && Math.abs(ltNow - slLastLt) > 1.2;
    slLastLt = ltNow;
    // 卡拉OK逐字进度：每帧算当前行已点亮字符数（浮点）→ 换算成 px 裁剪边界写 --sl-fill-l/-r
    // 双轨：字级（YRC/TTML）逐字推进；行级（纯 LRC）按整行窗口比例填充（.sl-fill 是行级擦除）
    const karaokeOn = app.settings.slKaraoke === true;
    if (karaokeOn && idx >= 0 && slLineEls[idx]) {
      const line = app.lyrics.lines[idx];
      const chars = line?.chars || [];
      const lt = ltNow;
      let litN = 0;
      if (line?.words) {
        for (let i = 0; i < chars.length; i++) {
          const c = chars[i];
          if (lt >= c.end) litN = i + 1;
          else if (lt >= c.t) { litN = i + (lt - c.t) / Math.max(0.05, c.end - c.t); break; }
          else break;
        }
      } else if (chars.length) {
        const T = line.time, E = Math.max(line.time + 0.3, line.end);
        const frac = E > T ? Math.min(1, Math.max(0, (lt - T) / (E - T))) : 1;
        litN = frac * chars.length;
      }
      // 逐字浇光边界（px）：按文字自身起止（布局空间实测）裁剪 .sl-fill —— 亮区永远压在字形内
      const el = slLineEls[idx];
      const mt = slTextMetrics[idx];
      if (mt) {
        const litPx = (litN / (chars.length || 1)) * mt.w;
        el.style.setProperty('--sl-fill-l', mt.l.toFixed(1) + 'px');
        el.style.setProperty('--sl-fill-r', Math.max(0, mt.cw - mt.l - litPx).toFixed(1) + 'px');
      }
    }
    if (idx === slIdx) return;
    slIdx = idx;
    // 距离阶梯类名：d0 当前行 / d1-d3 邻行 / far 窗口外余行（CSS 按档渐暗渐小）
    for (let i = 0; i < slLineEls.length; i++) {
      const d = idx < 0 ? 99 : Math.abs(i - idx); // 前奏无活动行：全部归 far，让位给 ♪ 占位
      const el = slLineEls[i];
      el.classList.toggle('d0', d === 0);
      el.classList.toggle('d1', d === 1);
      el.classList.toggle('d2', d === 2);
      el.classList.toggle('d3', d === 3);
      el.classList.toggle('far', d > 3);
      if (i !== idx) {
        el.style.removeProperty('--sl-fill-l'); el.style.removeProperty('--sl-fill-r');
      }
    }
    slPh.classList.toggle('on', idx < 0);
    if (idx >= 0) slScrollTo(idx, !slJumped); // seek 跳变 → 瞬移归位；正常推进 → 0.62s 平滑上滚
  };
  /* ================= 微信对话场景：气泡打出歌词（我一句对面一句） =================
     数据源与舞台悬浮歌词完全同源（app.lyrics + engine.time - lyricOffset）：
     activeIdx 推进到第 i 行 → 该行作为一条「微信消息」逐字打出（打字速度对齐行时长），
     只显示已打出的歌词（未来行不进列表）；时不时随机一方发一只噜噜表情包（不占轮流）；
     seek 回跳 → 清空重打；换歌 → 换 CD/背景/聊天名并清空记录；此场景隐藏悬浮歌词。 */
  const wxBox = $('#wxChat'), wxBg = $('#wxBg'), wxList = $('#wxList'),
    wxCdImg = $('#wxCdImg'), wxTitleEl = $('#wxTitle'), wxArtistEl = $('#wxArtist'), wxChatName = $('#wxChatName');
  // 噜噜表情包：内置 20 张本地贴纸（assets/stickers/，随应用打包，离线可用），随机抽取发送
  const WX_STICKERS = Array.from({ length: 20 }, (_, i) => `assets/stickers/lulu-${i + 1}.jpg`);
  // 贴纸随机动效类（CSS 循环动画，模拟微信动态表情）
  const WX_ANIMS = ['wx-a-bounce', 'wx-a-swing', 'wx-a-wobble', 'wx-a-pulse', 'wx-a-rock', 'wx-a-nod'];
  let wxTrack = null, wxCover = '', wxLines = null, wxIdx = -1, wxSide = false, wxLastLt = -999, wxCur = null, wxSinceStick = 0;
  const wxScrollEnd = () => { wxList.scrollTop = wxList.scrollHeight; };
  const wxPushMsg = (me, sticker) => {
    const row = document.createElement('div');
    row.className = 'wx-msg ' + (me ? 'me' : 'ta');
    const ava = document.createElement('span');
    ava.className = 'wx-ava';
    if (me) ava.textContent = '我';
    else {
      const im = document.createElement('img');
      im.src = wxCover || COVER_FALLBACK;
      im.onerror = () => { im.onerror = null; im.src = COVER_FALLBACK; };
      ava.appendChild(im);
    }
    row.appendChild(ava);
    let bubble = null;
    if (sticker) {
      const img = document.createElement('img');
      img.className = 'wx-sticker ' + WX_ANIMS[(Math.random() * WX_ANIMS.length) | 0];
      img.alt = '噜噜';
      img.src = sticker;
      row.appendChild(img);
    } else {
      bubble = document.createElement('span');
      bubble.className = 'wx-bubble';
      row.appendChild(bubble);
    }
    wxList.appendChild(row);
    while (wxList.children.length > 42) wxList.firstChild.remove();   // 限制 DOM 规模
    wxScrollEnd();
    return bubble;
  };
  // 新歌词行 → 交替一方开始打字；时不时先丢一只噜噜
  const wxStartLine = (line, lt) => {
    if (wxSinceStick >= 2 && Math.random() < 0.16) {
      wxPushMsg(Math.random() < 0.5, WX_STICKERS[(Math.random() * WX_STICKERS.length) | 0]);
      wxSinceStick = 0;
    }
    wxSide = !wxSide;
    const el = wxPushMsg(wxSide);
    wxSinceStick++;
    if (!el) { wxCur = null; return; }
    const text = String(line.text || '');
    const t0 = Math.max(lt, line.time);
    const dur = Math.max(0.6, (line.end - line.time) * 0.92);   // 打字占行时长的 92%，唱完前打完
    wxCur = { el, text, t0, span: Math.max(0.25, t0 + dur - t0), n: -1 };
  };
  // seek 跨行补发：直接整条发出（不逐字）
  const wxSendInstant = (text) => {
    wxSide = !wxSide;
    const el = wxPushMsg(wxSide);
    if (el) el.textContent = String(text || '');
    wxSinceStick++;
    wxCur = null;
  };
  const wxResetTrack = (t) => {
    wxCover = t ? (t.coverBlob || t.coverUrl || '') : '';
    const shown = wxCover || COVER_FALLBACK;
    wxCdImg.onerror = () => { wxCdImg.onerror = null; wxCdImg.src = COVER_FALLBACK; };
    wxCdImg.src = shown;
    wxBg.style.backgroundImage = `url("${shown}")`;
    wxTitleEl.textContent = t?.title || '—';
    wxArtistEl.textContent = [t?.artist, t?.album].filter(Boolean).join(' · ') || ' ';
    wxChatName.textContent = t?.artist || '对方';
    wxList.innerHTML = '';
    wxLines = null; wxIdx = -1; wxSide = false; wxCur = null; wxLastLt = -999; wxSinceStick = 0;
  };
  const updateWxChat = (lt) => {
    const on = scenes.current === 'wxchat'
      && !app.npOpen
      && !document.body.classList.contains('home-active');
    wxBox.classList.toggle('wx-on', on);
    if (!on) { wxTrack = undefined; return; }                    // undefined ≠ null → 下次进入强制 reset
    const t = engine.current;
    if (wxTrack !== t) { wxTrack = t; wxResetTrack(t); }
    const lines = app.lyrics.lines;
    if (lines !== wxLines) { wxLines = lines; wxList.innerHTML = ''; wxIdx = -1; wxCur = null; }
    if (wxLastLt > -900 && lt < wxLastLt - 1) { wxList.innerHTML = ''; wxIdx = -1; wxCur = null; }  // seek 回跳 → 重打
    wxLastLt = lt;
    const idx = app.lyrics.activeIdx;
    if (idx >= 0) {
      while (wxIdx < idx) {
        wxIdx++;
        const line = lines[wxIdx];
        if (!line || !line.text) continue;
        if (wxIdx === idx) wxStartLine(line, lt);
        else wxSendInstant(line.text);
      }
    }
    // 打字机：按行时间窗推进已打字数，末尾挂闪烁光标
    const c = wxCur;
    if (c && c.el) {
      const frac = Math.min(1, Math.max(0, (lt - c.t0) / c.span));
      const n = Math.floor(frac * c.text.length);
      if (n !== c.n) {
        c.n = n;
        if (n >= c.text.length) { c.el.textContent = c.text; wxCur = null; }
        else {
          c.el.textContent = c.text.slice(0, n);
          const caret = document.createElement('span');
          caret.className = 'wx-caret';
          c.el.appendChild(caret);
          if (n % 3 === 0) wxScrollEnd();
        }
      }
    }
  };
  app.onFrame = (bands) => {
    if (!dragging) {
      const d = engine.duration || 0, t = engine.time || 0;
      const k = d ? (t / d) * 100 : 0;
      els.seekPlayed.style.width = k + '%';
      els.seekKnob.style.left = k + '%';
      els.cur.textContent = fmtTime(t);
      els.dur.textContent = fmtTime(d);
    }
    // 歌词状态机必须始终推进：切视觉场景/回舞台会关闭播放页，若只在 npOpen 时 update，
    // activeIdx 冻结 → 舞台悬浮歌词不跟随播放（track 在隐藏节点中更新，开销可忽略）
    // 歌词同步微调：lyricOffset>0 歌词整体延后、<0 提前（歌词面板/舞台悬浮/PV 字幕共用同一时基）
    const lt = engine.time - (app.lyricOffset || 0);
    // 音频时间驱动：duration 传入用于边界保护（末字 end ≤ 音频总长），rawTime 用于收尾淡出判定
    if (app.lyrics.lines.length) app.lyrics.update(lt, bands, engine.duration, engine.time);
    scenes.setLyricState?.(app.lyrics.lines, app.lyrics.activeIdx, lt); // PV 字幕场景数据源
    updateStageLyric();
    updateWxChat(lt); // 微信对话场景：气泡打字机（与面板/悬浮歌词同一时基）
    // 舞台悬浮歌词收尾淡出：与面板同一时基（原始音频时间，不受 lyricOffset 影响）
    {
      const d0 = engine.duration || 0;
      slBox.classList.toggle('sl-finale', d0 > 0 && engine.time >= d0 - 0.06 && slBox.classList.contains('on'));
    }
    // 舞台歌词节奏跳动：--sl-bp（鼓点脉冲）+ --sl-bass（低频呼吸）逐帧写在滚动层（行内继承），
    // CSS 侧 calc 叠加进当前行 transform/text-shadow，让歌词明显跟着鼓点动起来；
    // 受「面板歌词动效·鼓点弹跳」开关门控，歌词隐藏时归零避免残留
    const beatOn = app.beatBounce !== false && slBox.classList.contains('on');
    const bp = beatOn ? (bands?.beatPulse || 0) : 0;
    const bass = beatOn ? (bands?.bass || 0) : 0;
    slStack.style.setProperty('--sl-bp', bp.toFixed(3));
    slStack.style.setProperty('--sl-bass', bass.toFixed(3));
  };
  // 窗口缩放 → --sl-fs 跟随 vw 变化 → 行高变，重测行高并重贴滚动位置
  window.addEventListener('resize', () => { slMeasure(); slScrollTo(slIdx, false); });

  /* --- 首页信息流：热歌轨道 + 推荐歌单 --- */
  const fmtCount = (n) => {
    n = +n || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(1) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(n);
  };
  const coverImg = (src) => {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.draggable = false;
    img.alt = '';
    if (src) {
      img.src = src;
      img.onerror = () => { img.onerror = null; img.src = COVER_FALLBACK; };
    } else {
      img.src = COVER_FALLBACK;
    }
    return img;
  };

  /* 首页信息流（默认音源优先，可在登录弹层选平台切换）：热歌 50 首 + 推荐歌单 */
  const renderHotRail = (feed) => {
    try {
      const list = (feed?.hot || []).slice(0, 50);
      if (!list.length) throw new Error('empty');
      hotSongsForDrop = list; // 喂给搜索下拉的「热门搜索」
      els.hotNote.textContent = feed.sourceName ? `${feed.sourceName} · 热歌榜` : '热歌榜';
      els.hotRailRow.innerHTML = '';
      list.forEach((s, i) => {
        const item = document.createElement('button');
        item.className = 'rail-item';
        const idx = document.createElement('span');
        idx.className = 'ri-idx' + (i < 3 ? ' hot' : '');
        idx.textContent = String(i + 1).padStart(2, '0');
        const img = coverImg(s.coverUrl);
        const name = document.createElement('div');
        name.className = 'ri-name';
        name.textContent = s.name;
        const artist = document.createElement('div');
        artist.className = 'ri-artist';
        artist.textContent = s.artist || '';
        item.append(idx, img, name, artist);
        item.addEventListener('click', () => app.playOnline(s));
        els.hotRailRow.appendChild(item);
      });
    } catch {
      els.hotNote.textContent = '暂不可用';
      els.hotRailRow.innerHTML = '<div class="rail-empty">热歌加载失败 — 可通过在线搜索播放</div>';
    }
  };
  const loadHotRail = (feed) => { renderHotRail(feed); };

  /* 推荐音乐：从热歌榜中后段抽取（避开 Top10 头部，避免与热歌榜重复） */
  const loadRecSongsRail = (feed) => {
    try {
      const all = (feed?.hot || []);
      if (!all.length) throw new Error('empty');
      // 优先取第 11-22 首作为推荐音乐（避开热歌榜头部 Top10 重复），不足时回退前 12 首
      const rec = all.slice(10, 22);
      const list = rec.length >= 6 ? rec : all.slice(0, 12);
      els.recSongsNote.textContent = feed.sourceName ? `${feed.sourceName} · 推荐音乐` : '推荐音乐';
      els.recSongsRow.innerHTML = '';
      list.forEach((s, i) => {
        const item = document.createElement('button');
        item.className = 'rail-item';
        const idx = document.createElement('span');
        idx.className = 'ri-idx';
        idx.textContent = String(i + 1).padStart(2, '0');
        const img = coverImg(s.coverUrl);
        const name = document.createElement('div');
        name.className = 'ri-name';
        name.textContent = s.name;
        const artist = document.createElement('div');
        artist.className = 'ri-artist';
        artist.textContent = s.artist || '';
        item.append(idx, img, name, artist);
        item.addEventListener('click', () => app.playOnline(s));
        els.recSongsRow.appendChild(item);
      });
    } catch {
      els.recSongsNote.textContent = '暂不可用';
      els.recSongsRow.innerHTML = '<div class="rail-empty">推荐音乐加载失败 — 可通过在线搜索播放</div>';
    }
  };

  /* 推荐歌单网格（数据与渲染分离，收藏状态可即时刷新） */
  let hotPls = [];
  const isFav = (id) => (app.settings.favPlaylists || []).some(x => x.id === id);
  const loadPlGrid = async (feed) => {
    try {
      hotPls = feed?.playlists || [];
      if (!hotPls?.length) throw new Error('empty');
      els.plNote.textContent = '为你精选 · 每日更新';
      renderPlGrid();
    } catch {
      els.plNote.textContent = '暂不可用';
      els.plGrid.innerHTML = '<div class="rail-empty">推荐歌单加载失败 — 检查网络后重启应用</div>';
    }
  };
  const loadFeed = async (retry = 5) => {
    let feed = null;
    try {
      feed = await Promise.race([
        window.api.sourceFeed(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('feed timeout')), 8000))
      ]);
    } catch { /* 下方各自兜底 */ }
    // 启动时音源插件可能尚未加载完成 → sourceFeed 空/超时，延迟重试
    if (!feed && retry > 0) {
      setTimeout(() => loadFeed(retry - 1), 1500);
      return;
    }
    loadHotRail(feed);
    loadRecSongsRail(feed);
    loadPlGrid(feed);
  };
  app.reloadFeed = loadFeed; // 音源管理切换默认音源后刷新首页推荐

  /* 首页横滑轨道：鼠标按住拖拽平移 + 垂直滚轮转横向（触控板横向原生保留）；
     拖拽位移超过阈值后抑制下一次 click，避免松手误播歌曲 */
  const enableRowDrag = (el) => {
    if (!el || el._dragBound) return;
    el._dragBound = true;
    el.classList.add('row-drag');
    let down = false, dragging = false, locked = null;
    let startX = 0, startY = 0, startLeft = 0;
    el.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || e.button !== 0) return; // 触屏走原生滑动
      down = true; dragging = false; locked = null;
      startX = e.clientX; startY = e.clientY; startLeft = el.scrollLeft;
    });
    window.addEventListener('pointermove', (e) => {
      if (!down) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (locked === null) {
        if (Math.abs(dx) < 7 && Math.abs(dy) < 7) return;
        locked = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y'; // 首动方向定手势，避免横竖互抢
      }
      if (locked !== 'x') return;
      dragging = true;
      el.classList.add('dragging');
      el.scrollLeft = startLeft - dx;
    });
    window.addEventListener('pointerup', () => {
      if (!down) return;
      down = false;
      el.classList.remove('dragging');
      if (dragging) { el._suppressClick = true; setTimeout(() => { el._suppressClick = false; }, 0); }
      dragging = false; locked = null;
    });
    el.addEventListener('click', (e) => {
      if (el._suppressClick) { e.stopPropagation(); e.preventDefault(); el._suppressClick = false; }
    }, true);
    el.addEventListener('wheel', (e) => {
      if (el.scrollWidth <= el.clientWidth + 4) return; // 内容不溢出：放行，页面照常竖滚
      // 触控板横向优先 deltaX；普通鼠标滚轮/Shift+滚轮取 deltaY
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (!d) return;
      e.preventDefault();
      el.scrollLeft += d;
    }, { passive: false });
  };
  [els.hotRailRow, els.homeRecentRow, els.recSongsRow].forEach(enableRowDrag);
  const renderPlGrid = () => {
    els.plGrid.innerHTML = '';
    // 双视图：横向卡片 / Folia 海报墙（错落排布 + 滚轮缩放）
    const wall = app.plView === 'wall';
    els.plGrid.classList.toggle('pw-grid', wall);
    els.plGrid.classList.toggle('pl-grid', !wall);
    hotPls.forEach((pl) => els.plGrid.appendChild(wall ? pwCard(pl) : plCard(pl)));
  };
  /* 海报墙卡片：悬浮放大高亮，名称浮层 */
  const pwCard = (pl) => {
    const card = document.createElement('button');
    card.className = 'pw-card';
    const img = coverImg(pl.coverUrl);
    const nm = document.createElement('div');
    nm.className = 'pw-name';
    nm.textContent = pl.name || '歌单';
    const fav = document.createElement('span');
    fav.className = 'pl-fav' + (isFav(pl.id) ? ' on' : '');
    fav.textContent = isFav(pl.id) ? '♥' : '♡';
    fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(pl); });
    card.append(fav, img, nm);
    card.addEventListener('click', () => openPlaylistDetail(pl, card));
    return card;
  };
  /* 海报墙滚轮缩放：仅限软件内全屏态（非全屏时禁用放大） */
  els.plGrid.addEventListener('wheel', (e) => {
    if (app.plView !== 'wall' || !document.body.classList.contains('pl-full')) return;
    e.preventDefault();
    const s = Math.min(1.6, Math.max(0.5, (app.pwScale || 1) * (e.deltaY < 0 ? 1.08 : 0.93)));
    app.pwScale = s;
    els.plGrid.style.width = `${Math.round(s * 100)}%`;
  }, { passive: false });
  /* 视图切换 */
  els.plViewSeg.querySelectorAll('button').forEach(b => b.addEventListener('click', () => {
    app.plView = b.dataset.pv;
    els.plViewSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    window.api.setSetting('plView', app.plView);
    if (app.plView !== 'wall') els.plGrid.style.width = '';
    renderPlGrid();
  }));
  app.plView = app.settings.plView === 'wall' ? 'wall' : 'grid';
  els.plViewSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.pv === app.plView));
  /* Folia 式软件内歌单全屏：海报墙铺满整个窗口（非滚轮缩放，Esc/再点退出） */
  const btnPlFull = $('#btnPlFull');
  const setPlFull = (on) => {
    if (on && app.plView !== 'wall') {
      // 全屏沉浸式固定使用海报墙视图
      app.plView = 'wall';
      els.plViewSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x.dataset.pv === 'wall'));
      els.plGrid.style.width = '';
      renderPlGrid();
    }
    document.body.classList.toggle('pl-full', on);
    btnPlFull?.classList.toggle('active', on);
    if (btnPlFull) btnPlFull.textContent = on ? '✕ 退出' : '⛶ 全屏';
    if (on) els.plGrid.scrollTo?.({ top: 0 });
  };
  btnPlFull?.addEventListener('click', () => setPlFull(!document.body.classList.contains('pl-full')));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('pl-full')) setPlFull(false);
  });
  app._setPlFull = setPlFull;
  /* 歌单卡片（推荐 / 我的歌单共用；带 tracks 的本地歌单不显示收藏心）
     opts.cloud = 账号云歌单：只可收藏，不在本地删除 */
  const plCard = (pl, opts = {}) => {
    const card = document.createElement('button');
    card.className = 'pl-card';
    const img = coverImg(pl.coverUrl);
    const nm = document.createElement('div');
    nm.className = 'pl-name';
    nm.textContent = pl.name || '歌单';
    const meta = document.createElement('div');
    meta.className = 'pl-meta';
    meta.textContent = Array.isArray(pl.tracks)
      ? `${pl.tracks.length} 首`
      : [pl.curator, pl.playCount ? fmtCount(pl.playCount) + ' 次播放' : ''].filter(Boolean).join(' · ');
    card.append(img, nm, meta);
    if (!Array.isArray(pl.tracks)) {
      const fav = document.createElement('span');
      fav.className = 'pl-fav' + (isFav(pl.id) ? ' on' : '');
      fav.title = isFav(pl.id) ? '取消收藏' : '收藏到我的歌单';
      fav.textContent = isFav(pl.id) ? '♥' : '♡';
      fav.addEventListener('click', (e) => { e.stopPropagation(); toggleFav(pl); });
      card.append(fav);
    }
    /* 删除按钮：自建歌单（upl-）可删除整个歌单；收藏歌单可取消收藏；「我喜欢的」固定不删；
       账号云歌单（opts.cloud）不提供本地删除 */
    if (pl.id && pl.id !== '__fav__' && pl.id !== '__local__' && !opts.cloud) {
      const del = document.createElement('span');
      del.className = 'pl-del';
      del.title = Array.isArray(pl.tracks) ? '删除歌单' : '取消收藏';
      del.textContent = '×';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        const isSelf = Array.isArray(pl.tracks) && pl.id.startsWith('upl-');
        const msg = isSelf ? `确定删除歌单「${pl.name}」？其中 ${pl.tracks.length} 首歌曲将移出歌单（不会从收藏移除）`
                          : `确定取消收藏歌单「${pl.name}」？`;
        if (!confirm(msg)) return;
        if (isSelf) {
          app.settings.userPlaylists = (app.settings.userPlaylists || []).filter(x => x.id !== pl.id);
          window.api.setSetting('userPlaylists', app.settings.userPlaylists);
          toast('已删除歌单');
        } else {
          app.settings.favPlaylists = (app.settings.favPlaylists || []).filter(x => x.id !== pl.id);
          window.api.setSetting('favPlaylists', app.settings.favPlaylists);
          toast('已取消收藏');
        }
        renderMyPl();
        renderPlGrid();
      });
      card.append(del);
    }
    /* 本地歌曲卡：点击进入播放列表抽屉（本地曲目管理在队列，不走在线歌单详情） */
    card.addEventListener('click', () => {
      if (pl.id === '__local__') { openDrawer('list'); return; }
      openPlaylistDetail(pl, card);
    });
    return card;
  };

  /* --- 我的歌单（我喜欢的 + 自建歌单 + 收藏的在线歌单） --- */
  const toggleFav = (pl) => {
    const list = app.settings.favPlaylists || [];
    if (isFav(pl.id)) {
      app.settings.favPlaylists = list.filter(x => x.id !== pl.id);
      toast('已取消收藏');
    } else {
      app.settings.favPlaylists = [{ id: pl.id, name: pl.name, coverUrl: pl.coverUrl, curator: pl.curator, playCount: pl.playCount }, ...list];
      toast('已收藏到「我的歌单」');
    }
    window.api.setSetting('favPlaylists', app.settings.favPlaylists);
    renderMyPl();
    renderPlGrid();
    syncDetailFav();
  };
  /* 账号云歌单（网易云/QQ 登录后拉取，仅内存态不写 settings；srcId -> [pl]） */
  const accountPls = {};
  const CLOUD_SRC_ORDER = ['netease', 'qq'];
  /* 当前默认音源：「我的歌单」只展示该平台的账号歌单（与登录弹层单选/音源设置联动） */
  let curDefaultSrc = 'netease';
  /* 我的歌单实际可见的账号歌单数（仅当前平台） */
  const visibleAccCount = () => accountPls[curDefaultSrc]?.length || 0;
  const renderMyPl = () => {
    const favs = app.settings.favPlaylists || [];
    const ups = app.settings.userPlaylists || [];
    const loved = app.settings.favSongs || [];
    const accN = visibleAccCount();
    /* 本地歌曲（导入的本地文件夹/文件，随队列实时刷新） */
    const locals = engine.queue.filter((t) => t.source === 'local');
    els.myPlEmpty.style.display = (locals.length || favs.length || ups.length || loved.length || accN) ? 'none' : '';
    els.myPlNote.textContent =
      (locals.length || favs.length || ups.length || loved.length || accN)
        ? `本地 ${locals.length} 首 · 喜欢 ${loved.length} 首 · 自建 ${ups.length} 个 · 收藏 ${favs.length} 个 · 账号 ${accN} 个`
        : '喜欢的歌曲和自建歌单会出现在这里';
    els.myPlGrid.innerHTML = '';
    // 「本地歌曲」固定卡：有本地曲目时置顶，点击进入播放列表
    if (locals.length) {
      els.myPlGrid.appendChild(plCard({
        id: '__local__', name: '本地歌曲', curator: '本地',
        tracks: locals.map((t) => ({ id: t.id, name: t.title, artist: t.artist, coverUrl: t.coverBlob || null })),
        coverUrl: locals.find((t) => t.coverBlob)?.coverBlob || null
      }));
    }
    // 「我喜欢的音乐」固定卡（有喜欢内容时置顶展示）
    if (loved.length) {
      els.myPlGrid.appendChild(plCard({
        id: '__fav__', name: '我喜欢的音乐', tracks: loved,
        coverUrl: loved[0]?.coverUrl || null, curator: '收藏'
      }));
    }
    ups.forEach((pl) => els.myPlGrid.appendChild(plCard({ ...pl, curator: '自建', coverUrl: pl.coverUrl || pl.tracks?.[0]?.coverUrl || null })));
    // 账号云歌单：只显示「当前默认音源」那一组（另一平台仍缓存，切回平台即时出现）
    CLOUD_SRC_ORDER.forEach((sid) => {
      if (sid !== curDefaultSrc) return;
      const pls = accountPls[sid];
      if (!pls?.length) return;
      const sub = document.createElement('div');
      sub.className = 'mypl-sub';
      sub.textContent = `☁ ${pls[0]?.srcName || sid} · 账号歌单（${pls.length}）`;
      els.myPlGrid.appendChild(sub);
      pls.forEach((pl) => els.myPlGrid.appendChild(plCard(pl, { cloud: true })));
    });
    favs.forEach((pl) => els.myPlGrid.appendChild(plCard(pl)));
  };
  /** 拉取登录账号的云歌单（默认双音源；登录成功/启动/退出时调用） */
  const refreshAccountPls = async (srcIds = CLOUD_SRC_ORDER) => {
    const ids = (srcIds && srcIds.length) ? srcIds : CLOUD_SRC_ORDER;
    const results = await Promise.allSettled(
      ids.map((id) => window.api.sourceUserPlaylists(id).then((list) => [id, list || []]))
    );
    for (const r of results) {
      if (r.status !== 'fulfilled') continue;
      const [id, list] = r.value;
      accountPls[id] = list;
    }
    renderMyPl();
  };
  /** 退出登录：清除该音源的云歌单分组 */
  const clearAccountPls = (srcId) => {
    if (srcId) delete accountPls[srcId];
    else CLOUD_SRC_ORDER.forEach((id) => { delete accountPls[id]; });
    renderMyPl();
  };
  app.refreshAccountPls = refreshAccountPls;
  app.clearAccountPls = clearAccountPls;
  /** 同步默认音源到「我的歌单」过滤条件（登录弹层单选 / 音源设置下拉切换时调用） */
  app.syncDefaultSrc = async () => {
    try { curDefaultSrc = (await window.api.sourceConfigGet())?.defaultSource || 'netease'; }
    catch { /* 查询失败保持当前选择 */ }
    renderMyPl();
  };
  renderMyPl();

  /* --- 新建歌单（我的歌单旁按钮，可选自定义封面） --- */
  const newPlPop = $('#newPlPop'), newPlName = $('#newPlName');
  const newPlCoverBtn = $('#newPlCover'), newPlCoverImg = $('#newPlCoverImg');
  let newPlCover = null; // dataURL，创建时随歌单存 userPlaylists
  const resetNewPlCover = () => {
    newPlCover = null;
    newPlCoverImg?.classList.add('hidden');
    newPlCoverBtn?.classList.remove('has-img');
  };
  $('#btnNewPl')?.addEventListener('click', (e) => {
    e.stopPropagation();
    newPlPop.classList.toggle('hidden');
    if (!newPlPop.classList.contains('hidden')) { newPlName.value = ''; resetNewPlCover(); setTimeout(() => newPlName.focus(), 60); }
  });
  newPlCoverBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    const data = await window.api.pickImage('选择歌单封面');
    if (!data) return;
    newPlCover = data;
    newPlCoverImg.src = data;
    newPlCoverImg.classList.remove('hidden');
    newPlCoverBtn.classList.add('has-img');
  });
  const createUserPl = () => {
    const name = newPlName.value.trim();
    if (!name) { toast('先给歌单起个名字'); return; }
    const pl = { id: 'upl-' + Date.now(), name, tracks: [] };
    if (newPlCover) pl.coverUrl = newPlCover;
    app.settings.userPlaylists = [...(app.settings.userPlaylists || []), pl];
    window.api.setSetting('userPlaylists', app.settings.userPlaylists);
    newPlPop.classList.add('hidden');
    renderMyPl();
    toast(`歌单「${name}」已创建 — 播放页点 ＋ 加入歌曲`);
  };
  $('#newPlOk')?.addEventListener('click', createUserPl);
  newPlName?.addEventListener('keydown', (e) => { if (e.key === 'Enter') createUserPl(); });
  document.addEventListener('pointerdown', (e) => {
    if (newPlPop && !newPlPop.classList.contains('hidden') && !newPlPop.contains(e.target) && e.target.id !== 'btnNewPl') {
      newPlPop.classList.add('hidden');
    }
  });

  /* --- 喜欢歌曲 & 加入歌单（播放页 ♡ / ＋） --- */
  const npFav = $('#npFav'), npAddPl = $('#npAddPl'), songMenu = $('#songMenu');
  const trackToSong = (t) => (t && t.source === 'online' && t.songId) ? {
    id: t.songId, srcId: t.srcId || 'netease', srcName: t.srcName || '', name: t.title,
    artist: t.artist || '', album: t.album || '', coverUrl: t.coverUrl || null, duration: t.duration || 0
  } : null;
  const isFavSong = (t) => {
    const s = trackToSong(t);
    if (!s) return false;
    return (app.settings.favSongs || []).some(x => x.id === s.id && x.srcId === s.srcId);
  };
  const syncNpFav = () => {
    const t = engine.current;
    const ok = !!trackToSong(t);
    const fav = isFavSong(t);
    npFav.classList.toggle('on', fav);
    npFav.textContent = fav ? '♥' : '♡';
    npFav.classList.toggle('disabled', !ok);
    npAddPl.classList.toggle('disabled', !ok);
  };
  const toggleFavSong = (t) => {
    const s = trackToSong(t);
    if (!s) { toast('本地与演示曲目不支持喜欢'); return; }
    const list = app.settings.favSongs || [];
    const i = list.findIndex(x => x.id === s.id && x.srcId === s.srcId);
    if (i >= 0) { list.splice(i, 1); toast('已取消喜欢'); }
    else { list.unshift({ ...s, ts: Date.now() }); toast('已加入「我喜欢的音乐」'); }
    app.settings.favSongs = list.slice(0, 500);
    window.api.setSetting('favSongs', app.settings.favSongs);
    syncNpFav();
    renderMyPl();
  };
  let menuSong = null;
  const hideSongMenu = () => songMenu.classList.add('hidden');
  const renderSongMenu = () => {
    const list = $('#smList');
    list.innerHTML = '';
    const mk = (title, sub, fn) => {
      const b = document.createElement('button');
      b.className = 'sm-item';
      const b1 = document.createElement('b');
      b1.textContent = title;
      const b2 = document.createElement('i');
      b2.textContent = sub;
      b.append(b1, b2);
      b.addEventListener('click', fn);
      list.appendChild(b);
    };
    mk('♥ 我喜欢的音乐', `${(app.settings.favSongs || []).length} 首`, () => addSongToUserPl('__fav__'));
    for (const pl of (app.settings.userPlaylists || [])) {
      mk(pl.name, `${pl.tracks.length} 首`, () => addSongToUserPl(pl.id));
    }
  };
  const addSongToUserPl = (plId) => {
    if (!menuSong) return;
    if (plId === '__fav__') {
      const list = app.settings.favSongs || [];
      if (!list.some(x => x.id === menuSong.id && x.srcId === menuSong.srcId)) {
        list.unshift({ ...menuSong, ts: Date.now() });
        app.settings.favSongs = list.slice(0, 500);
        window.api.setSetting('favSongs', app.settings.favSongs);
        syncNpFav();
      }
      toast('已加入「我喜欢的音乐」');
    } else {
      const pl = (app.settings.userPlaylists || []).find(x => x.id === plId);
      if (pl) {
        if (!pl.tracks.some(x => x.id === menuSong.id && x.srcId === menuSong.srcId)) {
          pl.tracks.push({ ...menuSong });
          window.api.setSetting('userPlaylists', app.settings.userPlaylists);
          renderMyPl();
        }
        toast(`已加入「${pl.name}」`);
      }
    }
    hideSongMenu();
  };
  const openSongMenu = (t) => {
    const s = trackToSong(t);
    if (!s) { toast('本地与演示曲目不支持加入歌单'); return; }
    menuSong = s;
    renderSongMenu();
    songMenu.classList.remove('hidden');
  };
  npFav.addEventListener('click', () => toggleFavSong(engine.current));
  npAddPl.addEventListener('click', () => openSongMenu(engine.current));
  $('#smNewBtn').addEventListener('click', () => {
    const name = $('#smNewName').value.trim();
    if (!name) { toast('先给歌单起个名字'); return; }
    app.settings.userPlaylists = [...(app.settings.userPlaylists || []), { id: 'upl-' + Date.now(), name, tracks: [] }];
    window.api.setSetting('userPlaylists', app.settings.userPlaylists);
    $('#smNewName').value = '';
    renderSongMenu();
    renderMyPl();
    toast(`歌单「${name}」已创建`);
  });
  $('#smNewName').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#smNewBtn').click(); });
  document.addEventListener('pointerdown', (e) => {
    if (!songMenu.classList.contains('hidden') && !songMenu.contains(e.target) && !npAddPl.contains(e.target)) hideSongMenu();
  });
  engine.addEventListener('track', syncNpFav);

  /* --- 歌单详情 → Folia 式拼图（不规则矩形拼贴，正在播放/选中封面居中放大） --- */
  let plTracks = [];
  let curPl = null;
  const syncDetailFav = () => {
    if (!curPl) return;
    els.btnFavDetail.classList.toggle('on', isFav(curPl.id));
    els.btnFavDetail.title = isFav(curPl.id) ? '取消收藏' : '收藏到我的歌单';
    btnPfFav?.classList.toggle('on', isFav(curPl.id));
    if (btnPfFav) btnPfFav.title = isFav(curPl.id) ? '取消收藏' : '收藏到我的歌单';
  };

  const folia = $('#plFolia'), pfGrid = $('#pfGrid'), pfPlane = $('#pfPlane'), pfEmpty = $('#pfEmpty');
  const pfName = $('#pfName'), pfCount = $('#pfCount'), btnPfFav = $('#btnPfFav');
  let pfTracks = [];
  /* ---------- 封面墙：均匀网格 + 整页拖动（无限循环 + 点击居中 + 控制器内嵌）----------
     - 均匀网格绝对定位一次写入内层平面 pfPlane，相机 = 平面单层 translate3d（合成线程）
     - 无限循环：唯一封面铺成基础网格，重复 3×3 份覆盖相机包装范围；相机位置对周期取模，任何方向可无限拖
     - 点击封面：播放该曲并相机平滑居中到该封面（取距当前相机最近的一份副本）
     - 不足 50 首的歌单循环复制至 50 首作为唯一集 */
  const pfHero = $('#pfHero'), pfHeroBadge = $('#pfHeroBadge'), pfHeroMetaBox = $('#pfHeroMetaBox');
  const pfHeroMeta = { name: $('#pfHeroName'), artist: $('#pfHeroArtist') };
  const pfHeroCtrl = $('#pfHeroCtrl');
  /* 歌单拼图：封面以错落马赛克铺满墙面（全部正方形、大小不一、相邻无间隙）。
     整体可拖动平移浏览；点击某封面 → 仅该封面从原位飞向屏幕中心并放大（其余卡片保持原位）；
     再次点击已放大封面 / ⤢ 按钮 → 传送进入歌词 MV。
     背景可跟随主页 或 跟随选中封面（模糊）。不缩放整页、可见页面不出现重复卡片。 */
  const PF_CELL = 56;           // 马赛克单元格尺寸（封面为 2/3/4 格的正方形）
  const PF_MIN = 100;           // 目标墙面至少 100 张（不足则分页重复，页间距 > 视口高 → 可见页无重复）
  let pfUniq = [];              // 有封面的唯一曲目集
  let pfSphere = null;          // FoliaSphere 实例（圆柱模式）
  let pfFocusEl = null;         // 当前居中放大的封面元素
  let pfFocusIdx = -1;          // 对应曲目索引
  // 整体拖动平移：pfPlane 用 transform 平移；不缩放
  let pfPanX = 0, pfPanY = 0;
  let pfPlaneW = 0, pfPlaneH = 0;
  const pfApplyPan = () => {
    const vw = pfGrid.clientWidth || window.innerWidth;
    const vh = pfGrid.clientHeight || window.innerHeight;
    const pad = 80;
    const minX = Math.min(0, -(pfPlaneW - vw));
    const minY = Math.min(0, -(pfPlaneH - vh));
    pfPanX = clamp(pfPanX, minX - pad, pad);
    pfPanY = clamp(pfPanY, minY - pad, pad);
    pfPlane.style.transform = `translate(${pfPanX}px, ${pfPanY}px)`;
  };
  let pfDrag = null;

  /* 聚焦某封面：仅该卡片飞向屏幕中心并放大，其余卡片保持原位。
     把卡片移到 document.body 用 position:fixed，避免 pfPlane 的 transform / folia 的 backdrop-filter
     创建 containing block 导致 fixed 坐标系偏离视口。 */
  const pfFocusTile = (tileEl, trackIdx) => {
    if (tileEl === pfFocusEl) { portalToNp(); return; } // 已放大 → 进歌词 MV
    pfUnfocus(false);
    pfFocusEl = tileEl;
    pfFocusIdx = trackIdx;
    const r = tileEl.getBoundingClientRect();
    tileEl.style.transition = 'none';
    document.body.appendChild(tileEl);
    tileEl.style.position = 'fixed';
    tileEl.style.left = r.left + 'px';
    tileEl.style.top = r.top + 'px';
    tileEl.style.width = r.width + 'px';
    tileEl.style.height = r.height + 'px';
    tileEl.style.margin = '0';
    tileEl.style.zIndex = '100';
    tileEl.classList.add('pf-focus');
    void tileEl.offsetWidth; // 强制重排，固定到原屏幕位置
    tileEl.style.transition = '';
    const W = window.innerWidth, H = window.innerHeight;
    const targetSize = Math.min(W, H) * 0.56;
    const sc = Math.max(1.05, targetSize / r.width);
    tileEl.style.left = (W / 2 - r.width / 2) + 'px';
    tileEl.style.top = (H / 2 - r.height / 2) + 'px';
    tileEl.style.transform = `scale(${sc})`;
    pfBackdrop.classList.remove('hidden');
    pfApplyBg();
    // 播放该曲
    const s = pfUniq[trackIdx];
    const cur = engine.current;
    if (!cur || String(cur.songId) !== String(s.id)) {
      const t = makeTrack({
        source: 'online', songId: s.id, srcId: s.srcId || null,
        title: s.name, artist: s.artist, album: s.album,
        duration: s.duration > 10000 ? s.duration / 1000 : (s.duration || 0),
        coverUrl: s.coverUrl || null,
      });
      engine.addTracks([t], true);
    }
    syncPfPlaying();
  };
  /* 取消聚焦：把卡片动画回原马赛克位置（先在 body 里 fixed 飞回原屏幕坐标，再放回 pfPlane） */
  let pfUnfocusTimer = 0;
  const pfUnfocus = (animate = true) => {
    if (!pfFocusEl) return;
    const el = pfFocusEl;
    pfFocusEl = null;
    pfFocusIdx = -1;
    const o = el._orig || {};
    el.classList.remove('pf-focus');
    pfBackdrop.classList.add('hidden');
    if (pfUnfocusTimer) { clearTimeout(pfUnfocusTimer); pfUnfocusTimer = 0; }
    const pr = pfPlane.getBoundingClientRect();
    const restore = () => {
      el.style.transition = 'none';
      pfPlane.appendChild(el);
      el.style.position = 'absolute';
      el.style.left = o.left + 'px';
      el.style.top = o.top + 'px';
      el.style.width = o.w + 'px';
      el.style.height = o.h + 'px';
      el.style.margin = '';
      el.style.transform = '';
      el.style.zIndex = '';
      void el.offsetWidth;
      el.style.transition = '';
    };
    if (animate) {
      el.style.left = (pr.left + o.left) + 'px';
      el.style.top = (pr.top + o.top) + 'px';
      el.style.transform = 'scale(1)';
      pfUnfocusTimer = setTimeout(() => { pfUnfocusTimer = 0; restore(); }, 430);
    } else {
      restore();
    }
    pfApplyBg();
  };
  /* 空白遮罩：点击收起聚焦卡片（挂在 folia 全屏层，绝对定位覆盖视口，不影响 pfGrid 滚动） */
  const pfBackdrop = document.createElement('div');
  pfBackdrop.className = 'pf-focus-backdrop hidden';
  folia.insertBefore(pfBackdrop, folia.firstChild);
  pfBackdrop.addEventListener('click', () => pfUnfocus(true));
  pfBackdrop.addEventListener('wheel', (e) => { e.preventDefault(); }, { passive: false });

  /* ---------- 背景层：跟随主页 或 跟随选中封面（模糊）（挂在 folia 全屏层，不随马赛克滚动） ---------- */
  const pfBg = document.createElement('div');
  pfBg.className = 'pf-bg';
  folia.insertBefore(pfBg, pfBackdrop.nextSibling);
  const pfApplyBg = () => {
    pfBg.dataset.mode = pfBgMode;
    if (pfBgMode === 'cover') {
      const src = pfFocusEl?.querySelector('img')?.currentSrc
               || pfSphere?.tracks?.[pfSphere._lastFocusIdx || 0]?.coverUrl
               || engine.current?.coverBlob
               || engine.current?.coverUrl || '';
      pfBg.style.backgroundImage = src ? `url("${src}")` : '';
    } else {
      pfBg.style.backgroundImage = '';
    }
  };
  /* 封面变化时刷新封面模糊背景 */
  engine.addEventListener('cover', () => { if (!folia.classList.contains('hidden')) pfApplyBg(); });
  /* 窗口尺寸变化：聚焦态下重新对齐中心；球面模式下同步 resize */
  window.addEventListener('resize', () => {
    if (folia.classList.contains('hidden')) return;
    if (pfSphere) {
      const w = pfGrid.clientWidth || window.innerWidth;
      const h = pfGrid.clientHeight || window.innerHeight;
      pfSphere.resize(w, h);
      return;
    }
    if (!pfFocusEl) return;
    const r = pfFocusEl.getBoundingClientRect();
    const W = window.innerWidth, H = window.innerHeight;
    const targetSize = Math.min(W, H) * 0.56;
    const sc = Math.max(1.05, targetSize / r.width);
    pfFocusEl.style.left = (W / 2 - r.width / 2) + 'px';
    pfFocusEl.style.top = (H / 2 - r.height / 2) + 'px';
    pfFocusEl.style.transform = `scale(${sc})`;
  });
  /* ---------- 整体拖动平移（有边界、延迟 capture）---------- */
  // pointerdown 时先不 capture，确认拖动 >6px 后再 capture，避免正常点击被 pfGrid 截获导致 tile click 失效
  pfGrid.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || pfFocusEl) return; // 聚焦态下不拖动
    pfDrag = { x: e.clientX, y: e.clientY, ox: pfPanX, oy: pfPanY, moved: false, pid: e.pointerId, captured: false };
  });
  pfGrid.addEventListener('pointermove', (e) => {
    if (!pfDrag) return;
    const dx = e.clientX - pfDrag.x, dy = e.clientY - pfDrag.y;
    if (!pfDrag.moved && Math.hypot(dx, dy) > 6) {
      pfDrag.moved = true; pfGrid.classList.add('pf-dragging');
      if (!pfDrag.captured) {
        try { pfGrid.setPointerCapture(e.pointerId); pfDrag.captured = true; } catch {}
      }
    }
    if (!pfDrag.moved) return;
    pfPanX = pfDrag.ox + dx; pfPanY = pfDrag.oy + dy;
    pfApplyPan();
  });
  const pfDragEnd = (e) => {
    if (!pfDrag) return;
    const wasMoved = pfDrag.moved;
    pfDrag = null;
    pfGrid.classList.remove('pf-dragging');
    try { if (wasMoved) pfGrid.releasePointerCapture(e.pointerId); } catch {}
  };
  pfGrid.addEventListener('pointerup', pfDragEnd);
  pfGrid.addEventListener('pointercancel', pfDragEnd);
  pfGrid.addEventListener('click', (e) => {
    if (pfDrag && pfDrag.moved) { e.stopPropagation(); e.preventDefault(); }
  }, true);
  pfGrid.addEventListener('wheel', (e) => {
    if (pfFocusEl) return;
    e.preventDefault();
    pfPanY -= e.deltaY * 0.9;
    pfApplyPan();
  }, { passive: false });
  /* 全屏控制：优先主进程窗口级全屏（win:set-fullscreen IPC → BrowserWindow.setFullscreen），
     无 IPC 环境（纯浏览器调试）回退页面级 Fullscreen API */
  const pfSetFullscreen = (on) => {
    if (window.api?.setFullscreen) { window.api.setFullscreen(on); return; }
    if (on) document.documentElement.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
  };
  /* 正在播放标记：所有该曲目副本 tile 加 .pf-playing（光圈 + 内嵌控制器），底部信息条同步 */
  const syncPfPlaying = () => {
    const cur = engine.current;
    const tid = cur?.songId != null ? String(cur.songId) : '';
    const mark = (el) => {
      const isP = !!tid && el.dataset.tid === tid;
      el.classList.toggle('pf-playing', isP);
      if (isP && !el.querySelector('.pf-tile-ctrl')) el.appendChild(buildTileCtrl());
      else if (!isP) el.querySelector('.pf-tile-ctrl')?.remove();
    };
    [...pfPlane.children].forEach(mark);
    if (pfFocusEl) mark(pfFocusEl); // 聚焦卡片已移到 body，单独处理
    pfHeroMeta.name.textContent = cur?.title || '未播放';
    pfHeroMeta.artist.textContent = cur?.artist || '点击封面播放并居中放大';
    syncPfPlay();
  };
  /* 控制器：上一首 / 播放暂停 / 下一首 / 放大进歌词MV —— 主控制器嵌入「正在播放」封面内部，
     底部胶囊仅保留曲目信息（#pfHeroCtrl 隐藏）。事件委托在 pfPlane 上统一处理 tile 内按钮。 */
  const pfBtnPlay = $('#pfBtnPlay');
  $('#pfBtnPrev').addEventListener('click', (e) => { e.stopPropagation(); engine.prev(); });
  $('#pfBtnNext').addEventListener('click', (e) => { e.stopPropagation(); engine.next(); });
  pfBtnPlay.addEventListener('click', (e) => { e.stopPropagation(); engine.playPause(); });
  /* 构造封面内控制器（prev / play / next / mv），仅挂到正在播放的 tile 上 */
  const buildTileCtrl = () => {
    const c = document.createElement('div');
    c.className = 'pf-tile-ctrl';
    c.innerHTML = '<button data-act="prev" title="上一首">⏮</button>'
      + '<button data-act="play" class="pf-tc-play" title="播放 / 暂停">▶</button>'
      + '<button data-act="next" title="下一首">⏭</button>'
      + '<button data-act="mv" title="放大进入歌词 MV">⤢</button>';
    return c;
  };
  /* tile 内按钮事件委托：阻止冒泡到 tile 的 click（避免误触发播放/居中） */
  const handleTileCtrl = (e) => {
    const btn = e.target.closest('.pf-tile-ctrl button');
    if (!btn) return;
    e.stopPropagation();
    const act = btn.dataset.act;
    if (act === 'prev') engine.prev();
    else if (act === 'next') engine.next();
    else if (act === 'play') engine.playPause();
    else if (act === 'mv') portalToNp();
  };
  pfPlane.addEventListener('click', handleTileCtrl);
  // 聚焦卡片移到 document.body 后，pfPlane 委托失效 → 在 body 上补一个委托兜底
  document.body.addEventListener('click', handleTileCtrl);
  /* 焦点封面传送进歌词MV：克隆焦点封面从原位放大冲满屏幕，
     接近满屏时歌词MV(PV字幕场景)在背后亮起，克隆体淡出 → “穿越封面进入歌词MV” */
  const enterLyricMv = () => {
    closeFolia();
    // 离开主页模式：否则 setScene('pv') 会被 _homeMode 门控挡下（主页只允许圆环频谱）
    document.body.classList.remove('home-active');
    scenes.setHomeMode(false);
    // 直达歌词MV：选中 PV 字幕场景并持久化（场景跨歌曲保持，切歌自动跟随；播放页保持关闭）
    document.querySelectorAll('.scene-btn').forEach(b => b.classList.toggle('active', b.dataset.scene === 'pv'));
    if (document.body.classList.contains('user-bg')) app.clearCustomBg(); // 图片/视频背景会挡住动态舞台
    scenes.setScene('pv');
    syncSceneCfg('pv');
    app.saveSettings();
    if (app.npOpen) app.toggleNp(false);
  };
  const portalToNp = (_track, srcImg) => {
    document.querySelector('.pf-portal')?.remove(); // 防快速连点残留
    const img = srcImg || pfFocusEl?.querySelector('img') || pfPlane.querySelector('.pf-playing img') || pfPlane.querySelector('.pf-tile img');
    const r = img?.getBoundingClientRect();
    if (!r || !r.width) { enterLyricMv(); return; }
    const ghost = document.createElement('div');
    ghost.className = 'pf-portal';
    const gi = document.createElement('img');
    gi.src = img.currentSrc || img.src;
    gi.referrerPolicy = 'no-referrer';
    gi.alt = '';
    ghost.appendChild(gi);
    ghost.style.left = (r.left + r.width / 2) + 'px';
    ghost.style.top = (r.top + r.height / 2) + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    const sc = Math.max(window.innerWidth / r.width, window.innerHeight / r.height) * 1.08;
    const anim = ghost.animate([
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, filter: 'brightness(1)', offset: 0 },
      { transform: `translate(-50%, -50%) scale(${(sc * 0.52).toFixed(2)})`, opacity: 1, filter: 'brightness(1.28)', offset: 0.5 },
      { transform: `translate(-50%, -50%) scale(${sc.toFixed(2)})`, opacity: 1, filter: 'brightness(1.14)', offset: 0.82 },
      { transform: `translate(-50%, -50%) scale(${(sc * 1.05).toFixed(2)})`, opacity: 0, filter: 'brightness(1)', offset: 1 },
    ], { duration: 760, easing: 'cubic-bezier(0.42, 0, 0.7, 0.35)', fill: 'forwards' });
    setTimeout(enterLyricMv, 430); // 封面将近满屏时亮起歌词MV
    anim.onfinish = () => ghost.remove();
  };
  $('#pfBtnNp').addEventListener('click', (e) => { e.stopPropagation(); portalToNp(); });
  const syncPfPlay = () => {
    const ic = engine.playing ? '⏸' : '▶';
    pfBtnPlay.textContent = ic;
    pfPlane.querySelectorAll('.pf-playing .pf-tc-play').forEach(b => b.textContent = ic);
    if (pfFocusEl) pfFocusEl.querySelectorAll('.pf-playing .pf-tc-play').forEach(b => b.textContent = ic);
  };
  engine.addEventListener('state', syncPfPlay);
  syncPfPlay();
  const renderFolia = () => {
    // 清理上一次渲染后被 pfFocusTile 移到 body 的聚焦卡片（避免残留）
    if (pfFocusEl && pfFocusEl.parentElement === document.body) pfFocusEl.remove();
    pfPlane.innerHTML = '';
    pfFocusEl = null; pfFocusIdx = -1;
    pfBackdrop.classList.add('hidden');
    const withCover = pfTracks.filter((x) => !!x.coverUrl);
    if (!withCover.length) {
      pfEmpty.classList.remove('hidden');
      pfCount.textContent = pfTracks.length ? '歌单内无封面曲目' : '歌单为空';
      return;
    }
    pfEmpty.classList.add('hidden');
    pfUniq = withCover.slice();
    // ===== 球面模式：封面铺成球面，拖动=旋转，点击=转到正面+嵌入放大 =====
    pfGrid.classList.add('sphere-mode');
    if (pfSphere) { pfSphere.dispose(); pfSphere = null; }
    const canvas = $('#pfSphere');
    const sphere = new FoliaSphere(canvas);
    pfSphere = sphere;
    sphere.onTileClick = (trackIdx) => {
      sphere._lastFocusIdx = trackIdx;
      const s = pfUniq[trackIdx];
      const cur = engine.current;
      if (!cur || String(cur.songId) !== String(s.id)) {
        const t = makeTrack({
          source: 'online', songId: s.id, srcId: s.srcId || null,
          title: s.name, artist: s.artist, album: s.album,
          duration: s.duration > 10000 ? s.duration / 1000 : (s.duration || 0),
          coverUrl: s.coverUrl || null,
        });
        engine.addTracks([t], true);
      }
      pfBackdrop.classList.add('hidden');
      syncPfPlaying();
      // 球面模式：控制器在飞出的 hero 卡上（#pfSphereHeroDom），不显示旧底栏
    };
    sphere.onTileCenter = () => {
      pfApplyBg();
      syncPfPlaying();
    };
    sphere.onHeroBack = () => {
      pfHero.classList.remove('on');
      document.getElementById('pfSphereHeroDom')?.style.setProperty('display', 'none');
    };
    // 每帧推送 hero 卡屏幕矩形 → DOM overlay 贴在 WebGL hero 卡上
    // overlay 只创建一次；按钮闭包统一调模块级 pfSphere（重进歌单自动指向新实例，不会失灵）
    sphere.onHeroUpdate = ({ x, y, w, h, arrived }) => {
      let heroEl = document.getElementById('pfSphereHeroDom');
      if (!heroEl) {
        heroEl = document.createElement('div');
        heroEl.id = 'pfSphereHeroDom';
        heroEl.innerHTML = `
          <img class="pfsh-cover" />
          <div class="pfsh-info">
            <b class="pfsh-name"></b>
            <i class="pfsh-artist"></i>
          </div>
          <div class="pfsh-ctrl">
            <button class="pfsh-btn" title="返回">✕</button>
            <button class="pfsh-btn" title="上一首">⏮</button>
            <button class="pfsh-btn pfsh-play" title="播放/暂停">▶</button>
            <button class="pfsh-btn" title="下一首">⏭</button>
            <button class="pfsh-btn" title="放大进歌词MV">⤢</button>
          </div>
        `;
        const api = () => pfSphere;   // 永远取当前实例
        heroEl.querySelector('.pfsh-btn[title="返回"]').onclick = () => api()?._heroBack(-1);
        heroEl.querySelector('.pfsh-btn[title="上一首"]').onclick = () => {
          engine.prev();
          const t = engine.current;
          const idx = pfUniq.findIndex(s => String(s.id) === String(t?.songId));
          if (idx >= 0) api()?.focusTrack(idx, false);
        };
        const playBtn = heroEl.querySelector('.pfsh-btn[title="播放/暂停"]');
        playBtn.onclick = () => engine.playPause();
        heroEl.querySelector('.pfsh-btn[title="下一首"]').onclick = () => {
          engine.next();
          const t = engine.current;
          const idx = pfUniq.findIndex(s => String(s.id) === String(t?.songId));
          if (idx >= 0) api()?.focusTrack(idx, false);
        };
        heroEl.querySelector('.pfsh-btn[title="放大进歌词MV"]').onclick = () => {
          // 放大从飞出来的 hero 卡 DOM 封面 → clone + 冲屏 + portalToNp
          const cur = engine.current;
          if (!cur) return;
          const srcImg = heroEl.querySelector('.pfsh-cover');
          portalToNp(cur, srcImg);
        };
        const updatePlayBtn = () => {
          playBtn.textContent = engine.playing ? '⏸' : '▶';
        };
        engine.addEventListener('state', updatePlayBtn); // engine 为 EventTarget，播放/暂停派发 'state'（与全局播放栏、2D 控制器一致）
        heroEl._updatePlayBtn = updatePlayBtn;
        // 点封面/卡片空白处（非按钮）= 再点 hero 卡 → 收回飞回
        heroEl.addEventListener('click', (e) => {
          if (e.target.closest('.pfsh-btn')) return;
          api()?._heroBack(-1);
        });
        folia.appendChild(heroEl);
      }
      // 定位到 hero 卡屏幕位置：sphere 推送的 x/y 相对 canvas（=pfGrid 内容区），
      // heroEl 挂在 folia（fixed inset:0）下 → 用视口坐标
      const rect = pfGrid.getBoundingClientRect();
      const vx = rect.left + x;
      const vy = rect.top + y;
      const hSize = Math.min(w, h);   // 方形
      heroEl.style.display = 'block';
      heroEl.style.left = `${vx}px`;
      heroEl.style.top = `${vy}px`;
      heroEl.style.width = `${hSize}px`;
      heroEl.style.height = `${hSize}px`;
      heroEl.style.transform = 'translate(-50%, -50%)';
      heroEl.classList.toggle('arrived', arrived);
      // 同步歌曲信息（首次 arrived 或歌曲变化时刷新）
      const cur = engine.current;
      const trackIdx = sphere._hero.track;
      if (cur) {
        heroEl.querySelector('.pfsh-cover').src = cur.coverUrl || '';
        heroEl.querySelector('.pfsh-name').textContent = cur.title || '';
        heroEl.querySelector('.pfsh-artist').textContent = cur.artist || '';
        heroEl._updatePlayBtn?.();
      }
    };
    sphere.init(pfUniq).catch((e) => {
      console.warn('FoliaSphere 初始化失败，回退 2D 马赛克', e);
      pfGrid.classList.remove('sphere-mode');
      renderFolia2D();
    });
    pfCount.textContent = `共 ${pfTracks.length} 首 · 左右拖动旋转 · 点击封面飞到面前 · 点空白收回`;
    syncPfPlaying();
    setTimeout(() => {
      if (folia.classList.contains('hidden')) return;
      const cur = engine.current;
      if (!cur) { sphere.focusTrack(0, true); return; }
      const idx = pfUniq.findIndex(s => String(s.id) === String(cur.songId));
      if (idx >= 0) sphere.focusTrack(idx, false);
    }, 800);
  };
  /* 旧版 2D 马赛克渲染（球面失败时的降级路径，保留逻辑不变） */
  const renderFolia2D = () => {
    pfGrid.classList.remove('sphere-mode');
    const vw = pfGrid.clientWidth || window.innerWidth;
    const vh = pfGrid.clientHeight || window.innerHeight;
    const cols = Math.max(6, Math.floor(vw / PF_CELL));
    const rnd = (i) => { let x = Math.sin(i * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
    // 分页重复：每页放全部唯一封面，页间距 > 视口高 → 任意可见页面内不会出现重复卡片
    const pages = Math.max(1, Math.ceil(PF_MIN / pfUniq.length));
    const pageGap = vh + 240; // 页与页之间留一个视口高以上的空白，确保可见区域不跨页
    const frag = document.createDocumentFragment();
    let pageY = 0;
    for (let page = 0; page < pages; page++) {
      const occ = new Array(cols).fill(0);
      let pageMaxRow = 0;
      pfUniq.forEach((s, k) => {
        // 全部正方形：2/3/4 格（112/168/224px），大小不一交错
        const r = rnd(k * 7 + page * 131);
        let cells = 2;
        if (r > 0.86) cells = 4;
        else if (r > 0.5) cells = 3;
        // skyline 贪心：找最靠上且能放下 cells 宽的列
        let bx = 0, bestRow = Infinity;
        for (let c = 0; c + cells <= cols; c++) {
          let row = 0;
          for (let k2 = 0; k2 < cells; k2++) row = Math.max(row, occ[c + k2]);
          if (row < bestRow) { bestRow = row; bx = c; }
        }
        if (bestRow === Infinity) { cells = 2; bx = 0; bestRow = occ[0] || 0; }
        for (let k2 = 0; k2 < cells; k2++) occ[bx + k2] = bestRow + cells;
        pageMaxRow = Math.max(pageMaxRow, bestRow + cells);
        const x = bx * PF_CELL, y = pageY + bestRow * PF_CELL, size = cells * PF_CELL;
        const tile = document.createElement('button');
        tile.className = 'pf-tile';
        tile.dataset.tid = String(s.id);
        tile.dataset.trackidx = String(k);
        tile.style.left = x + 'px';
        tile.style.top = y + 'px';
        tile.style.width = size + 'px';
        tile.style.height = size + 'px';
        tile._orig = { left: x, top: y, w: size, h: size };
        const im = coverImg(s.coverUrl);
        im.loading = 'eager'; im.decoding = 'async';
        tile.appendChild(im);
        const meta = document.createElement('div');
        meta.className = 'pf-meta';
        const nm = document.createElement('div');
        nm.className = 'pf-t-name'; nm.textContent = s.name;
        const ar = document.createElement('div');
        ar.className = 'pf-t-artist'; ar.textContent = s.artist || '';
        meta.append(nm, ar);
        tile.appendChild(meta);
        tile.addEventListener('click', () => { pfFocusTile(tile, k); });
        frag.appendChild(tile);
      });
      pageY += pageMaxRow * PF_CELL + (page < pages - 1 ? pageGap : 0);
    }
    pfPlane.style.width = (cols * PF_CELL) + 'px';
    pfPlane.style.height = pageY + 'px';
    pfPlaneW = cols * PF_CELL;
    pfPlaneH = pageY;
    pfPlane.appendChild(frag);
    pfPanX = 0; pfPanY = 0; pfApplyPan();
    pfCount.textContent = `共 ${pfTracks.length} 首 · 拖动平移 · 点击封面居中放大 · 再次点击进入歌词MV`;
    syncPfPlaying();
    // 进入歌单自动行为：无播放 → 放大一首并播放；播放中为本歌单 → 居中该卡片；播放中为其他歌单 → 不动
    setTimeout(pfAutoFocusOnEnter, 60);
  };
  /* 进入歌单时的自动聚焦 / 播放策略
     - engine.current 为空（无曲目）→ 自动放大并播放本歌单第一首有封面的曲目
     - 正在播放的曲目属于本歌单 → 居中放大该曲目卡片（pfFocusTile 检测同 id 不重启播放）
     - 正在播放的曲目属于其他歌单 → 不放大、不自动播放 */
  const pfAutoFocusOnEnter = () => {
    if (folia.classList.contains('hidden')) return;
    if (!pfUniq.length || pfFocusEl) return;
    const cur = engine.current;
    if (!cur) {
      const s = pfUniq[0];
      const tile = [...pfPlane.children].find(el => el.dataset.tid === String(s.id));
      if (tile) pfFocusTile(tile, 0);
      return;
    }
    const tid = String(cur.songId);
    const idx = pfUniq.findIndex(s => String(s.id) === tid);
    if (idx >= 0) {
      const tile = [...pfPlane.children].find(el => el.dataset.tid === tid);
      if (tile) pfFocusTile(tile, idx);
    }
  };
  const openFolia = (pl) => {
    curPl = pl;
    pfName.textContent = pl.name || '歌单';
    folia.classList.remove('hidden');
    document.body.classList.add('pf-open');
    pfApplyBg();
    syncDetailFav();
    // 本地/用户歌单：曲目随对象传入，清场后立即渲染
    if (Array.isArray(pl.tracks) && pl.tracks.length) {
      pfTracks = pl.tracks;
      pfCount.textContent = `共 ${pl.tracks.length} 首 · 点击封面播放`;
      renderFolia();
      return;
    }
    // 在线歌单：openPlaylistDetail 可能已提前加载曲目并渲染
    if (pfTracks.length) {
      pfCount.textContent = `共 ${pfTracks.length} 首 · 点击封面播放`;
      if (pfPlane.children.length) {
        pfAutoFocusOnEnter(); // 已渲染 → 直接执行进入聚焦策略
      } else {
        renderFolia();
      }
      return;
    }
    // 曲目尚未加载
    pfCount.textContent = '加载中…';
    pfPlane.innerHTML = '';
    pfEmpty.classList.add('hidden');
    if (document.body.classList.contains('pl-full')) app._setPlFull?.(false);
  };
  const closeFolia = () => {
    folia.classList.add('hidden');
    document.body.classList.remove('pf-open');
    pfHero.classList.remove('on');
    pfSetFullscreen(false);
    pfUnfocus(false);
    if (pfSphere) { pfSphere.dispose(); pfSphere = null; }
    pfGrid.classList.remove('sphere-mode');
  };
  $('#btnPfBack').addEventListener('click', closeFolia);
  $('#btnPfPlayAll').addEventListener('click', () => {
    if (pfTracks.length) app.playOnlineAll(pfTracks);
    else toast('歌单还没有加载完成');
  });
  btnPfFav.addEventListener('click', () => { if (curPl) toggleFav(curPl); });
  /* 背景模式切换（跟随主页 / 跟随选中封面模糊） */
  let pfBgMode = (['home', 'cover'].includes(app.settings.pfBgMode) ? app.settings.pfBgMode : 'home');
  const pfBgSeg = $('#pfBgSeg');
  const syncPfBgSeg = () => {
    pfBgSeg.querySelectorAll('button').forEach(b => b.classList.toggle('active', b.dataset.bg === pfBgMode));
    pfGrid.dataset.bg = pfBgMode;
  };
  pfBgSeg.querySelectorAll('button').forEach(b => {
    b.addEventListener('click', () => {
      const m = b.dataset.bg;
      if (m === pfBgMode) return;
      pfBgMode = m;
      app.settings.pfBgMode = m;
      window.api.setSetting('pfBgMode', m);
      syncPfBgSeg();
      pfApplyBg();
    });
  });
  syncPfBgSeg();
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !folia.classList.contains('hidden')) closeFolia();
  });
  app._syncFolia = syncPfPlaying;

  /* 封面放大传送进入 Folia：克隆封面从卡片原位加速放大冲满屏幕，
     接近满屏时 Folia 在背后亮起，克隆体淡出 → “穿越封面进入歌单” */
  const portalOpenFolia = (pl, fromEl) => {
    document.querySelector('.pf-portal')?.remove(); // 防快速连点残留
    const img = fromEl?.querySelector('img');
    const r = img?.getBoundingClientRect();
    if (!r || !r.width) { openFolia(pl); return; }
    const ghost = document.createElement('div');
    ghost.className = 'pf-portal';
    const gi = document.createElement('img');
    gi.src = img.currentSrc || img.src;
    gi.referrerPolicy = 'no-referrer';
    gi.alt = '';
    ghost.appendChild(gi);
    ghost.style.left = (r.left + r.width / 2) + 'px';
    ghost.style.top = (r.top + r.height / 2) + 'px';
    ghost.style.width = r.width + 'px';
    ghost.style.height = r.height + 'px';
    document.body.appendChild(ghost);
    const sc = Math.max(window.innerWidth / r.width, window.innerHeight / r.height) * 1.08;
    const anim = ghost.animate([
      { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, filter: 'brightness(1)', offset: 0 },
      { transform: `translate(-50%, -50%) scale(${(sc * 0.52).toFixed(2)})`, opacity: 1, filter: 'brightness(1.28)', offset: 0.5 },
      { transform: `translate(-50%, -50%) scale(${sc.toFixed(2)})`, opacity: 1, filter: 'brightness(1.14)', offset: 0.82 },
      { transform: `translate(-50%, -50%) scale(${(sc * 1.05).toFixed(2)})`, opacity: 0, filter: 'brightness(1)', offset: 1 },
    ], { duration: 760, easing: 'cubic-bezier(0.42, 0, 0.7, 0.35)', fill: 'forwards' });
    setTimeout(() => openFolia(pl), 430); // 封面将近满屏时亮起拼图页
    anim.onfinish = () => ghost.remove();
  };

  const openPlaylistDetail = async (pl, fromEl) => {
    window.__rvOpenPl?.(pl); // 移动端钩子：拦截为普通歌曲列表（桌面端无此函数，不影响）
    portalOpenFolia(pl, fromEl);
    // 本地/用户歌单：曲目直接随对象传入，无需网络请求
    if (Array.isArray(pl.tracks)) {
      plTracks = pfTracks = pl.tracks;
      pfCount.textContent = plTracks.length ? `共 ${plTracks.length} 首 · 点击封面播放` : '歌单为空';
      renderFolia();
      return;
    }
    try {
      // 路由：pl:srcId:原始id → 对应音源；裸数字 id → 兼容旧网易云收藏
      const det = await window.api.sourcePlaylistDetail(pl.id);
      plTracks = pfTracks = det?.tracks || [];
      if (det?.name) pfName.textContent = det.name;
      pfCount.textContent = plTracks.length ? `共 ${plTracks.length} 首 · 点击封面播放` : (det?.msg || '歌单为空');
      renderFolia();
    } catch {
      pfCount.textContent = '加载失败 — 检查网络后重试';
    }
  };
  els.btnPlayAll.addEventListener('click', () => {
    if (!plTracks.length) { toast('歌单还没有加载完成'); return; }
    app.playOnlineAll(plTracks);
  });
  els.btnFavDetail.addEventListener('click', () => { if (curPl) toggleFav(curPl); });

  /* --- 背景更换（选图 / 预设渐变 / 清除） --- */
  els.btnBgPick.addEventListener('click', async () => {
    const dataUrl = await window.api.pickBackground();
    if (!dataUrl) return;
    document.getElementById('userBg')?.querySelector('video')?.remove();
    app.settings.bgVideo = null;
    window.api.setSetting('bgVideo', null);
    app.settings.bg = dataUrl;
    app.settings.bgPreset = null;
    window.api.setSetting('bg', dataUrl);
    window.api.setSetting('bgPreset', null);
    app.applyBg(dataUrl);
    toast('背景已更换');
  });
  els.btnBgClear.addEventListener('click', () => {
    app.settings.bgPreset = null;
    window.api.setSetting('bgPreset', null);
    app.clearCustomBg();
    toast('已恢复可视化画面');
  });
  /* 背景渐变预设：仅 data-bgp 色板（启动页 sp-sw / 主题颜色 uh-sw 虽同用 fx-swatch 样式，但不碰自定义背景） */
  document.querySelectorAll('.fx-swatch[data-bgp]').forEach(b => {
    b.addEventListener('click', () => {
      app.clearCustomBg(); // 移除可能存在的图片/视频背景
      app.settings.bgPreset = b.dataset.bgp;
      window.api.setSetting('bgPreset', b.dataset.bgp);
      app.applyBg(null, b.dataset.bgp);
      toast('背景：' + b.title);
    });
  });

  /* --- 启动页色板：跟随背景（默认）或固定色相 --- */
  document.querySelectorAll('.sp-sw').forEach(b => {
    b.addEventListener('click', () => {
      app.settings.splash = b.dataset.sp;
      window.api.setSetting('splash', b.dataset.sp);
      document.querySelectorAll('.sp-sw').forEach(x => x.classList.toggle('on', x === b));
      app.applySplashTheme?.();
      toast(b.dataset.sp === 'follow' ? '启动页：跟随背景颜色' : '启动页：' + b.title);
    });
  });
  // 恢复启动页色板选中态
  const spOpt = app.settings.splash ?? 'follow';
  document.querySelectorAll('.sp-sw').forEach(x => x.classList.toggle('on', x.dataset.sp === String(spOpt)));

  /* --- 启动页自定义颜色：color picker 选任意色 → 转 hue 写入 settings.splash，与色板共用 applySplashTheme --- */
  const spCustomColor = $('#spCustomColor'), spCustomApply = $('#spCustomApply'), spCustomReset = $('#spCustomReset');
  if (spCustomApply) {
    spCustomApply.addEventListener('click', () => {
      const hex = spCustomColor.value;
      // hex → hsl hue（标准转换）
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let h = 0;
      if (mx !== mn) {
        const d = mx - mn;
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (mx === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
      }
      app.settings.splash = String(Math.round(h));
      window.api.setSetting('splash', String(Math.round(h)));
      document.querySelectorAll('.sp-sw').forEach(x => x.classList.toggle('on', false));
      app.applySplashTheme?.();
      toast('启动页：自定义颜色已应用');
    });
  }
  if (spCustomReset) {
    spCustomReset.addEventListener('click', () => {
      app.settings.splash = 'follow';
      window.api.setSetting('splash', 'follow');
      document.querySelectorAll('.sp-sw').forEach(x => x.classList.toggle('on', x.dataset.sp === 'follow'));
      app.applySplashTheme?.();
      toast('启动页：恢复跟随背景颜色');
    });
  }

  /* --- 主题颜色（THEME 分区）：跟随封面（默认）或固定色相 → theme.setFixedHue 覆盖 --accent/--pal-hue，
         封面对比色回调在 theme.js 内 gate（uiHue !== 'follow' 时取色结果不落地），切歌不变色 --- */
  const applyUiHue = (v) => {
    app.settings.uiHue = v;
    window.api.setSetting('uiHue', v);
    app.theme.setFixedHue(v);
    const s = String(v);
    document.querySelectorAll('.uh-sw').forEach(x => x.classList.toggle('on', x.dataset.uh === s)); // 自定义色不命中预设 → 全不选中
  };
  document.querySelectorAll('.uh-sw').forEach(b => {
    b.addEventListener('click', () => {
      applyUiHue(b.dataset.uh);
      toast(b.dataset.uh === 'follow' ? '主题颜色：跟随封面取色' : '主题颜色：' + b.title);
    });
  });
  // 启动恢复：settings 已加载；固定主题色立即应用（幂等，先于任何曲目封面取色），follow 则保持现状不重置
  const uhOpt = app.settings.uiHue ?? 'follow';
  document.querySelectorAll('.uh-sw').forEach(x => x.classList.toggle('on', x.dataset.uh === String(uhOpt)));
  if (uhOpt !== 'follow') app.theme.setFixedHue(uhOpt);
  // 主题自定义颜色：color picker 选任意色 → hex 转 hue，与启动页自定义同款转换
  const uhCustomColor = $('#uhCustomColor'), uhCustomApply = $('#uhCustomApply'), uhCustomReset = $('#uhCustomReset');
  if (uhCustomApply) {
    uhCustomApply.addEventListener('click', () => {
      const hex = uhCustomColor.value;
      const r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      let h = 0;
      if (mx !== mn) {
        const d = mx - mn;
        if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) * 60;
        else if (mx === g) h = ((b - r) / d + 2) * 60;
        else h = ((r - g) / d + 4) * 60;
      }
      applyUiHue(Math.round(h));
      toast('主题颜色：自定义颜色已应用');
    });
  }
  if (uhCustomReset) {
    uhCustomReset.addEventListener('click', () => {
      applyUiHue('follow');
      toast('主题颜色：恢复跟随封面取色');
    });
  }

  /* --- 启动页自定义背景图：选图铺满 + 深色压暗罩，绸带/网格/星尘仍在其上；清除恢复纯色渐变主题。
         settings.splashBg 持久化 + localStorage（spBgImg）双写兜底，boot 同步读取避免启动页闪默认主题 --- */
  $('#spBgPick')?.addEventListener('click', async () => {
    const dataUrl = await window.api.pickBackground();
    if (!dataUrl) return;
    app.settings.splashBg = dataUrl;
    window.api.setSetting('splashBg', dataUrl);
    try { localStorage.setItem('spBgImg', dataUrl); } catch { /* 超出配额则跳过，settings IPC 仍持久化 */ }
    app.applySplashBg(dataUrl);
    app.applySplashTheme?.(); // 启动页「跟随背景」模式：立即按新背景图重取色相
    toast('启动页背景图已应用');
  });
  $('#spBgClear')?.addEventListener('click', () => {
    app.settings.splashBg = null;
    window.api.setSetting('splashBg', null);
    localStorage.removeItem('spBgImg');
    app.applySplashBg(null);
    app.applySplashTheme?.(); // 跟随模式：回到默认冷蓝
    toast('启动页：已恢复默认渐变主题');
  });

  /* --- 歌词文字特效滑条（发光 / 描边 / 投影） --- */
  const saveTextFx = () => {
    const fx = { glow: +els.fxGlow.value, stroke: +els.fxStroke.value, shadow: +els.fxShadow.value };
    app.lyrics.setTextFx(fx);
    app.settings.textFx = fx;
    window.api.setSetting('textFx', fx);
  };
  els.fxGlow.addEventListener('input', () => { els.fxGlowV.textContent = els.fxGlow.value; saveTextFx(); });
  els.fxStroke.addEventListener('input', () => { els.fxStrokeV.textContent = els.fxStroke.value; saveTextFx(); });
  els.fxShadow.addEventListener('input', () => { els.fxShadowV.textContent = els.fxShadow.value; saveTextFx(); });

  /* --- 氛围滑条：背景模糊 / 背景亮度（全局：封面色晕层 + 自定义图片/视频背景一起生效） --- */
  const applyMood = () => {
    const blur = +els.fxBgBlur.value, bright = +els.fxBgBright.value;
    const f = `blur(${blur}px) saturate(1.5) brightness(${(bright / 100).toFixed(2)})`;
    els.albumBg.style.filter = f;
    els.albumBg.style.opacity = '';
    const ub = document.getElementById('userBg');
    if (ub) ub.style.filter = f;
    app.settings.bgBlur = blur; app.settings.bgBright = bright;
    window.api.setSetting('bgBlur', blur);
    window.api.setSetting('bgBright', bright);
  };
  els.fxBgBlur.addEventListener('input', () => { els.fxBgBlurV.textContent = els.fxBgBlur.value; applyMood(); });
  els.fxBgBright.addEventListener('input', () => { els.fxBgBrightV.textContent = els.fxBgBright.value; applyMood(); });
  els.fxBgBlur.dispatchEvent(new Event('input')); // 初始化

  /* --- 全局玻璃透明度（GLOBAL 分区）：--glass-a 直接驱动主玻璃表面背景 alpha（blur 不变），
         --glass-a2 为深一档（弹层/Toast/迷你窗），在 :root 以 calc 自动跟随，实时生效 --- */
  const applyGlassA = (v) => {
    v = Math.max(10, Math.min(90, Math.round(+v || 45)));
    els.fxGlass.value = v;
    els.fxGlassV.textContent = v;
    document.documentElement.style.setProperty('--glass-a', (v / 100).toFixed(3));
    app.settings.glass = v;
    window.api.setSetting('glass', v);
  };
  els.fxGlass.addEventListener('input', () => applyGlassA(els.fxGlass.value));

  /* --- 全局亮度（GLOBAL 分区）：app.applyUiBright 写 body::after 全屏遮罩变量（不拦截点击），实时生效 --- */
  const applyGlBright = (v) => {
    v = Math.max(60, Math.min(130, Math.round(+v || 100)));
    els.glBright.value = v;
    els.glBrightV.textContent = v;
    app.applyUiBright(v);
    app.settings.uiBright = v;
    window.api.setSetting('uiBright', v);
  };
  els.glBright.addEventListener('input', () => applyGlBright(els.glBright.value));

  /* --- 全局 UI 字体（GLOBAL 分区）：写 --ui-font 仅作用于界面文字；歌词字体走 --lyric-font 独立生效、绝不受影响 --- */
  const setUiFont = (f, silent) => {
    app.applyUiFont(f);
    app.settings.uiFont = f;
    window.api.setSetting('uiFont', f);
    document.querySelectorAll('#uiFontSeg button').forEach(b =>
      b.classList.toggle('active', b.dataset.uf === f));
    if (!silent) toast('界面字体：' + (document.querySelector(`#uiFontSeg button[data-uf="${CSS.escape(f)}"]`)?.textContent || '默认'));
  };
  document.querySelectorAll('#uiFontSeg button').forEach(b =>
    b.addEventListener('click', () => setUiFont(b.dataset.uf)));

  /* --- 开关：封面取色 / 鼓点弹跳 / 歌词动画 --- */
  const bindToggle = (el, key, onTxt, offFn, onFn) => {
    el.addEventListener('click', () => {
      const on = !el.classList.contains('on');
      el.classList.toggle('on', on);
      window.api.setSetting(key, on);
      app.settings[key.replace('tgl', '').replace(/^./, c => c.toLowerCase())] = on;
      on ? onFn() : offFn();
      toast(el.title.replace(/（.*）/, '') + '：' + (on ? '开' : '关'));
    });
  };
  bindToggle(els.tglTheme, 'adaptiveTheme', '', () => { app.adaptiveTheme = false; app.theme.reset(); }, () => { app.adaptiveTheme = true; app.theme.applyFromTrack(app.engine.current); });
  bindToggle(els.tglBounce, 'beatBounce', '', () => { app.beatBounce = false; app.lyrics.bounce = false; }, () => { app.beatBounce = true; app.lyrics.bounce = true; });
  bindToggle(els.tglAnim, 'lyricAnim', '', () => { app.lyricAnim = false; app.lyrics.anim = false; document.body.classList.remove('anim-on'); }, () => { app.lyricAnim = true; app.lyrics.anim = true; document.body.classList.add('anim-on'); });
  // 初始化开关状态
  const syncToggle = (el, on) => el.classList.toggle('on', on);
  syncToggle(els.tglTheme, app.adaptiveTheme !== false);
  syncToggle(els.tglBounce, app.beatBounce !== false);
  syncToggle(els.tglAnim, app.lyricAnim !== false);
  if (app.lyricAnim !== false) document.body.classList.add('anim-on');
  // 恢复滑条值
  if (app.settings.textFx) {
    els.fxGlow.value = app.settings.textFx.glow ?? 18;
    els.fxStroke.value = app.settings.textFx.stroke ?? 0;
    els.fxShadow.value = app.settings.textFx.shadow ?? 30;
    els.fxGlowV.textContent = els.fxGlow.value; els.fxStrokeV.textContent = els.fxStroke.value; els.fxShadowV.textContent = els.fxShadow.value;
    app.lyrics.setTextFx(app.settings.textFx);
  }
  if (app.settings.glass != null) els.fxGlass.value = app.settings.glass;
  if (app.settings.bgBlur != null) els.fxBgBlur.value = app.settings.bgBlur;
  if (app.settings.bgBright != null) els.fxBgBright.value = app.settings.bgBright;
  els.fxGlass.dispatchEvent(new Event('input'));
  // 全局亮度 / 全局字体恢复（亮度遮罩变量已在 boot 提前应用，此处同步滑块并幂等重写）
  applyGlBright(app.settings.uiBright ?? 100);
  setUiFont(app.settings.uiFont || '', true);

  /* --- 模式按钮：全屏歌词 / 专注模式 / 迷你悬浮窗 / 视频背景 --- */
  els.btnFullLyric.addEventListener('click', () => { app.toggleFullLyric(); els.fxPanel.classList.remove('open'); });
  els.btnFocus.addEventListener('click', () => { app.toggleFocus(); els.fxPanel.classList.remove('open'); });
  els.btnMini.addEventListener('click', () => { window.api.openMini?.(); toast('迷你播放器已打开'); });
  els.btnBgVideo.addEventListener('click', async () => {
    const src = await window.api.pickBackgroundVideo?.();
    if (!src) return;
    app.applyVideoBg(src);
    toast('视频背景已启用（自动静音循环）');
  });

  loadFeed();
  // 启动时若已存在登录态（Cookie 回灌），静默拉取账号云歌单，并按默认音源过滤分组
  app.refreshAccountPls?.();
  app.syncDefaultSrc?.();

  return { openDrawer, switchTab, goHome };
}

/* ---------- 首页：最近在线 ---------- */
export function renderHomeRecent(app) {
  const row = document.getElementById('homeRecentRow');
  const stats = document.getElementById('homeStats');
  if (!row) return;
  const hist = app.settings?.onlineHistory || [];
  const qn = app.engine.queue.filter(t => t.source !== 'demo').length;
  stats.textContent = qn ? `队列 ${qn} 首 · 在线 ${hist.length} 条` : '本地与在线播放记录都会沉淀在这里';
  row.innerHTML = '';
  if (!hist.length) {
    const tip = document.createElement('div');
    tip.className = 'rail-empty';
    tip.textContent = '还没有在线播放记录 — 搜一首歌，封面会落在这里';
    row.appendChild(tip);
    return;
  }
  hist.slice(0, 12).forEach((song) => {
    const item = document.createElement('button');
    item.className = 'rail-item';
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.referrerPolicy = 'no-referrer';
    img.alt = '';
    if (song.coverUrl) { img.src = song.coverUrl; img.onerror = () => { img.onerror = null; img.src = COVER_FALLBACK; }; }
    else img.src = COVER_FALLBACK;
    const name = document.createElement('div');
    name.className = 'ri-name';
    name.textContent = song.name;
    const artist = document.createElement('div');
    artist.className = 'ri-artist';
    artist.textContent = song.artist || '';
    item.append(img, name, artist);
    item.addEventListener('click', () => app.playOnline(song));
    row.appendChild(item);
  });
}

/* ---------- 列表渲染 ---------- */
function trackItem({ cover, name, artist, dur, tag, playing, onPlay, onRemove }) {
  const li = document.createElement('li');
  li.className = 'track-item' + (playing ? ' playing' : '');
  const img = document.createElement('img');
  img.className = 'ti-cover';
  img.loading = 'lazy';
  if (cover) { img.src = cover; img.onerror = () => { img.style.visibility = 'hidden'; }; }
  else img.style.visibility = 'hidden';
  const txt = document.createElement('div');
  txt.className = 'ti-text';
  txt.innerHTML = `<div class="ti-name"></div><div class="ti-artist"></div>`;
  txt.querySelector('.ti-name').textContent = name;
  txt.querySelector('.ti-artist').textContent = artist || '';
  li.append(img, txt);
  if (tag) {
    const tg = document.createElement('span');
    tg.className = 'ti-tag';
    tg.textContent = tag;
    li.appendChild(tg);
  }
  if (dur) {
    const d = document.createElement('span');
    d.className = 'ti-dur';
    d.textContent = fmtTime(dur);
    li.appendChild(d);
  }
  if (onRemove) {
    const rm = document.createElement('button');
    rm.className = 'ti-remove';
    rm.textContent = '✕';
    rm.title = '移除';
    rm.addEventListener('click', (e) => { e.stopPropagation(); onRemove(); });
    li.appendChild(rm);
  }
  li.addEventListener('click', onPlay);
  return li;
}

function renderLocalList(ul, queue, index, { play, remove }) {
  ul.innerHTML = '';
  queue.forEach((t, i) => {
    ul.appendChild(trackItem({
      cover: t.coverBlob || t.coverUrl || '',
      name: t.title, artist: t.artist, dur: t.duration,
      tag: t.source === 'online' ? '在线' : t.source === 'demo' ? '演示' : '',
      playing: i === index,
      onPlay: () => play(i),
      onRemove: () => remove(i)
    }));
  });
}

function renderOnlineList(ul, songs, onPlay) {
  ul.innerHTML = '';
  songs.forEach((s) => {
    ul.appendChild(trackItem({
      cover: s.coverUrl || '',
      name: s.name, artist: s.artist, dur: s.duration, tag: '在线',
      onPlay: () => onPlay(s)
    }));
  });
}

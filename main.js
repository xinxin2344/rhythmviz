import { app, BrowserWindow, ipcMain, dialog, nativeImage, Tray, Menu } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Store from 'electron-store';
import { parseFile } from 'music-metadata';
import { SourceManager, registerSourceIPC } from './sources/manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Windows 任务栏图标归属：开发态跑的是 node_modules 里的 electron.exe，
// 不设置独立 AUMID 会回退显示 Electron 默认图标
if (process.platform === 'win32') app.setAppUserModelId('com.tang.rhythmviz');

/** 窗口图标：优先多尺寸 ico，异常时回退 png，避免空图标 */
function appIcon() {
  const ico = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico'));
  if (!ico.isEmpty()) return ico;
  return nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
}

const sourceMgr = new SourceManager();
sourceMgr.onNotify = (msg) => { try { win?.webContents.send('source:notify', msg); } catch { /* noop */ } };

const store = new Store({
  defaults: {
    volume: 0.8,
    scene: 'cover',
    lyricStyle: 'flow',
    shuffle: false,
    localPaths: [],
    onlineHistory: []
  }
});

const AUDIO_EXT = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav', '.wma', '.ape']);

let win = null;
let quitting = false;
let tray = null;

/* 托盘：首次最小化到托盘时懒创建；点击图标恢复窗口，右键菜单可退出 */
function showMainWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}
function createTray() {
  tray = new Tray(appIcon());
  tray.setToolTip('律动 RhythmViz — 点击恢复窗口');
  tray.on('click', showMainWindow);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示主界面', click: showMainWindow },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } }
  ]));
}
function hideToTray() {
  if (!win) return;
  win.hide();
  if (!tray) createTray();
  // 首次进托盘提示（仅一次）
  if (!store.get('trayTipShown')) {
    try { tray.displayBalloon({ title: '律动 RhythmViz', content: '已最小化到系统托盘，音乐继续播放，点击托盘图标恢复窗口。' }); } catch { /* 无气球通知的系统忽略 */ }
    store.set('trayTipShown', true);
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 960,
    minHeight: 600,
    show: false,
    frame: false,
    backgroundColor: '#08090B',
    title: '律动 RhythmViz',
    icon: appIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('maximize', () => win.webContents.send('win:maximized', true));
  win.on('unmaximize', () => win.webContents.send('win:maximized', false));
  // 最小化时暂停 Three.js/Canvas 渲染省电（渲染层收消息后 scenes.setPaused）
  win.on('minimize', () => win.webContents.send('win:minimized', true));
  win.on('restore', () => win.webContents.send('win:minimized', false));
  // 关闭拦截：直接退出放行；最小化到托盘隐藏窗口；每次询问转发渲染层弹窗（✕ 按钮与 Alt+F4 统一走这里）
  win.on('close', (e) => {
    if (quitting) return;
    const act = store.get('closeAction', 'ask');
    if (act === 'exit') return;
    e.preventDefault();
    if (act === 'minimize') hideToTray();
    else win.webContents.send('win:close-ask');
  });

  // 转发渲染进程日志到终端，便于调试；自动测试结束后退出
  win.webContents.on('console-message', (_e, level, message) => {
    if (process.argv.includes('--dev') || process.env.MUSICPLAYER_AUTOTEST === '1' || process.env.MUSICPLAYER_SHOT) {
      console.log('[renderer]', message);
    }
    if (process.env.MUSICPLAYER_AUTOTEST === '1' && message.includes('AUTOTEST_DONE')) {
      console.log('[autotest] success');
      setTimeout(() => app.quit(), 500);
    }
  });
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

/* 单实例锁：重复启动时聚焦已有窗口（自动化测试/CDP 调试实例豁免，便于并行调试） */
const SINGLE_INSTANCE_OK = !process.argv.some((a) => a.startsWith('--remote-debugging-port'))
  && process.env.MUSICPLAYER_AUTOTEST !== '1';
if (SINGLE_INSTANCE_OK) {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) app.quit();
  else {
    app.on('second-instance', () => {
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
}

app.whenReady().then(async () => {
  createWindow();
  registerSourceIPC(sourceMgr);
  sourceMgr.loadPersisted().catch(() => {});

  // —— 登录模块：安装时可选（打包态从 resources/login/ 加载，开发态从源码加载）——
  // 注意打包态必须是 .mjs：Node 按「最近的 package.json」判定 .js 模块类型，
  // resources/login 下没有 package.json 会把 ESM 当 CJS 解析 → import 语句抛错（登录页显示没有平台）
  // 兼容免安装运行（win-unpacked / 绿色版）：安装器只在「真正安装」时把 login_src 拷成 login，
  // 直接运行解包目录时 login 不存在，回退到安装包预置的暂存目录 login_src。
  try {
    let qPath;
    if (app.isPackaged) {
      const loginFinal = path.join(process.resourcesPath, 'login', 'qrologin.mjs');
      const loginStage = path.join(process.resourcesPath, 'login_src', 'qrologin.mjs');
      qPath = fsSync.existsSync(loginFinal) ? loginFinal : loginStage;
    } else {
      qPath = path.join(__dirname, 'sources', 'qrologin.js');
    }
    const qUrl = pathToFileURL(qPath).href;
    const qm = await import(qUrl);
    qm.registerQrLoginIPC(sourceMgr, () => win);
    qm.restoreLoginCookies(sourceMgr);
    console.log('[login] 扫码登录模块已加载:', qPath);
  } catch (e) {
    console.warn('[login] 扫码登录模块未安装或加载失败：', e.message);
  }

  // —— 音源插件加载（installer.nsh 可选 copy 到 resources/plugins/）——
  // 优先级：开发态源码 → 打包态 resources/plugins → 用户外部插件覆盖
  // 暂存目录 resources/plug_src 为最后兜底：免安装直接运行 win-unpacked 时，
  // 安装器未执行、resources/plugins 尚不存在，但预置插件随包解压在 plug_src 中。
  const loaders = [];
  if (app.isPackaged) {
    loaders.push(path.join(app.getPath('userData'), 'plugins'));   // 用户外部插件（最高优先级）
    loaders.push(path.join(process.resourcesPath, 'plugins'));     // 安装器拷贝的已选组件
    loaders.push(path.join(process.resourcesPath, 'plug_src'));    // 安装包预置暂存（免安装兜底）
  } else {
    loaders.push(path.join(__dirname, 'sources', 'plugins'));      // 开发态源码
  }
  for (const d of loaders) {
    try { await sourceMgr.loadPluginsDir(d); } catch { /* 目录不存在或加载失败均降级到下一路径 */ }
  }
  if (process.env.MUSICPLAYER_AUTOTEST === '1') {
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win?.webContents.send('autotest:start'), 1000);
    });
  }
  if (process.env.MUSICPLAYER_SRCTEST === '1') {
    (async () => {
      try {
        const p = path.join(__dirname, 'sources', 'sample-source.demo.js');
        const r = await sourceMgr.importFromFile(p);
        console.log('[srctest] import:', r.id, 'v' + r.version);
        console.log('[srctest] list:', sourceMgr.list().map((s) => s.id + (s.enabled ? '(on)' : '(off)')).join(','));
        const m = await sourceMgr._matchInSource('sample-demo', 'SoundHelix Song', '');
        console.log('[srctest] match:', m?.id, m?.name);
        const res = await sourceMgr.resolvePlayUrl({ srcId: 'sample-demo', id: 'sh-1', title: 'SoundHelix Song 1', artist: 'T. Schürger' });
        console.log('[srctest] playurl:', res.url ? 'OK ' + String(res.url).slice(0, 64) : 'FAIL ' + res.msg);
        // Range 分段拉取首 256KB 验证链路（完整 6MB 测试音频在慢速网络下载过久）
        const bin = await sourceMgr.hostRequest({
          url: res.url, encoding: 'buffer', timeout: 30000,
          headers: { ...(res.headers || {}), Range: 'bytes=0-262143' }
        });
        console.log('[srctest] audioBin:', bin.body.length, 'bytes, status=' + bin.status);
        const ly = await sourceMgr.getLyric('sample-demo', 'sh-1');
        console.log('[srctest] lyric:', ly.lrc.split('\n').length, 'lines');
        const st = sourceMgr.list().find((s) => s.id === 'sample-demo');
        console.log('[srctest] stats:', JSON.stringify(st.stats));
        console.log('[srctest] SRCTEST_DONE');
      } catch (e) {
        console.error('[srctest] FAIL', e.message);
      } finally {
        sourceMgr.remove('sample-demo'); // 测试导入不残留
        setTimeout(() => app.quit(), 400);
      }
    })();
  }
  if (process.env.MUSICPLAYER_NETTEST === '1') {
    (async () => {
      try {
        // 插件音源端到端：feed → 聚合搜索 → 播放地址 → 分段拉流
        const feed = await sourceMgr.feed();
        console.log(`[nettest] feed: hot=${feed.hot.length}, playlists=${feed.playlists.length}, first=${feed.hot[0]?.name}`);
        const songs = await sourceMgr.searchAll(feed.hot[0]?.name || 'summer');
        console.log(`[nettest] searchAll: ${songs.length} results, first = ${songs[0]?.name} / ${songs[0]?.artist} / src=${songs[0]?.srcId}`);
        const sid = songs[0]?.srcId || 'netease';
        const res = await sourceMgr.resolvePlayUrl({ srcId: sid, id: songs[0].id, title: songs[0].name, artist: songs[0].artist });
        console.log(`[nettest] playurl: ${res.url ? 'OK ' + res.url.slice(0, 80) : 'FAIL ' + res.msg}`);
        if (res.url) {
          // Range 分段拉流验证（完整音频在慢速网络下载过久）
          const bin = await sourceMgr.hostRequest({ url: res.url, headers: { ...(res.headers || {}), Range: 'bytes=0-262143' }, encoding: 'buffer', timeout: 30000 });
          console.log(`[nettest] audioBin: ${bin.body.length} bytes, status=${bin.status}`);
        }
        const pls = feed.playlists;
        console.log(`[nettest] playlists: ${pls.length}, first = ${pls[0]?.name}`);
        if (pls[0]) {
          const det = await sourceMgr.playlistDetail(pls[0].id);
          console.log(`[nettest] plDetail: "${det.name}" tracks=${det.tracks.length}, first = ${det.tracks[0]?.name} / src=${det.tracks[0]?.srcId}`);
        }
        console.log('[nettest] NETTEST_DONE');
      } catch (e) {
        console.error('[nettest] FAIL', e.message);
      } finally {
        setTimeout(() => app.quit(), 300);
      }
    })();
  }
  if (process.env.MUSICPLAYER_SHOT) {
    const scene = process.env.SHOT_SCENE || 'cover';
    win.webContents.once('did-finish-load', () => {
      setTimeout(() => win?.webContents.send('shot:start', scene, process.env.SHOT_SEARCH || ''), 600);
    });
    setTimeout(async () => {
      try {
        const img = await win.webContents.capturePage();
        await fs.writeFile(process.env.MUSICPLAYER_SHOT, img.toPNG());
        console.log('[shot] saved:', process.env.MUSICPLAYER_SHOT);
      } catch (e) {
        console.error('[shot] FAIL', e.message);
      }
      setTimeout(() => app.quit(), 400);
    }, Number(process.env.SHOT_DELAY || 4200));
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());

/* ---------------- 窗口控制（自定义标题栏） ---------------- */
ipcMain.on('win:minimize', () => win?.minimize());
ipcMain.on('win:maximize', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize();
  else win.maximize();
});
/* 窗口级全屏切换：Folia 拼图点击封面进入沉浸全屏，返回/取消焦点时退出（不影响单实例与最小化还原逻辑） */
ipcMain.on('win:set-fullscreen', (_e, on) => win?.setFullScreen(!!on));

/* ---------------- 迷你悬浮播放器（置顶可拖动） ---------------- */
let miniWin = null;
function createMini() {
  if (miniWin) { miniWin.focus(); return; }
  miniWin = new BrowserWindow({
    width: 340, height: 96,
    frame: false, transparent: true,
    alwaysOnTop: true, resizable: false, skipTaskbar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, backgroundThrottling: false }
  });
  miniWin.setAlwaysOnTop(true, 'screen-saver');
  miniWin.loadFile(path.join(__dirname, 'src', 'mini.html'));
  miniWin.on('closed', () => { miniWin = null; });
}
ipcMain.on('mini:open', () => createMini());
ipcMain.on('mini:sync', (_e, st) => { if (miniWin && !miniWin.isDestroyed()) miniWin.webContents.send('mini:sync', st); });
ipcMain.on('mini:cmd', (_e, cmd) => { win?.webContents.send('mini:cmd', cmd); });
ipcMain.on('mini:close', () => miniWin?.close());

/* ---------------- 背景视频选择：返回 file:// 路径（页面 file:// 下 media-src 'self' 可加载） ---------------- */
ipcMain.handle('bg:pick-video', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择循环视频背景',
    properties: ['openFile'],
    filters: [{ name: '视频', extensions: ['mp4', 'webm', 'mkv', 'mov', 'avi'] }]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return 'file://' + r.filePaths[0].replace(/\\/g, '/');
});
ipcMain.on('win:close', () => win?.close());
/* 关闭确认弹窗选择：可记住（写入 closeAction），最小化进托盘或真正退出 */
ipcMain.on('win:close-choice', (_e, p) => {
  const action = p?.action === 'minimize' ? 'minimize' : 'exit';
  if (p?.remember) store.set('closeAction', action);
  if (action === 'minimize') hideToTray();
  else { quitting = true; win?.close(); }
});

/* ---------------- 设置 ---------------- */
ipcMain.handle('settings:get', () => store.store);
ipcMain.handle('settings:set', (_e, key, val) => {
  if (typeof key === 'string') store.set(key, val);
  else if (key && typeof key === 'object') {
    for (const [k, v] of Object.entries(key)) store.set(k, v);
  }
  return true;
});

/* ---------------- 本地文件 ---------------- */
ipcMain.handle('dialog:open-audio', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音乐文件',
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma', 'ape'] }]
  });
  if (r.canceled) return [];
  return r.filePaths.filter(p => AUDIO_EXT.has(path.extname(p).toLowerCase()));
});

/* 通用图片选择：返回 dataURL 供渲染层直接使用（背景 / 歌单封面等） */
const pickImageData = async (title) => {
  const r = await dialog.showOpenDialog(win, {
    title,
    properties: ['openFile'],
    filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp', 'avif'] }]
  });
  if (r.canceled || !r.filePaths.length) return null;
  try {
    const buf = await fs.readFile(r.filePaths[0]);
    const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase();
    const mime = ext === 'jpg' ? 'jpeg' : ext;
    return `data:image/${mime};base64,${buf.toString('base64')}`;
  } catch { return null; }
};
ipcMain.handle('bg:pick', () => pickImageData('选择背景图片'));
ipcMain.handle('img:pick', (_e, title) => pickImageData(title || '选择图片'));

/* 音源插件文件选择：返回本地 js 路径（由用户显式导入） */
ipcMain.handle('dialog:open-js', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音源插件 JS 文件',
    properties: ['openFile'],
    filters: [{ name: '音源插件', extensions: ['js'] }]
  });
  if (r.canceled || !r.filePaths.length) return null;
  return r.filePaths[0];
});

ipcMain.handle('dialog:open-folder', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: '选择音乐文件夹',
    properties: ['openDirectory']
  });
  if (r.canceled) return [];
  const dir = r.filePaths[0];
  const out = [];
  async function walk(d, depth) {
    if (depth > 3) return;
    let entries;
    try { entries = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) await walk(full, depth + 1);
      else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) out.push(full);
    }
  }
  await walk(dir, 0);
  return out;
});

ipcMain.handle('file:read', async (_e, p) => {
  const buf = await fs.readFile(p);
  return buf;
});

ipcMain.handle('file:text', async (_e, p) => {
  try { return await fs.readFile(p, 'utf8'); } catch { return null; }
});

// 自动查找同目录同名 .lrc 歌词
ipcMain.handle('file:find-lyric', async (_e, audioPath) => {
  const dir = path.dirname(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const candidates = [
    path.join(dir, base + '.lrc'),
    path.join(dir, base + '.LRC'),
    path.join(dir, path.basename(audioPath) + '.lrc')
  ];
  for (const c of candidates) {
    try {
      const text = await fs.readFile(c, 'utf8');
      if (text && text.trim()) return { path: c, text };
    } catch { /* continue */ }
  }
  return null;
});

ipcMain.handle('meta:parse', async (_e, p) => {
  try {
    const meta = await parseFile(p, { duration: false });
    const pic = meta.common.picture?.[0];
    return {
      title: meta.common.title || path.basename(p, path.extname(p)),
      artist: (meta.common.artist || '未知艺术家'),
      album: meta.common.album || '',
      duration: meta.format.duration || 0,
      picture: pic ? { data: pic.data, format: pic.format || 'image/jpeg' } : null
    };
  } catch {
    return { title: path.basename(p, path.extname(p)), artist: '未知艺术家', album: '', duration: 0, picture: null };
  }
});

/* ---------------- 在线音源：全部经 sources/manager 统一调度（全部为用户外部插件） ----------------
   平台逆向接口一律不在主程序内 —— 见 sources/plugins/（用户自担责任的独立插件）。 */

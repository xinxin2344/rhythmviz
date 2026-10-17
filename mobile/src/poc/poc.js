/* PoC 页：APK 内验证原生网络链路（两源搜索 / 播放地址 / 音频二进制 / 网易出码） */
import { MobileSourceManager } from '../host/manager.js';
import { QrLoginManager } from '../host/qrlogin.js';
import { installGlobals } from '../buffer-poly.js';

installGlobals();

const $out = document.getElementById('out');
const log = (...a) => {
  const line = a.map((x) => typeof x === 'string' ? x : JSON.stringify(x, null, 1)).join(' ');
  $out.textContent += '\n' + line;
  $out.scrollTop = $out.scrollHeight;
};

async function main() {
const mgr = new MobileSourceManager();
await mgr.init();
const qr = new QrLoginManager(mgr);
window.__rv = { mgr, qr };
log('宿主就绪，平台:', window.Capacitor?.getPlatform?.() || 'web');

function btn(id, fn) {
  document.getElementById(id).addEventListener('click', async () => {
    try { await fn(); } catch (e) { log('[错误]', e.stack || e.message); }
  });
}

btn('search-ne', async () => {
  const r = await mgr.search('netease', '周杰伦 晴天', 1);
  log('[网易] 结果', r.length, '条；首条:', { id: r[0]?.id, name: r[0]?.name, artist: r[0]?.artist, fee: r[0]?.fee });
});
btn('search-qq', async () => {
  const r = await mgr.search('qq', '周杰伦 晴天', 1);
  log('[QQ] 结果', r.length, '条；首条:', { id: r[0]?.id, name: r[0]?.name, artist: r[0]?.artist });
});
btn('play-ne', async () => {
  const r = await mgr.search('netease', '晴天 周杰伦', 1);
  const s = r[0];
  const u = await mgr.resolvePlayUrl({ srcId: 'netease', id: s.id, title: s.name, artist: s.artist });
  log('[网易播放]', { via: u.via, newId: u.newId, url: u.url?.slice(0, 150), msg: u.msg });
});
btn('play-qq', async () => {
  const r = await mgr.search('qq', '晴天 周杰伦', 1);
  const s = r[0];
  const u = await mgr.resolvePlayUrl({ srcId: 'qq', id: s.id, title: s.name, artist: s.artist });
  log('[QQ播放]', { via: u.via, url: u.url?.slice(0, 150), msg: u.msg });
});
btn('bin', async () => {
  const r = await mgr.search('netease', '晴天 周杰伦', 1);
  const u = await mgr.resolvePlayUrl({ srcId: 'netease', id: r[0].id, title: r[0].name, artist: r[0].artist });
  if (!u.url) return log('无地址', u.msg);
  const t0 = performance.now();
  const bin = await mgr.binary(u.url, u.headers || {});
  const dt = (performance.now() - t0).toFixed(0);
  log(`[二进制] ${bin ? bin.data.length : 0} 字节 / ${dt}ms / ${bin?.contentType}`);
});
btn('qr-ne', async () => {
  qr.onUpdate((d) => {
    log('[网易码事件]', d.type, d.qrSrc ? '(图片)' : '');
    if (d.qrSrc) document.getElementById('qr').src = d.qrSrc;
  });
  qr.onSuccess((d) => { log('[登录成功]', d.platform, d.profile?.nickname); document.getElementById('qr').removeAttribute('src'); });
  const r = await qr.start('netease');
  log('[网易出码]', { ok: r.ok, content: r.content, msg: r.msg });
  if (r.content) {
    const q = window.qrcode(0, 'M');
    q.addData(r.content);
    q.make();
    document.getElementById('qr').src = q.createDataURL(6, 2);
  }
});
btn('qr-qq', async () => {
  qr.onUpdate((d) => {
    log('[QQ码事件]', d.type, d.qrSrc ? '(图片)' : '');
    if (d.qrSrc) document.getElementById('qr').src = d.qrSrc;
  });
  qr.onSuccess((d) => { log('[登录成功]', d.platform, d.profile?.nickname); document.getElementById('qr').removeAttribute('src'); });
  const r = await qr.start('qqmusic');
  log('[QQ出码]', { ok: r.ok, msg: r.msg });
});
}

main().catch((e) => log('[启动失败]', e.stack || e.message));

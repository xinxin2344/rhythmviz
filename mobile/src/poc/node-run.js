/* Node 验证：音源签名/请求/解析链路（绕过原生层，验证插件与 manager 逻辑） */
import { MobileSourceManager } from '../host/manager.js';
import { installGlobals } from '../buffer-poly.js';

installGlobals();

// localStorage 内存桩
globalThis.localStorage = {
  _m: new Map(),
  getItem(k) { return this._m.has(k) ? this._m.get(k) : null; },
  setItem(k, v) { this._m.set(k, String(v)); },
  removeItem(k) { this._m.delete(k); }
};

const mgr = new MobileSourceManager();
await mgr.init();
console.log('== 音源列表 ==');
console.log(mgr.list().map((x) => `${x.id}(${x.name}) enabled=${x.enabled}`).join(', '));

for (const src of ['netease', 'qq']) {
  console.log(`\n== 搜索 ${src}: 周杰伦 晴天 ==`);
  let list = [];
  try {
    list = await mgr.search(src, '周杰伦 晴天', 1);
    console.log(`结果 ${list.length} 条；前 3:`);
    for (const s of list.slice(0, 3)) console.log(' -', s.id, s.name, '/', s.artist, '/ dur', s.duration, 'fee', s.fee ?? '');
  } catch (e) { console.log('搜索失败:', e.message); continue; }

  const s = list[0];
  if (s) {
    console.log(`== ${src} 播放地址 ==`);
    try {
      const u = await mgr.resolvePlayUrl({ srcId: src, id: s.id, title: s.name, artist: s.artist });
      console.log(u.ok !== false ? `OK via=${u.via} newId=${u.newId || ''}\n  ${String(u.url).slice(0, 180)}` : `失败: ${u.msg}`);
    } catch (e) { console.log('取地址失败:', e.message); }
  }
}

console.log('\n== 网易歌词（晴天 186016） ==');
try {
  const ly = await mgr.getLyric('netease', 186016);
  console.log('lrc 长度', (ly.lrc || '').length, 'yrc 长度', (ly.yrc || '').length, 'trans 长度', (ly.tlrc || ly.trans || '').length);
  console.log('首行:', String(ly.lrc || '').split('\n').slice(0, 2).join(' | '));
} catch (e) { console.log('歌词失败:', e.message); }

console.log('\n== 首页 feed ==');
try {
  const f = await mgr.feed();
  console.log(`source=${f.source} hot=${f.hot.length} playlists=${f.playlists.length}`);
} catch (e) { console.log('feed 失败:', e.message); }

console.log('\n== searchAll ==');
try {
  const all = await mgr.searchAll('起风了');
  console.log('总', all.length, '条；前 3:');
  for (const s of all.slice(0, 3)) console.log(' -', s.srcId, s.name, '/', s.artist);
} catch (e) { console.log('searchAll 失败:', e.message); }

/* ============================================================
   示例音源插件（MusicSource 接口规范演示）
   ------------------------------------------------------------
   本文件仅演示插件接口形状与宿主 API 用法，不含任何平台逆向逻辑。
   使用 3 首公开的 SoundHelix 测试音频（作者 T. Schürger，免费试用）。

   ── MusicSource 插件接口规范 ──
   module.exports = {
     id: string                       // 全局唯一 id
     name: string                     // 显示名称
     version: string                  // 语义化版本（用于更新检测）
     updateUrl?: string               // 返回 {version,notes,url} JSON 的远端地址
     async init?(host)                // 宿主 API 注入（见下方 host 说明）
     async search(kw, page) => [{ id, name, artist, album, coverUrl?, duration? }]
     async getPlayUrl(id, quality) => { url, br?, headers?, drm? }
         - headers: 播放该直链所需的请求头（Referer/UA 等，主进程代为携带）
         - drm: true 表示 DRM 加密资源 → 主程序直接跳过并自动换源
         - 签名失败请抛 { code:'E_SIGN' } → 不重试直接换源；插件内部
           自行维护多版本签名降级（见下方 signers 示例结构）
     async getLyric?(id) => { lrc, ttml?, trans? }
         - lrc 为纯 LRC 文本；ttml 可选（逐字高亮）；trans 为翻译 LRC
   }

   ── 宿主 API（host）──
   host.net.request({ url, method, headers, body, timeout, redirect, encoding })
       - 统一走主进程：HTTP/SOCKS 代理轮换 + 同域限流 + 指数退避重试
       - 403/401 直接抛 E_FORBIDDEN（不重试，触发换源）
       - 指纹头（UA/Referer/sec-fetch 全套）由插件自行传入并原样透传
   host.net.get(url, {headers}) / host.net.post(url, body, {headers})
       - 自动附带本插件 CookieJar 的 Cookie
   host.cookieJar.get(domain) / set(domain, cookies) / clear(domain?) / header(url)
       - CookieJar 持久化（重启不丢）
   host.login.open(url)
       - 打开 Electron 扫码登录窗口，用户关闭窗口后自动收集并持久化 Cookie
   host.storage.get(key) / set(key, value)   // 插件私有持久存储
   host.cache.get(key) / set(key, value)     // 仅限元数据/歌词缓存；直链禁止
   host.log(...) / host.notify(msg)          // 日志 / UI toast
   ============================================================ */

const DEMO_SONGS = [
  { id: 'sh-1', name: 'SoundHelix Song 1', artist: 'T. Schürger', album: 'Demo', coverUrl: null, duration: 372 },
  { id: 'sh-2', name: 'SoundHelix Song 2', artist: 'T. Schürger', album: 'Demo', coverUrl: null, duration: 306 },
  { id: 'sh-8', name: 'SoundHelix Song 8', artist: 'T. Schürger', album: 'Demo', coverUrl: null, duration: 313 }
];
const urlOf = (id) => `https://www.soundhelix.com/examples/mp3/SoundHelix-Song-${String(id).replace('sh-', '')}.mp3`;

module.exports = {
  id: 'sample-demo',
  name: '示例演示源（公共测试音频）',
  version: '1.0.0',
  // updateUrl: 'https://example.com/sample-source/version.json', // 生产插件可提供
  supports: { search: true, lyric: true, playlist: false },

  /* ---------- 签名模块（解耦示例）：多版本 + 失效自动降级 ----------
     真实逆向插件应把各版本签名算法独立成函数，getPlayUrl 内按
     「最新 → 旧」顺序尝试；全部失败抛 E_SIGN 交由主程序换源。 */
  signers: [
    { v: 'v2', sign: (req) => req /* 演示：v2 签名占位 */ },
    { v: 'v1', sign: (req) => req /* 演示：v1 旧版签名占位 */ }
  ],
  _signIdx: 0,
  _sign(req) {
    try {
      const r = this.signers[this._signIdx].sign(req);
      return r;
    } catch {
      // 当前版本签名失效 → 自动降级到旧版本签名
      if (this._signIdx < this.signers.length - 1) {
        this._signIdx++;
        host && host.notify(`签名 v${this._signIdx} 失效，已降级旧版签名重试`);
        return this.signers[this._signIdx].sign(req);
      }
      throw Object.assign(new Error('全部签名版本均失效'), { code: 'E_SIGN' });
    }
  },

  /* ---------- 宿主注入 ---------- */
  async init(host) {
    this.host = host;
    host.log('示例音源已加载；当前签名版本:', this.signers[this._signIdx].v);
    // 演示 CookieJar 持久化读取
    const saved = host.cookieJar.get('soundhelix.com');
    if (saved?.length) host.log('发现已保存 Cookie', saved.length, '条');
    // 演示扫码登录（真实插件用平台登录页；此处仅示例调用方式，未实际调用）
    // const cookies = await host.login.open('https://example.com/qrlogin');
    // if (cookies.length) host.cookieJar.set('example.com', cookies);
  },

  /* ---------- 搜索 ---------- */
  async search(kw, page) {
    if (page > 1) return [];
    const k = String(kw).toLowerCase();
    // 演示源：仅支持搜 song / soundhelix / 演示 时返回全部
    if (!k || /song|soundhelix|演示/.test(k)) return DEMO_SONGS;
    return [];
  },

  /* ---------- 播放地址 ---------- */
  async getPlayUrl(id, quality) {
    const s = DEMO_SONGS.find((x) => x.id === id);
    if (!s) throw Object.assign(new Error('未找到歌曲'), { code: 'E_NOT_FOUND' });
    // 真实插件在此完成：组装请求 → this._sign(req) → host.net 请求 → 解析直链
    return {
      url: urlOf(id),
      br: 128,
      headers: { Referer: 'https://www.soundhelix.com/', 'User-Agent': 'RhythmViz-Demo/1.0' }
      // 若检测到 DRM 加密：return { drm: true } → 主程序跳过并自动换源
    };
  },

  /* ---------- 歌词（可选） ---------- */
  async getLyric(id) {
    const s = DEMO_SONGS.find((x) => x.id === id);
    if (!s) return { lrc: '' };
    const lrc = [
      `[ti:${s.name}]`, `[ar:${s.artist}]`, `[by:RhythmViz 示例源]`, '',
      '[00:00.00]这是示例音源的演示歌词',
      '[00:03.00]播放的是公开的 SoundHelix 测试音频',
      '[00:07.00]歌词仅用于演示逐字高亮与滚动',
      '[00:12.00]导入你自己的音源插件后即可播放真实歌曲',
      '[00:18.00]主程序不内置任何平台接口与签名'
    ].join('\n');
    return { lrc, trans: '' };
  }
};

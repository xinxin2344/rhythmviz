/* ============================================================
   音源插件：网易云（逆向实现 · 用户自担风险）
   ------------------------------------------------------------
   ⚠️ 本文件属于第三方逆向音源插件，不属于主程序：
   - 仅允许个人本地学习研究，禁止打包分发、分享、商用；
   - 存在版权侵权风险，接口随时会失效；
   - 全部签名 / 请求指纹 / Cookie 管理均在本文件内完成，
     主程序仅提供通用宿主能力（代理 / 限流 / Cookie 持久化）。
   存放位置：sources/plugins/（应用启动时自动加载，删除文件即移除）
   ============================================================ */
module.exports = {
  id: 'netease',
  name: '网易云音乐',
  version: '1.4.2',
  updateUrl: '', // 可选：指向 {"version":"1.2.0","notes":"...","url":"..."} 的 JSON 地址
  // 扫码登录已内置主程序（宿主 BUILTIN_LOGIN，不依赖本插件）；登录态 Cookie 由宿主 CookieJar 共享

  init(host) {
    this.host = host;
    this.log = host.log;
    this._loginAt = 0; this._loginOn = false;
    host.log('网易云插件已加载；CookieJar / 代理 / 限流由宿主提供');
  },

  /** 登录态：CookieJar 内存在 MUSIC_U 即已登录（3s 缓存，避免每首歌都读一次存储） */
  _loggedIn() {
    if (Date.now() - this._loginAt < 3000) return this._loginOn;
    let on = false;
    try {
      const c = this.host.cookieJar.get('music.163.com') || [];
      on = c.some((x) => x.name === 'MUSIC_U' && x.value);
    } catch { /* noop */ }
    this._loginAt = Date.now(); this._loginOn = on;
    return on;
  },

  /* ---------- 签名模块（解耦，多版本自动降级） ---------- */
  // 当前匿名 Web 接口无需签名；预留多版本结构：接口失效时在此追加新版签名，
  // 宿主会按顺序尝试，旧版本作为降级兜底，全部失败抛 E_SIGN（宿主自动换源）。
  signers: [
    {
      name: 'v2-anon',
      sign(params) { return params; } // 匿名接口：参数原样
    }
  ],
  _sign(params) {
    let lastErr = null;
    for (let i = 0; i < this.signers.length; i++) {
      try {
        const p = this.signers[i].sign({ ...params });
        if (i > 0) this.log?.(`签名降级 → ${this.signers[i].name}`);
        return p;
      } catch (e) { lastErr = e; }
    }
    throw Object.assign(new Error('全部签名版本失效'), { code: 'E_SIGN' });
  },

  /* ---------- 请求指纹（完整浏览器头，插件自带） ---------- */
  _headers(extra) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://music.163.com/',
      'Origin': 'https://music.163.com',
      // 未登录：匿名基础 Cookie；已登录：优先用账号 CookieJar（含 MUSIC_U，解锁 VIP 与高音质）
      'Cookie': this.host.cookieJar.header('https://music.163.com/') || 'os=pc; appver=2.10.13',
      // 老 trick：对 api 域名伪造出口 IP，提高匿名接口命中率
      'X-Real-IP': '118.88.88.88',
      ...extra
    };
  },

  async _json(url, opts = {}) {
    const r = await this.host.net.request({
      url, headers: this._headers(opts.headers), method: opts.method || 'GET',
      body: opts.body || null, timeout: 12000, encoding: 'utf8'
    });
    if (r.status === 403 || r.status === 401) throw Object.assign(new Error(`HTTP ${r.status}（风控/签名失效）`), { code: 'E_FORBIDDEN' });
    if (r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'E_SERVER' });
    return JSON.parse(r.body);
  },
  _post(url, body) {
    return this._json(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  },

  /* ---------- weapi 匿名签名（逐字歌词 yrc 必需；算法全部在插件内） ---------- */
  _weapiConst: {
    IV: '0102030405060708',
    PRESET: '0CoJUm6Qyw8W8jud',
    BASE62: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
    RSA_MOD: '00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e417629ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cce10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7'
  },
  async _aesCbcB64(text, keyStr) {
    const key = await webcrypto.subtle.importKey('raw', Buffer.from(keyStr), { name: 'AES-CBC' }, false, ['encrypt']);
    const out = await webcrypto.subtle.encrypt(
      { name: 'AES-CBC', iv: Buffer.from(this._weapiConst.IV) }, key, Buffer.from(text, 'utf8')
    );
    return Buffer.from(out).toString('base64');
  },
  _bigModPow(base, exp, mod) {
    let r = 1n;
    base %= mod;
    while (exp > 0n) {
      if (exp & 1n) r = r * base % mod;
      exp >>= 1n;
      base = base * base % mod;
    }
    return r;
  },
  async _weapi(data) {
    const C = this._weapiConst;
    let sk = '';
    for (let i = 0; i < 16; i++) sk += C.BASE62[(Math.random() * 62) | 0];
    const p1 = await this._aesCbcB64(JSON.stringify(data), C.PRESET);
    const params = await this._aesCbcB64(p1, sk); // 第二次 AES 输入是首段密文的 base64
    const x = BigInt('0x' + Buffer.from([...sk].reverse().join(''), 'utf8').toString('hex'));
    const encSecKey = this._bigModPow(x, 0x10001n, BigInt('0x' + C.RSA_MOD)).toString(16).padStart(256, '0');
    return { params, encSecKey };
  },
  async _postWeapi(url, data) {
    const w = await this._weapi(data);
    return this._post(url, `params=${encodeURIComponent(w.params)}&encSecKey=${w.encSecKey}`);
  },

  /* ---------- MusicSource 接口 ---------- */
  /** 统一映射：云搜索/老接口/song detail → 标准曲目；标记试听/付费片段 */
  _mapSong(s) {
    const fee = s.fee ?? 0;
    const cover = (s.al?.picUrl || s.album?.picUrl || '').replace(/^http:\/\//, 'https://');
    return {
      id: s.id, name: s.name,
      artist: (s.ar || s.artists || []).map((a) => a.name).join('/'),
      album: s.al?.name || s.album?.name || '',
      coverUrl: cover,
      duration: s.dt || s.duration || 0,
      // fee: 0/8 免费可播，1 VIP，4 付费专辑；freeTrialInfo = 仅试听片段
      // 匿名态 fee=1 实测拿不到播放地址 → 过滤；已登录（VIP 账号）可播 → 不再过滤
      trial: !!s.freeTrialInfo || fee === 4 || (fee === 1 && !this._loggedIn()),
      fee, // 原唱识别信号：fee===8 为数字专辑版权曲（可播原唱概率高）
      srcId: this.id, srcName: this.name
    };
  },
  /** 只保留完整曲目：过滤试听片段与 <40s 片段 */
  _fullOnly(list) {
    return (list || []).filter((s) => s.id && !s.trial && (!s.duration || s.duration >= 40000));
  },

  async search(kw, page = 1) {
    const q = String(kw || '').trim();
    if (!q) return [];
    const limit = 30, offset = (Math.max(1, page) - 1) * limit;
    // 端点 1（优先）：云搜索 pc —— 返回 al.picUrl 封面与 fee/试听标记
    try {
      const j = await this._post(
        'https://music.163.com/api/cloudsearch/pc?type=1&offset=' + offset + '&limit=' + limit,
        `s=${encodeURIComponent(q)}&type=1&offset=${offset}&limit=${limit}`
      );
      const songs = j?.result?.songs;
      if (Array.isArray(songs) && songs.length) {
        const list = this._fullOnly(songs.map((s) => this._mapSong(s)));
        if (list.length) return list;
      }
    } catch (e) { this.log?.('search cloud:', e.message); }
    // 端点 2（降级）：老版 web 搜索（无封面，批量 song/detail 补齐 album.picUrl）
    try {
      const j = await this._json(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&offset=${offset}&total=true&limit=${limit}`);
      const songs = j?.result?.songs;
      if (Array.isArray(songs) && songs.length) {
        let mapped = songs.map((s) => this._mapSong(s));
        const missing = mapped.filter((m) => !m.coverUrl).map((m) => m.id).slice(0, 30);
        if (missing.length) {
          try {
            const d = await this._json(`https://music.163.com/api/song/detail?ids=[${missing.join(',')}]`);
            const picMap = new Map((d.songs || []).map((x) => [x.id, (x.album?.picUrl || '').replace(/^http:\/\//, 'https://')]));
            mapped = mapped.map((m) => picMap.get(m.id) ? { ...m, coverUrl: picMap.get(m.id) } : m);
          } catch { /* 封面补全失败不阻塞 */ }
        }
        return this._fullOnly(mapped);
      }
    } catch (e) { this.log?.('search web:', e.message); }
    return [];
  },

  /* ---------- 歌手搜索 / 歌手专辑 / 专辑详情 ---------- */
  /** 搜歌手（type=100）：返回 [{id, name, coverUrl, alias}] */
  async searchArtist(kw, limit = 5) {
    const q = String(kw || '').trim();
    if (!q) return [];
    try {
      const j = await this._json(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=100&offset=0&total=true&limit=${limit}`);
      const arr = j?.result?.artists;
      if (!Array.isArray(arr)) return [];
      return arr.slice(0, limit).map((a) => ({
        id: a.id, name: a.name,
        alias: (a.alias || []).join('/'),
        coverUrl: String(a.picUrl || a.img1v1Url || '').replace(/^http:\/\//, 'https://')
      })).filter((a) => a.id && a.name);
    } catch (e) { this.log?.('searchArtist:', e.message); return []; }
  },
  /** 歌手专辑列表：GET /api/artist/albums/{id}（注意是路径参数 + 复数 albums，query 形式返回 400） */
  async artistAlbums(artistId, limit = 50) {
    const j = await this._json(`https://music.163.com/api/artist/albums/${encodeURIComponent(artistId)}?limit=${limit}&offset=0`);
    const hot = j?.hotAlbums;
    if (!Array.isArray(hot)) return { artist: '', coverUrl: '', albums: [] };
    return {
      artist: j?.artist?.name || '',
      coverUrl: String(j?.artist?.picUrl || j?.artist?.img1v1Url || '').replace(/^http:\/\//, 'https://'),
      albums: hot.map((al) => ({
        id: al.id, name: al.name,
        coverUrl: String(al.picUrl || '').replace(/^http:\/\//, 'https://'),
        year: al.publishTime ? new Date(al.publishTime).getFullYear() : '',
        count: al.size || 0
      })).filter((al) => al.id && al.name)
    };
  },
  /** 专辑详情：GET /api/v1/album/{id}（路径参数形式；/api/album?id= 已 404）曲目与歌单详情同构 */
  async albumDetail(albumId) {
    const j = await this._json(`https://music.163.com/api/v1/album/${encodeURIComponent(albumId)}`);
    const al = j?.album, songs = j?.songs;
    if (!al || !Array.isArray(songs)) throw new Error('专辑不存在或已下架');
    const pic = String(al.picUrl || '').replace(/^http:\/\//, 'https://');
    const tracks = this._fullOnly(songs.map((s) => {
      const fee = s.fee ?? 0;
      return {
        id: s.id, name: s.name,
        artist: (s.ar || s.artists || []).map((a) => a.name).join('/'),
        album: al.name,
        coverUrl: pic, // 专辑内歌曲常缺 al.picUrl，统一用专辑封面
        duration: s.dt || s.duration || 0,
        trial: !!s.freeTrialInfo || fee === 4 || fee === 1,
        fee,
        srcId: this.id, srcName: this.name
      };
    })); // VIP/试听曲目不进专辑曲目列表
    return { name: al.name, coverUrl: pic, tracks };
  },

  async getPlayUrl(id) {
    // 端点 A（优先）：v1 播放器接口，按音质等级回退（exhigh → higher → standard）
    let sawTrial = false;
    for (const level of ['exhigh', 'higher', 'standard']) {
      try {
        const j = await this._post(
          'https://music.163.com/api/song/enhance/player/url/v1?csrf_token=',
          `ids=[${id}]&level=${level}&encodeType=mp3&csrf_token=`
        );
        const d0 = j?.data?.[0];
        // freeTrialInfo 存在 = 仅试听片段，标记后换源，不作为可播结果
        if (d0?.freeTrialInfo) { sawTrial = true; continue; }
        const u = d0?.url;
        if (u) return { url: u.replace(/^http:\/\//, 'https://'), br: d0.br || 0, headers: { Referer: 'https://music.163.com/' } };
      } catch (e) { this.log?.(`playurl v1 ${level}:`, e.message); }
    }
    // 端点 B（降级）：老接口多码率回退；匿名下 128k 命中率最高，优先尝试
    for (const br of [128000, 320000]) {
      try {
        const j = await this._post('https://music.163.com/api/song/enhance/player/url?csrf_token=', `ids=[${id}]&br=${br}&csrf_token=`);
        const d0 = j?.data?.[0];
        const u = d0?.url;
        if (d0?.freeTrialInfo) { sawTrial = true; continue; }
        if (u) return { url: u.replace(/^http:\/\//, 'https://'), br: d0.br || br, headers: { Referer: 'https://music.163.com/' } };
      } catch (e) { this.log?.(`playurl e${br}:`, e.message); }
    }
    if (sawTrial) return { url: null, msg: '仅提供试听片段' };
    // 外链重定向兜底：manual 跟一跳——无版权歌会 302 到 404 页（text/html），
    // 提前识破返回空地址交由宿主自动换源，避免把 HTML 当音频返回后播放失败
    try {
      const r = await this.host.net.request({
        url: `https://music.163.com/song/media/outer/url?id=${id}.mp3`,
        headers: { Referer: 'https://music.163.com/' },
        redirect: 'manual', timeout: 8000, encoding: 'utf8'
      });
      const loc = Array.isArray(r.headers?.location) ? r.headers.location[0] : (r.headers?.location || '');
      if (r.status >= 300 && r.status < 400 && loc) {
        if (/music\.163\.com\/404/i.test(loc)) return { url: null, msg: '无版权（外链跳 404）' };
        return { url: loc.replace(/^http:\/\//, 'https://'), br: 0, headers: { Referer: 'https://music.163.com/' } };
      }
      if (r.status === 200 && /text\/html/i.test(String(r.headers?.['content-type'] || ''))) return { url: null, msg: '无版权' };
    } catch (e) { this.log?.('outer url 探测失败:', e.message); }
    return { url: `https://music.163.com/song/media/outer/url?id=${id}.mp3`, br: 0, headers: { Referer: 'https://music.163.com/' } };
  },

  async getLyric(id) {
    // 优先 weapi /lyric/v1：匿名签名可用，且返回逐字 yrc（真实人声时间戳）
    let j = null;
    try {
      j = await this._postWeapi('https://music.163.com/weapi/song/lyric/v1?csrf_token=', {
        id: Number(id) || id, lv: -1, tv: -1, yv: 1, kv: -1
      });
    } catch (e) { this.log?.('weapi 歌词失败，降级老接口:', e.message); j = null; }
    // 老 GET 兜底（只含行级 lrc）
    if (!j || (!j.lrc?.lyric && !j.yrc?.lyric)) {
      try {
        j = await this._json(`https://music.163.com/api/song/lyric?_nmclfl=1&id=${id}&lv=1&kv=1&tv=-1`);
      } catch (e) { this.log?.('lyric:', e.message); return { lrc: '', yrc: '', trans: '' }; }
    }
    const lrc = j?.lrc?.lyric || '';
    const yrc = j?.yrc?.lyric || '';
    // 纯音乐识别：接口显式标记，或歌词正文仅为「纯音乐，请欣赏」
    const bodyOnly = lrc.replace(/\[\d{1,3}:\d{1,2}[.:]\d{1,3}\]/g, '').replace(/\s+/g, '');
    const pure = j?.nolyric === true || j?.pureMusic === true || (!!bodyOnly && bodyOnly === '纯音乐，请欣赏');
    if (pure) return { lrc: '', yrc: '', trans: '', pure: true };
    return { lrc, yrc, trans: j?.tlyric?.lyric || '' };
  },

  /* ---------- 首页推荐能力（官方榜单，宿主 feed 调用） ---------- */
  /** 热歌：云音乐热歌榜（3778678）前 n 首完整曲目 */
  async trending(n = 50) {
    const det = await this.getPlaylistDetail('3778678');
    return this._fullOnly(det.tracks || []).slice(0, n);
  },
  /** 推荐歌单：官方排行榜列表（含封面） */
  async playlists(n = 16) {
    try {
      const j = await this._json('https://music.163.com/api/toplist');
      const list = j?.list || [];
      return list.slice(0, n).map((p) => ({
        id: `pl:netease:${p.id}`, name: p.name,
        coverUrl: (p.coverImgUrl || '').replace(/^http:\/\//, 'https://'),
        curator: '网易云音乐', playCount: p.playCount || 0,
        srcId: this.id, srcName: this.name
      }));
    } catch (e) { this.log?.('toplist:', e.message); return []; }
  },
  /** 宿主 playlistDetail 路由别名（pl:netease:<id> → 本插件） */
  playlistDetail(id) { return this.getPlaylistDetail(id); },

  /* ---------- 登录账号：我的歌单（云歌单，含创建 + 收藏） ---------- */
  /** 当前登录账号 uid（内存缓存 10 分钟；退出/换号后随进程重启自然失效） */
  async _accountUid() {
    if (!this._loggedIn()) return '';
    if (this._uidCache?.uid && Date.now() - this._uidCache.at < 600000) return this._uidCache.uid;
    try {
      const j = await this._json('https://music.163.com/api/nuser/account/get');
      const uid = String(j?.profile?.userId || j?.account?.id || '');
      if (uid) { this._uidCache = { uid, at: Date.now() }; return uid; }
    } catch (e) { this.log?.('account/get:', e.message); }
    return '';
  },
  /** 我的歌单：GET /api/user/playlist（2026 实测登录态可用，返回创建 + 订阅的全部云歌单） */
  async userPlaylists() {
    if (!this._loggedIn()) return [];
    const uid = await this._accountUid();
    if (!uid) return [];
    try {
      const j = await this._json(
        `https://music.163.com/api/user/playlist?uid=${uid}&offset=0&limit=100&includeVideo=false`
      );
      const list = j?.playlist;
      if (!Array.isArray(list)) return [];
      return list.map((p) => ({
        id: `pl:netease:${p.id}`,
        name: p.name || '歌单',
        coverUrl: (p.coverImgUrl || '').replace(/^http:\/\//, 'https://'),
        curator: p.creator?.nickname || '网易云音乐',
        playCount: p.playCount || 0,
        trackCount: p.trackCount || 0,
        srcId: this.id, srcName: this.name
      })).filter((p) => p.name && p.id !== 'pl:netease:undefined');
    } catch (e) { this.log?.('userPlaylists:', e.message); return []; }
  },

  /* ---------- 可选扩展：歌单详情（旧收藏兼容） ---------- */
  async getPlaylistDetail(id) {
    try {
      const j = await this._post('https://music.163.com/api/v6/playlist/detail', `id=${id}&n=1000&csrf_token=`);
      const pl = j?.playlist;
      if (!pl) return { name: '', coverUrl: '', tracks: [] };
      // 统一走 _mapSong：带 trial/fee 标记；VIP/试听曲目不进歌单（展示即可播）
      const map = (s) => this._mapSong(s);
      let tracks = this._fullOnly((pl.tracks || []).map(map));
      // 补齐至 200 首：trackIds 全量分批拉详情（每批 50），保证长歌单不缺曲
      const ids = (pl.trackIds || []).map((t) => t.id).slice(0, 200);
      if (ids.length > tracks.length) {
        const out = new Map(tracks.map((t) => [t.id, t]));
        for (let i = 0; i < ids.length; i += 50) {
          try {
            const d = await this._json(`https://music.163.com/api/song/detail?ids=[${ids.slice(i, i + 50).join(',')}]`);
            (d.songs || []).forEach((s) => out.set(s.id, map(s)));
          } catch { /* 单批失败不影响其余 */ }
        }
        tracks = this._fullOnly(ids.map((id) => out.get(id)).filter(Boolean));
      }
      return { name: pl.name || '', coverUrl: (pl.coverImgUrl || '').replace(/^http:\/\//, 'https://'), tracks: tracks.slice(0, 200) };
    } catch (e) { this.log?.('plDetail:', e.message); return { name: '', coverUrl: '', tracks: [] }; }
  }
};

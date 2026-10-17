/* ============================================================
   音源插件：QQ音乐（第三方音源 · 用户自担风险）
   ------------------------------------------------------------
   ⚠️ 本文件属于第三方音源插件，不属于主程序：
   - 仅允许个人本地学习研究，禁止打包分发、分享、商用；
   - 存在版权侵权风险，接口随时会失效；
   - 全部请求指纹 / 参数组装均在本文件内完成，
     主程序仅提供通用宿主能力（代理 / 限流 / Cookie 持久化）。
   存放位置：sources/plugins/（应用启动时自动加载，删除文件即移除）
   ============================================================ */
module.exports = {
  id: 'qq',
  name: 'QQ音乐',
  version: '1.3.0',
  updateUrl: '',
  // 扫码登录已内置主程序（宿主 BUILTIN_LOGIN 隐藏窗口取码，不依赖本插件）；登录态 Cookie 由宿主 CookieJar 共享

  init(host) {
    this.host = host;
    this.log = host.log;
    this._loginAt = 0; this._loginOn = false;
    host.log('QQ音乐插件已加载；CookieJar / 代理 / 限流由宿主提供');
  },

  /** 登录态：CookieJar 内存在 qm_keyst / qqmusic_key 即已登录（3s 缓存） */
  _loggedIn() {
    if (Date.now() - this._loginAt < 3000) return this._loginOn;
    let on = false;
    try {
      const c = this.host.cookieJar.get('qq.com') || [];
      on = c.some((x) => (x.name === 'qm_keyst' || x.name === 'qqmusic_key') && x.value);
    } catch { /* noop */ }
    this._loginAt = Date.now(); this._loginOn = on;
    return on;
  },

  /** 账号 uin：VIP vkey 必须带真实 uin，匿名 uin=0 只会返回免费曲。
      对齐 Mineradio：微信登录态取 wxuin；cookie 的 uin 常带 o 前缀（混淆值），
      去非数字字符后再去前导零 */
  _uin() {
    try {
      const c = this.host.cookieJar.get('qq.com') || [];
      const obj = Object.fromEntries(c.map((x) => [x.name, x.value]));
      const isWx = !!obj.wxopenid || Number(obj.login_type) === 2;
      const raw = isWx ? (obj.wxuin || obj.uin || obj.p_uin || '')
        : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin || '');
      const digits = String(raw).replace(/\D/g, '').replace(/^0+/, '');
      return digits || '0';
    } catch { return '0'; }
  },

  /** g_tk 签名：QQ 全家桶经典 DJB 变种，skey 取 qm_keyst/qqmusic_key；
      未登录（空串）时结果恒为 5381，与官方匿名请求一致 */
  _gtk() {
    let key = '';
    try {
      const c = this.host.cookieJar.get('qq.com') || [];
      const hit = c.find((x) => x.name === 'qm_keyst' || x.name === 'qqmusic_key');
      key = hit?.value || '';
    } catch { /* noop */ }
    let hash = 5381;
    for (let i = 0; i < key.length; i++) hash += (hash << 5) + key.charCodeAt(i);
    return hash & 0x7fffffff;
  },

  /** musicu.fcg 统一 POST：modules 形如 {req_0:{module,method,param}}，自动补 comm 登录态 */
  async _musicu(modules) {
    const uin = Number(this._uin()) || 0;
    const body = JSON.stringify({
      ...modules,
      comm: { g_tk: this._gtk(), uin, format: 'json', ct: 19, cv: 0, platform: 'yqq.json', needNewCode: 0 }
    });
    return this._json('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body
    });
  },

  /* ---------- 请求指纹（浏览器头，插件自带） ---------- */
  _headers(extra) {
    // 已登录时附带账号 Cookie（qm_keyst 等），接口才会认 VIP 身份
    const cookie = this.host.cookieJar.header('https://y.qq.com/');
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://y.qq.com/',
      ...(cookie ? { Cookie: cookie } : {}),
      ...extra
    };
  },

  async _json(url, opts = {}) {
    const r = await this.host.net.request({
      url, headers: this._headers(opts.headers), method: opts.method || 'GET',
      body: opts.body || null, timeout: 20000, encoding: 'utf8'
    });
    if (r.status === 403 || r.status === 401) throw Object.assign(new Error(`HTTP ${r.status}（风控）`), { code: 'E_FORBIDDEN' });
    if (r.status >= 500) throw Object.assign(new Error(`HTTP ${r.status}`), { code: 'E_SERVER' });
    return JSON.parse(r.body);
  },

  /* ---------- MusicSource 接口 ---------- */
  _cover(albumMid) {
    return albumMid ? `https://y.gtimg.cn/music/photo_new/T002R300x300M000${albumMid}.jpg` : '';
  },
  // 老 h5 接口（search_for_qq_cp）字段：songmid/songname/albumname/albummid/pay.payplay
  _mapSongOld(s) {
    return {
      id: s.songmid,
      name: s.songname || '',
      artist: (s.singer || []).map((a) => a.name).join('/'),
      album: s.albumname || '',
      coverUrl: this._cover(s.albummid),
      duration: (s.interval || 0) * 1000, // interval 为秒，转 ms
      // payplay: 1 = VIP 仅试听 → 匿名态过滤；已登录 VIP 账号可播 → 不再过滤
      trial: (s.pay?.payplay ?? 0) === 1 && !this._loggedIn(),
      srcId: this.id, srcName: this.name
    };
  },
  // 新接口（client_search_cp new_json=1）字段：mid/name/album.mid/album.name/pay.pay_play
  _mapSongNew(s) {
    const albumMid = s.album?.mid || s.albumMid || '';
    return {
      id: s.mid,
      name: s.name || s.title || '',
      artist: (s.singer || []).map((a) => a.name).join('/'),
      album: s.album?.name || s.albumName || '',
      coverUrl: this._cover(albumMid),
      duration: (s.interval || 0) * 1000,
      trial: (s.pay?.pay_play ?? 0) === 1 && !this._loggedIn(),
      srcId: this.id, srcName: this.name
    };
  },
  // 只保留完整曲目：过滤 VIP 试听与 <40s 片段
  _fullOnly(list) {
    return (list || []).filter((s) => s.id && !s.trial && (!s.duration || s.duration >= 40000));
  },

  async search(kw, page = 1) {
    const q = String(kw || '').trim();
    if (!q) return [];
    const p = Math.max(1, page);
    // 端点 1（优先）：老 h5 搜索接口，匿名可用，字段含 pay.payplay 与 interval
    try {
      const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?g_tk=5381&uin=0&format=json'
        + '&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1'
        + `&w=${encodeURIComponent(q)}&zhidaqu=1&catZhida=1&t=0&flag=1&ie=utf-8&sem=1&aggr=0`
        + `&perpage=30&n=30&p=${p}&remoteplace=txt.mqq.all`;
      const j = await this._json(url);
      const list = j?.data?.song?.list;
      if (Array.isArray(list) && list.length) return this._fullOnly(list.map((s) => this._mapSongOld(s)));
    } catch (e) { this.log?.('search h5:', e.message); }
    // 端点 2（降级）：新版客户端搜索接口（c.y.qq.com 已停用该路径，走 shc 镜像域）
    try {
      const url = 'https://shc.y.qq.com/soso/fcgi-bin/client_search_cp?ct=24&qqmusic_ver=1298&new_json=1'
        + '&remoteplace=txt.yqq.song&t=0&aggr=1&cr=1&catZhida=1&lossless=0&flag_qc=0'
        + `&p=${p}&n=30&w=${encodeURIComponent(q)}&g_tk=5381&loginUin=0&hostUin=0&format=json`
        + '&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
      const j = await this._json(url);
      const list = j?.data?.song?.list;
      if (Array.isArray(list) && list.length) return this._fullOnly(list.map((s) => this._mapSongNew(s)));
    } catch (e) { this.log?.('search client:', e.message); }
    return [];
  },

  async getPlayUrl(id) {
    const uin = this._uin(); // 已登录用真实 uin；匿名 uin='0' 只能拿到免费曲
    // 播放票据（qm_keyst 等）作为 comm.authst 上送 —— VIP/付费曲解锁关键（对齐 Mineradio）
    let authst = '';
    try {
      const c = this.host.cookieJar.get('qq.com') || [];
      authst = c.find((x) => ['qm_keyst', 'qqmusic_key', 'music_key', 'wxskey'].includes(x.name))?.value || '';
    } catch { /* noop */ }
    // 多音质候选（高→低）：不传 filename 时部分歌曲默认档不可用 → purl 为空被误判「无版权」
    const mid = String(id);
    const qualities = [['RS01', '.flac'], ['F000', '.flac'], ['M800', '.mp3'], ['M500', '.mp3'], ['C400', '.m4a']];
    const filenames = qualities.map(([p, ext]) => p + mid + ext);
    const guid = String(10000000 + Math.floor(Math.random() * 90000000));
    const data = JSON.stringify({
      req_0: {
        module: 'vkey.GetVkeyServer',
        method: 'CgiGetVkey',
        param: {
          guid,
          songmid: filenames.map(() => mid),
          songtype: filenames.map(() => 0),
          uin,
          loginflag: 1,
          platform: '20',
          filename: filenames
        }
      },
      comm: { uin, format: 'json', ct: authst ? 19 : 24, cv: 0, ...(authst ? { authst } : {}) }
    });
    const url = 'https://u.y.qq.com/cgi-bin/musicu.fcg?format=json&platform=yqq.json&needNewCode=0&data=' + encodeURIComponent(data);
    try {
      const j = await this._json(url);
      const infos = j?.req_0?.data?.midurlinfo || [];
      // midurlinfo 与 filename 同序（质量高→低），取首个有播放地址的候选
      const hit = infos.find((i) => i && i.purl);
      if (!hit) return { url: null, msg: '无版权或 VIP 歌曲，无法获取播放地址' };
      // 接口返回的 sip 数组为当前可用的 CDN 域列表（ws.stream 已废弃，必须用 sip）
      const sips = j?.req_0?.data?.sip || [];
      const cdn = sips[0] || 'http://aqqmusic.tc.qq.com/';
      return {
        url: cdn.replace(/\/$/, '') + '/' + hit.purl,
        br: 0,
        headers: { Referer: 'https://y.qq.com/', 'User-Agent': this._headers()['User-Agent'] }
      };
    } catch (e) {
      this.log?.('playurl:', e.message);
      return { url: null, msg: e.message };
    }
  },

  async getLyric(id) {
    const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${encodeURIComponent(id)}`
      + '&format=json&nobase64=1&g_tk=5381&loginUin=0&hostUin=0&inCharset=utf8&outCharset=utf-8'
      + '&notice=0&platform=yqq.json&needNewCode=0';
    const decode = (t) => {
      if (!t) return '';
      // nobase64=1 生效时为纯文本；否则回退 base64（UTF-8）解码
      if (t.includes('[00:') || t.includes('[ti:')) return t;
      try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return t; }
    };
    try {
      // Referer 只能用根域：深路径（/portal/...、/n/yqq/...）会被 Chromium 网络栈
      // 以 ERR_BLOCKED_BY_CLIENT 直接拦截（隔离复现确认），根域则放行
      const j = await this._json(url, { headers: { Referer: 'https://y.qq.com/' } });
      return { lrc: decode(j?.lyric || ''), trans: decode(j?.trans || '') };
    } catch (e) {
      this.log?.('lyric:', e.message);
      return { lrc: '', trans: '' };
    }
  },

  /* ---------- 歌手搜索 / 歌手原唱歌曲 ---------- */
  _singerPic(mid) {
    return mid ? `https://y.gtimg.cn/music/photo_new/T001R300x300M000${mid}.jpg` : '';
  },
  /** 搜歌手：search_for_qq_cp 智能直达（zhida type=1/2 命中歌手，带 singermid） */
  async searchArtist(kw, limit = 5) {
    const q = String(kw || '').trim();
    if (!q) return [];
    try {
      const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?g_tk=5381&uin=0&format=json'
        + '&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1'
        + `&w=${encodeURIComponent(q)}&zhidaqu=1&catZhida=1&t=0&flag=1&ie=utf-8&sem=1&aggr=0`
        + '&perpage=1&n=1&p=1&remoteplace=txt.mqq.all';
      const j = await this._json(url);
      const z = j?.data?.zhida;
      if (!z || !(z.type === 1 || z.type === 2) || !z.singermid) return [];
      return [{ id: z.singermid, name: z.singername || q, alias: '', coverUrl: this._singerPic(z.singermid) }];
    } catch (e) { this.log?.('searchArtist:', e.message); return []; }
  },
  /** 歌手原唱歌曲：以歌手名检索其曲目（fcg_v8_singer_track_cp 已下线），
      按歌手名过滤保证都是该歌手原唱，按热度（搜索默认排序即热度）取前 limit 首 */
  async artistTopSongs(singerMid, limit = 60, name = '') {
    const mid = String(singerMid || '');
    const artistName = String(name || '').trim();
    if (!artistName) return { artist: '', coverUrl: this._singerPic(mid), songs: [] };
    // 抓两页搜索提高覆盖；与搜索同规则只保留可完整播放曲目（VIP/试听一律不展示），并过滤 <40s 片段
    const raw = [];
    for (const p of [1, 2]) {
      try {
        const url = 'https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?g_tk=5381&uin=0&format=json'
          + '&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1'
          + `&w=${encodeURIComponent(artistName)}&zhidaqu=0&catZhida=0&t=0&flag=1&ie=utf-8&sem=1&aggr=0`
          + `&perpage=30&n=30&p=${p}&remoteplace=txt.mqq.all`;
        const j = await this._json(url);
        const list = j?.data?.song?.list;
        if (Array.isArray(list)) raw.push(...list.map((s) => this._mapSongOld(s)));
      } catch (e) { this.log?.('artistTopSongs page:', e.message); }
    }
    const all = raw.filter((s) => s.id && !s.trial && (!s.duration || s.duration >= 40000));
    const key = artistName.split(/[\s/、·]+/)[0] || artistName;
    const own = all.filter((s) => (s.artist || '').includes(key));
    const songs = (own.length ? own : all).slice(0, limit);
    return { artist: artistName, coverUrl: this._singerPic(mid), songs };
  },

  /* ---------- 首页能力：热歌榜 / 推荐歌单（2026 实测匿名可用） ---------- */
  /** 热歌榜：巅峰榜·热歌（topid=26，300 首；曲目挂在 songlist[].data，老 h5 字段） */
  async trending(n = 50) {
    try {
      const url = 'https://c.y.qq.com/v8/fcg-bin/fcg_v8_toplist_cp.fcg?g_tk=5381&uin=0&format=json'
        + '&inCharset=utf-8&outCharset=utf-8&notice=0&platform=h5&needNewCode=1'
        + '&tpl=3&page=detail&type=top&topid=26';
      const j = await this._json(url);
      const sl = j?.songlist || [];
      return this._fullOnly(sl.slice(0, n).map((x) => this._mapSongOld(x.data || x)));
    } catch (e) { this.log?.('trending:', e.message); return []; }
  },
  /** 推荐歌单 → 网页版 y.qq.com 首页「热门歌单」（SSR __INITIAL_DATA__.hotRecommend，
      与用户在网页看到的列表完全一致：抖音爆火热歌/热歌雷达/车载DJ 等，匿名可用 2026-10 实测） */
  async playlists(n = 16) {
    try {
      const r = await this.host.net.request({
        url: 'https://y.qq.com/', headers: this._headers({ Referer: 'https://y.qq.com/' }),
        method: 'GET', timeout: 20000, encoding: 'utf8'
      });
      if (r.status !== 200 || !r.body) throw new Error(`HTTP ${r.status}`);
      // 提取 window.__INITIAL_DATA__ = {...}; —— 引号/转义感知的花括号配对扫描
      const KEY = '__INITIAL_DATA__';
      const ki = r.body.indexOf(KEY);
      if (ki < 0) throw new Error('SSR 数据块缺失');
      const bs = r.body.indexOf('{', ki + KEY.length);
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let i = bs; i < r.body.length && i - bs < 900000; i++) {
        const c = r.body[i];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { if (--depth === 0) { end = i + 1; break; } }
      }
      if (end < 0) throw new Error('SSR 数据块未闭合');
      // SSR 数据含裸 undefined/NaN 字面量（非严格 JSON），先归一为 null 再解析
      const raw = r.body.slice(bs, end).replace(/:undefined/g, ':null').replace(/:NaN/g, ':null');
      const data = JSON.parse(raw);
      const list = data.hotRecommend || [];
      return list.slice(0, n).map((p) => ({
        id: `pl:qq:${p.dissid}`,
        name: p.dissname || '歌单',
        coverUrl: String(p.imgurl || '').replace(/^http:\/\//, 'https://'), // JSON.parse 已解 \u002F
        curator: 'QQ音乐热门',
        playCount: p.listennum || 0,
        srcId: this.id, srcName: this.name
      })).filter((p) => p.name && !p.id.endsWith(':undefined'));
    } catch (e) { this.log?.('playlists(SSR):', e.message); return []; }
  },
  /** 宿主 playlistDetail 路由别名（pl:qq:<dissid> → 本插件） */
  playlistDetail(id) { return this.getPlaylistDetail(id); },

  /* ---------- 歌单详情 / 我的歌单（登录态接口） ---------- */
  /** 歌单曲目：旧版 ucc 接口（带签名 g_tk）优先，musicu.fcg 兜底；
      2026 起匿名访问统一被「check privacy error / 500003」拦截，须登录 */
  async getPlaylistDetail(dissid) {
    const id = String(dissid);
    // 端点 1：fcg_ucc_getcdinfo_byids_cp（老 h5 字段，与搜索映射同源）
    try {
      const url = 'https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?g_tk=' + this._gtk()
        + `&loginUin=${encodeURIComponent(this._uin())}&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8`
        + '&notice=0&platform=yqq.json&needNewCode=0&new_format=1&pic=500'
        + `&disstid=${encodeURIComponent(id)}&type=1&utf8=1&onlysong=0`;
      const j = await this._json(url, { headers: { Referer: 'https://y.qq.com/' } });
      const cd = j?.cdlist?.[0];
      if (cd && Array.isArray(cd.songlist)) {
        return {
          name: cd.dissname || '',
          coverUrl: String(cd.logo || cd.headurl || '').replace(/^http:\/\//, 'https://'),
          // new_format=1 返回新版字段（mid/name）；旧版（songmid/songname）兼容映射
          tracks: this._fullOnly(cd.songlist.map((s) => (s.songmid ? this._mapSongOld(s) : this._mapSongNew(s))))
        };
      }
      this.log?.('plDetail ucc:', j?.msg || '空结果');
    } catch (e) { this.log?.('plDetail ucc:', e.message); }
    // 端点 2：musicu.fcg PlaylistView（SPA 现用接口）
    try {
      const j = await this._musicu({
        req_0: {
          module: 'music.musichallPlaylist.PlaylistView',
          method: 'GetPlaylistDetail',
          param: { id: Number(id), num: 5, songBegin: 0, songNum: 200, focus: 0, userInfo: { uin: this._uin() } }
        }
      });
      const d = j?.req_0?.data;
      const cd = d?.cdlist?.[0] || d?.playlist || d || {};
      const sl = cd.songlist || d.songlist || [];
      if (Array.isArray(sl) && sl.length) {
        const tracks = this._fullOnly(sl.map((s) => (s.songmid ? this._mapSongOld(s) : this._mapSongNew(s))));
        return {
          name: cd.dissname || d.dissname || '',
          coverUrl: String(cd.logo || cd.cover || d.logo || '').replace(/^http:\/\//, 'https://'),
          tracks
        };
      }
      this.log?.('plDetail musicu code:', j?.req_0?.code);
    } catch (e) { this.log?.('plDetail musicu:', e.message); }
    return { name: '', coverUrl: '', tracks: [], msg: this._loggedIn() ? '歌单详情加载失败' : 'QQ音乐歌单详情需登录后查看' };
  },

  /** 我的歌单：老接口双端点（方案参考开源项目 Mineradio，2026-10 实测登录态可用）
      - 我创建：rsc/fcgi-bin/fcg_user_created_diss → data.disslist
      - 我收藏：fav/fcgi-bin/fcg_get_profile_order_asset.fcg → data.cdlist
      （musicu GetMyHomePage 已被 500003 隐私拦截，弃用） */
  async userPlaylists() {
    if (!this._loggedIn()) return [];
    const uin = this._uin();
    if (uin === '0') return [];
    const out = [], seen = new Set();
    const push = (p) => {
      const rawId = p.dissid ?? p.tid ?? p.dirid ?? p.dir_id ?? p.id;
      if (rawId == null || seen.has(rawId)) return;
      seen.add(rawId);
      const name = p.diss_name || p.dissname || p.name || p.title || '';
      if (!name) return;
      if (/qzone|空间|背景音乐/i.test(name)) return; // 用户要求：Qzone背景音乐歌单不加载
      out.push({
        id: `pl:qq:${rawId}`,
        name,
        coverUrl: String(p.diss_cover || p.logo || p.picurl || p.imgurl || '').replace(/^http:\/\//, 'https://'),
        curator: p.hostname || p.nick || p.creator?.name || 'QQ音乐',
        playCount: p.listen_num ?? p.visitnum ?? p.listennum ?? 0,
        trackCount: p.song_cnt ?? p.songnum ?? p.total_song_num ?? 0,
        srcId: this.id, srcName: this.name
      });
    };
    // 端点 1：我创建的歌单
    try {
      const url = 'https://c.y.qq.com/rsc/fcgi-bin/fcg_user_created_diss?hostUin=0&hostuin=' + encodeURIComponent(uin)
        + '&sin=0&size=100&g_tk=' + this._gtk() + '&loginUin=' + encodeURIComponent(uin)
        + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
      const j = await this._json(url, { headers: { Referer: 'https://y.qq.com/' } });
      const rows = j?.data?.disslist;
      if (Array.isArray(rows)) for (const p of rows) push(p);
      else this.log?.('userPlaylists created:', j?.code, j?.msg || '空 disslist');
    } catch (e) { this.log?.('userPlaylists created:', e.message); }
    // 端点 2：我收藏的歌单
    try {
      const url = 'https://c.y.qq.com/fav/fcgi-bin/fcg_get_profile_order_asset.fcg?ct=20&cid=205360956'
        + '&userid=' + encodeURIComponent(uin) + '&reqtype=3&sin=0&ein=99'
        + '&g_tk=' + this._gtk() + '&loginUin=' + encodeURIComponent(uin)
        + '&format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0';
      const j = await this._json(url, { headers: { Referer: 'https://y.qq.com/' } });
      const rows = j?.data?.cdlist;
      if (Array.isArray(rows)) for (const p of rows) push(p);
      else this.log?.('userPlaylists collect:', j?.code, j?.msg || '空 cdlist');
    } catch (e) { this.log?.('userPlaylists collect:', e.message); }
    return out;
  }
};

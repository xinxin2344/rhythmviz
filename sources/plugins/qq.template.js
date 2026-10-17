/* ============================================================
   音源插件模板：QQ音乐（逆向 · 需自行补全接口实现）
   ------------------------------------------------------------
   ⚠️ 第三方逆向音源：仅限个人本地学习研究，禁止分发/商用。
   本文件为结构模板：*.template.js 不会被自动加载，
   补全实现后重命名为 qq.js 放入 sources/plugins/ 即生效。
   ============================================================ */
module.exports = {
  id: 'qq',
  name: 'QQ音乐',
  version: '0.1.0-template',
  updateUrl: '',

  init(host) { this.host = host; },

  /* 签名解耦示例：QQ 接口通常需要 sign 参数，多版本降级结构如下 */
  signers: [
    // { name: 'v3-zzd', sign(params) { /* TODO: 实现 ZZD 签名 */ return params; } },
    // { name: 'v2-old', sign(params) { /* TODO: 旧版签名兜底 */ return params; } }
  ],
  _sign(params) {
    if (!this.signers.length) throw Object.assign(new Error('模板未实现签名，请补全 signers'), { code: 'E_SIGN' });
    for (const s of this.signers) { try { return s.sign({ ...params }); } catch { /* 降级 */ } }
    throw Object.assign(new Error('全部签名版本失效'), { code: 'E_SIGN' });
  },

  _headers(extra) {
    return {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Referer': 'https://y.qq.com/',
      'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty',
      ...extra
    };
  },

  /* 扫码登录（宿主提供 BrowserWindow，Cookie 自动持久化） */
  async login() {
    const cookies = await this.host.login.open('https://y.qq.com/');
    this.host.notify(`已获取 ${cookies.length} 条 Cookie`);
  },

  async search(/* kw, page */) { return []; /* TODO: u.y.qq.com/cgi-bin/musicu.fcg 请求 */ },
  async getPlayUrl(/* id */) { return { url: null }; /* TODO: u.y.qq.com/cgi-bin/musicu.fcg vkey 获取 */ },
  async getLyric(/* id */) { return { lrc: '' }; /* TODO: c.y.qq.com/lyric/fcgi */ }
};

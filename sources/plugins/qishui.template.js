/* ============================================================
   音源插件模板：汽水音乐（逆向 · 需自行补全接口实现）
   ------------------------------------------------------------
   ⚠️ 第三方逆向音源：仅限个人本地学习研究，禁止分发/商用。
   补全实现后重命名为 qishui.js 放入 sources/plugins/ 即生效。
   ============================================================ */
module.exports = {
  id: 'qishui',
  name: '汽水音乐',
  version: '0.1.0-template',
  updateUrl: '',

  init(host) { this.host = host; },

  /* 汽水接口需要 X-Ladon / X-Gorgon 等设备签名；多版本降级结构同 QQ 模板 */
  signers: [],
  _sign(params) {
    if (!this.signers.length) throw Object.assign(new Error('模板未实现签名，请补全 signers'), { code: 'E_SIGN' });
    for (const s of this.signers) { try { return s.sign({ ...params }); } catch { /* 降级 */ } }
    throw Object.assign(new Error('全部签名版本失效'), { code: 'E_SIGN' });
  },

  _headers(extra) {
    return {
      'User-Agent': 'com.luna.music/6.0.0 (device:Android)',
      ...extra
    };
  },

  /* 扫码登录：宿主打开登录窗，Cookie 自动持久化到插件 CookieJar */
  async login() {
    const cookies = await this.host.login.open('https://qishui.douyin.com/');
    this.host.notify(`已获取 ${cookies.length} 条 Cookie`);
  },

  async search(/* kw, page */) { return []; /* TODO */ },
  async getPlayUrl(/* id */) { return { url: null }; /* TODO：注意识别 DRM/加密流，宿主会自动跳过换源 */ },
  async getLyric(/* id */) { return { lrc: '' }; /* TODO */ }
};

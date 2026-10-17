/* ============================================================
   音源插件模板：Pixabay 音乐（需自行补全接口实现）
   ------------------------------------------------------------
   说明：Pixabay 官方公开 API 仅覆盖图片/视频，音乐部分没有官方
   API，因此主程序不内置该源（避免爬虫代码进入 exe）。
   如需使用，请在本模板内自行补全站点接口实现，重命名为
   pixabay.js 放入 sources/plugins/ —— 插件内容由用户自担责任。
   ============================================================ */
module.exports = {
  id: 'pixabay',
  name: 'Pixabay 音乐（插件）',
  version: '0.1.0-template',
  updateUrl: '',

  init(host) { this.host = host; },

  async search(/* kw, page */) { return []; /* TODO: 站点接口自行实现 */ },
  async getPlayUrl(/* id */) { return { url: null }; /* TODO */ }
};

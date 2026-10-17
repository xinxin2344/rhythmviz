/* ============ 封面取色自适应主题：主/辅色提取 → CSS 变量 + 场景调色板 ============ */

const FALLBACK = { hue: 175, hue2: 268 }; // 默认薄荷/紫

/** 加载图片（跨域封面依赖已缓存的 blob，失败静默） */
function loadImage(url) {
  return new Promise((res, rej) => {
    const im = new Image();
    if (!url.startsWith('blob:') && !url.startsWith('data:')) im.referrerPolicy = 'no-referrer';
    im.onload = () => res(im);
    im.onerror = rej;
    im.src = url;
  });
}

/** 从封面提取主色与辅助色（饱和度加权聚类，44px 采样足够） */
function extract(img) {
  const SN = 44;
  const cv = document.createElement('canvas');
  cv.width = cv.height = SN;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  cx.drawImage(img, 0, 0, SN, SN);
  const d = cx.getImageData(0, 0, SN, SN).data;
  const buckets = new Map(); // hue/24 分桶
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i], g = d[i + 1], b = d[i + 2];
    const [h, s, l] = rgbToHsl(r, g, b);
    if (s < 0.18 || l < 0.08 || l > 0.94) continue; // 排除灰/黑/白
    const key = Math.floor(h / 24);
    const o = buckets.get(key) || { n: 0, h: 0, s: 0, l: 0 };
    o.n++; o.h += h; o.s += s; o.l += l;
    buckets.set(key, o);
  }
  if (!buckets.size) return null;
  const arr = [...buckets.values()].map(o => ({ n: o.n, h: o.h / o.n, s: o.s / o.n, l: o.l / o.n }))
    .sort((a, b) => b.n - a.n);
  const main = arr[0];
  // 辅助色：与主色相距最远的次大簇
  let assist = null, far = -1;
  for (const c of arr.slice(1, 5)) {
    const dh = Math.min(Math.abs(c.h - main.h), 360 - Math.abs(c.h - main.h));
    const score = c.n * (1 + dh / 180);
    if (score > far) { far = score; assist = c; }
  }
  return { main, assist: assist || { ...main, h: (main.h + 40) % 360 } };
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const dd = max - min;
    s = l > 0.5 ? dd / (2 - max - min) : dd / (max + min);
    if (max === r) h = ((g - b) / dd + (g < b ? 6 : 0)) * 60;
    else if (max === g) h = ((b - r) / dd + 2) * 60;
    else h = ((r - g) / dd + 4) * 60;
  }
  return [h, s, l];
}

function hslToCss(h, s, l) { return `hsl(${h.toFixed(0)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%)`; }

/** 保证文字对比度：亮度钳制到可读区间 */
function readable(c, minS = 0.42) {
  const l = Math.min(0.68, Math.max(0.42, c.l < 0.5 ? Math.max(c.l, 0.5) : Math.min(c.l, 0.68)));
  const s = Math.max(minS, Math.min(0.85, c.s));
  return { h: c.h, s, l };
}

export class ThemeEngine {
  constructor(app) {
    this.app = app;
    this.lastKey = null;
    this.uiHue = 'follow';   // 固定主题色相（settings.uiHue）：'follow'=跟随，数字=固定
    this.colorSrc = 'theme'; // 场景配色来源（settings.colorSrc）：'theme' 跟随主题 / 'bg' 跟随背景 / 'cover' 跟随封面
    this._bgKey = null;      // 背景取色缓存 key（图片 dataURL / 预设渐变名）：背景不变不重取
    this._palTheme = null;   // 主题管线色板 { main, assist }（固定色相时产出）
    this._palBg = null;      // 背景管线色板
    this._palCover = null;   // 封面管线色板
  }

  /** 主页自定义背景状态：图片（settings.bg）/ 预设渐变（bgPreset）/ 无；
      视频背景暂不做取色，按「无」处理走封面兜底 */
  _bgState() {
    const s = this.app.settings || {};
    if (s.bg) return { type: 'image', key: s.bg, url: s.bg };
    if (s.bgPreset) return { type: 'preset', key: s.bgPreset };
    return { type: 'none' };
  }

  /** 主题颜色（设置·外观 THEME 分区）：'follow'=跟随背景/封面，数字=固定色相；启动时与切换时调用 */
  setFixedHue(v) {
    if (v === 'follow' || v == null || v === '') {
      this.uiHue = 'follow';
      this._palTheme = null;
      const t = this.app.engine?.current;
      return t ? this.applyFromTrack(t) : this.reset(); // 恢复跟随：立即按当前背景/封面重新取色
    }
    const n = Math.round(+v);
    if (!Number.isFinite(n)) return;
    this.uiHue = ((n % 360) + 360) % 360;
    this._applyFixed();
  }

  /** 场景配色来源（视觉控制台·预设页 COLOR 分区）：'theme' 跟随主题 / 'bg' 跟随背景 / 'cover' 跟随封面。
      只影响可视化场景调色板（setPaletteHue），UI 主题色仍由 uiHue 控制 */
  setColorSrc(v) {
    const s = (v === 'bg' || v === 'cover') ? v : 'theme';
    if (s === this.colorSrc) return;
    this.colorSrc = s;
    // 立即按新来源重取：固定主题色下背景/封面管线可能被 gate，需强制运行一次
    return this.applyFromTrack(this.app.engine?.current || null);
  }

  /** 固定主题色：色板登记后统一落地（hue2 = hue+40 邻近色） */
  _applyFixed() {
    const h = this.uiHue, h2 = (h + 40) % 360;
    this._palTheme = { main: { h, s: 0.75, l: 0.6 }, assist: { h: h2, s: 0.7, l: 0.66 } };
    this._applyCss();
    this._applyPal();
  }

  /** 主/辅色落地到全局 CSS 变量（--accent/--champagne/--accent-rgb） */
  _paintCss(main, assist) {
    const rs = document.documentElement.style;
    rs.setProperty('--accent', hslToCss(main.h, main.s, main.l));
    rs.setProperty('--champagne', hslToCss(assist.h, assist.s, assist.l));
    rs.setProperty('--accent-rgb', hslToRgbStr(main.h, main.s, main.l));
  }

  /** UI 主题色：固定色相优先；跟随模式 = 封面 → 背景 → 默认（封面优先：用户点「跟随封面」即所见） */
  _applyCss() {
    let pick = this._palTheme;
    if (!pick && this.uiHue === 'follow' && this.app.adaptiveTheme !== false) pick = this._palCover || this._palBg;
    if (!pick) {
      const rs = document.documentElement.style;
      rs.removeProperty('--accent');
      rs.removeProperty('--champagne');
      rs.removeProperty('--accent-rgb');
      return;
    }
    this._paintCss(pick.main, pick.assist);
  }

  /** 场景调色板：
      - colorSrc='theme' → 使用主题色（固定色相时就是全局色；跟随模式回退封面/背景）
      - colorSrc='cover' → 跟随封面
      - colorSrc='bg'    → 跟随背景 */
  _applyPal() {
    let pick;
    if (this.colorSrc === 'theme') pick = this._palTheme || this._palCover || this._palBg;
    else if (this.colorSrc === 'cover') pick = this._palCover || this._palBg || this._palTheme;
    else pick = this._palBg || this._palCover || this._palTheme;
    this.app.scenes.setPaletteHue(pick ? pick.main.h : FALLBACK.hue, pick ? pick.assist.h : FALLBACK.hue2);
  }

  /** 统一取色入口：按需运行背景/封面管线（UI 跟随模式 或 场景配色来源需要），然后落地 CSS 变量 + 场景调色板 */
  async applyFromTrack(track) {
    if (this.app.adaptiveTheme === false) return this.reset();
    const tasks = [];
    if (this.uiHue === 'follow' || this.colorSrc === 'bg') tasks.push(this._ensureBgPal());
    if (this.uiHue === 'follow' || this.colorSrc === 'cover') tasks.push(this._ensureCoverPal(track));
    await Promise.all(tasks);
    this._applyCss();
    this._applyPal();
  }

  /** 背景管线：自定义图片聚类取色 / 预设渐变固定色相（缓存：背景不变不重取）；无背景清空色板 */
  async _ensureBgPal() {
    const bg = this._bgState();
    if (bg.type === 'preset') {
      const h = this.app.constructor.SPLASH_PRESET_HUE?.[bg.key];
      if (h != null) {
        this._bgKey = bg.key;
        this._palBg = { main: { h, s: 0.75, l: 0.6 }, assist: { h: (h + 40) % 360, s: 0.7, l: 0.66 } };
      }
      return;
    }
    if (bg.type !== 'image') { this._bgKey = null; this._palBg = null; return; }
    if (this._bgKey === bg.key && this._palBg) return;
    try {
      const img = await loadImage(bg.url);
      const ex = extract(img);
      if (!ex) return;
      if (this._bgState().key !== bg.key) return; // 取色等待期间背景又切换了：丢弃过期结果
      this._bgKey = bg.key;
      this._palBg = { main: readable(ex.main), assist: readable(ex.assist, 0.35) };
    } catch { /* 取色失败保持当前色板 */ }
  }

  /** 封面管线：封面聚类取色（缓存：封面不变不重取）；无封面清空色板 */
  async _ensureCoverPal(track) {
    const url = track?.coverBlob || track?.coverUrl;
    if (!url) { this.lastKey = null; this._palCover = null; return; }
    if (this.lastKey === url && this._palCover) return;
    this.lastKey = url;
    try {
      const img = await loadImage(url);
      const ex = extract(img);
      if (!ex) return;
      if (this.lastKey !== url) return; // 取色等待期间又切歌：丢弃过期结果
      this._palCover = { main: readable(ex.main), assist: readable(ex.assist, 0.35) };
    } catch { /* 取色失败保持当前色板 */ }
  }

  reset() {
    this.lastKey = null;
    this._palCover = null;
    if (this.app.adaptiveTheme === false) { this._bgKey = null; this._palBg = null; }
    this._applyCss();
    this._applyPal();
    // 背景管线异步刷新（跟随模式 / 场景配色需要时，重置后仍应跟随背景）
    if (this.app.adaptiveTheme !== false && (this.uiHue === 'follow' || this.colorSrc === 'bg')) {
      this._ensureBgPal().then(() => { this._applyCss(); this._applyPal(); });
    }
  }
}

function hslToRgbStr(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `${f(0)}, ${f(8)}, ${f(4)}`;
}

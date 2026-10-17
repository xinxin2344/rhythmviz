/* ============ 应用入口：装配引擎 / 场景 / 歌词 / UI ============ */
import { AudioEngine, makeTrack, setOnlineHooks } from './audio.js';
import { SceneManager } from './scenes.js';
import { LyricRenderer } from './lyrics.js';
import { setupUI, toast } from './ui.js';
import { setupSourceMgr } from './sourcemgr-ui.js';

const AUDIO_EXT = /\.(mp3|flac|m4a|aac|ogg|opus|wav|wma|ape)$/i;

/* 在线资源分发：插件音源 / 403-签名-DRM 自动换源（直链绝不缓存） */
const resolveOnlineUrl = async (t) => {
  const r = await window.api.sourcePlayUrl({ srcId: t.srcId || 'netease', id: t.songId, title: t.title, artist: t.artist });
  if (!r?.url) throw new Error(r?.msg || '全部音源均无法获取播放地址');
  if (r.newId) t.songId = r.newId;   // 换源命中后的新歌曲 id（歌词/封面跟随）
  if (r.via) t.srcId = r.srcId;
  return r;
};
const resolveOnlineLyric = async (t) => {
  try { return await window.api.sourceLyricMatch({ srcId: t.srcId || 'netease', id: t.songId, title: t.title, artist: t.artist }); }
  catch { return null; } // 部分音源可能无歌词接口，静默降级
};

class App {
  constructor() {
    this.engine = new AudioEngine();
    this.scenes = new SceneManager(document.getElementById('stage'), this.engine);
    this.lyrics = new LyricRenderer(
      document.getElementById('lyrics'),
      document.getElementById('lyricTrack'),
      document.getElementById('lyricHint')
    );
    this.npOpen = false;
    this.lyricStyle = 'flow';
    this._chromeTimer = 0;
    this._idleTimer = 0;
  }

  async boot() {
    // 启动页自定义背景：settings 走异步 IPC，先从 localStorage 同步兜底应用，避免启动页闪默认纯色主题
    this.applySplashBg(localStorage.getItem('spBgImg'));
    // 读取设置
    try {
      const s = await window.api.getSettings();
      this.settings = s || {};
      this.engine.setVolume(s.volume ?? 0.8);
      document.getElementById('volume').value = Math.round((s.volume ?? 0.8) * 100);
      this.lyricStyle = s.lyricStyle || 'flow';
      document.getElementById('lyrics').className = `lyrics style-${this.lyricStyle}`;
      // 恢复场景：注册表校验兜底 —— 未设置 / 非法值（存量已删场景 warp/sonic/synth 等未知 key）一律回退默认「圆环频谱」
      const sceneKey = (s.scene && this.scenes.scenes[s.scene]) ? s.scene : 'ring';
      // 启动恢复：直接赋值跳过淡入淡出（启动页遮挡期间完成）；主页只显示圆环频谱，
      // 用户所选场景暂存为 _userScene，进播放页/Folia 时自动恢复
      this.scenes.applyStartupScene(sceneKey, document.body.classList.contains('home-active'));
      document.querySelectorAll('.scene-btn').forEach(b => b.classList.toggle('active', b.dataset.scene === sceneKey));
      // 播放模式恢复：playMode（list/one/shuffle）优先，兼容旧版 shuffle 布尔设置
      this.engine.setPlayMode(s.playMode || (s.shuffle ? 'shuffle' : 'list'));
      // 恢复自定义背景（选图 > 预设渐变）
      if (s.bg) this.applyBg(s.bg);
      else if (s.bgPreset) this.applyBg(null, s.bgPreset);
      // 歌词参数
      this.beatBounce = s.beatBounce !== false;
      this.lyricAnim = s.lyricAnim !== false;
      this.lyrics.bounce = this.beatBounce;
      this.lyrics.anim = this.lyricAnim;
      if (s.textFx) this.lyrics.setTextFx(s.textFx);
      if (s.adaptiveTheme === false) this.adaptiveTheme = false; else this.adaptiveTheme = true;
      // 音效 EQ / 视觉灵敏度（设置中心恢复）
      if (s.eq) this.engine.setEQ(s.eq);
      if (s.sensitivity != null) this.engine.sensitivity = s.sensitivity;
      // 恢复视频背景
      if (s.bgVideo) this.applyVideoBg(s.bgVideo);
      // 启动页自定义背景：以持久化设置为准（undefined=从未设置 → 保留 localStorage 兜底；null=已清除 → 移除）
      if (s.splashBg != null) {
        this.applySplashBg(s.splashBg);
        if (localStorage.getItem('spBgImg') !== s.splashBg) {
          try { localStorage.setItem('spBgImg', s.splashBg); } catch { /* 配额不足忽略 */ }
        }
      } else if (s.splashBg === null) this.applySplashBg(null);
      // 全局外观：UI 字体 / 亮度（玻璃 --glass-a 由 ui.js 恢复滑块逻辑统一应用）
      this.applyUiFont(s.uiFont || '');
      if (s.uiBright != null) this.applyUiBright(s.uiBright);
    } catch { this.settings = {}; }

    setupUI(this);
    // 主页只允许圆环频谱背景：home-active 类变化统一驱动（覆盖 goHome / 播放页 / 全屏歌词 / Folia 所有切换路径）
    new MutationObserver(() => {
      this.scenes.setHomeMode(document.body.classList.contains('home-active'));
    }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
    // 主页自定义背景已恢复时主题立即跟随（图片取色/渐变固定色相；无背景走封面兜底）——
    // 不必等下一首封面事件才落到背景色系；固定主题色用户在 setupUI 内已应用，此处幂等
    this.theme?.applyFromTrack(this.engine.current);
    // 音源分发钩子：外部插件音源 / 自动换源
    setOnlineHooks({ url: resolveOnlineUrl, lyric: resolveOnlineLyric });
    // 歌词行点击 → 跳转播放进度（加回 lyricOffset：行高亮时刻 = line.time + offset）
    this.lyrics.onSeek = (sec) => this.engine.seek(Math.max(0, sec + (this.lyricOffset || 0)));
    setupSourceMgr(this);
    if (window.api.onSourceNotify) {
      window.api.onSourceNotify((msg) => toast(msg, 4200));
    }
    // 首次启动安全提示（合规声明：启动页结束后弹出，勾选确认一次后不再弹出）
    setTimeout(() => {
      if (!this._shotMode && !this.settings.securityAck) this.showSecurityNotice();
    }, 3400);
    this.scenes.start((bands) => this.onFrame?.(bands));
    this.setupDragDrop();
    this.setupKeys();
    this.setupCloseAsk();
    this.setupChromeAutohide();
    this.setupFocusExit();
    // 启动页：星尘 + 初始化进度阶段（纯 CSS 动画，此处仅驱动进度宽度）
    this._initSplash();
    // 启动页自动进入（进度收尾后整体平滑淡出；点击可跳过）
    setTimeout(() => { if (!this._shotMode) this.dismissSplash(); }, 3300);
    // 恢复本地播放列表
    const paths = this.settings.localPaths || [];
    if (paths.length) {
      const valid = paths.filter(p => AUDIO_EXT.test(p));
      if (valid.length) await this.importPaths(valid, false);
    }

    // 自动测试（npm 环境变量触发）
    if (window.api.onAutotest) {
      window.api.onAutotest(() => this.runAutotest());
    }
    // 最小化暂停可视化渲染（省电）
    if (window.api.onMinimized) window.api.onMinimized((m) => this.scenes.setPaused(m));
    // 迷你悬浮窗控制命令
    if (window.api.onMiniCmd) {
      window.api.onMiniCmd((cmd) => {
        if (cmd === 'toggle') this.engine.playPause();
        else if (cmd === 'next') this.engine.next();
        else if (cmd === 'prev') this.engine.prev();
      });
    }
    // 截图自检：播放演示曲并切换到指定场景
    if (window.api.onShot) {
      window.api.onShot(async (scene, kw) => {
        this._shotMode = true;
        this.toggleNp(false);
        if (scene === 'splash') { document.body.classList.remove('show-chrome'); console.log('SHOT_READY scene=splash'); return; }
        if (scene === 'home' || scene === 'wall' || scene === 'plfull') {
          this.dismissSplash();
          if (scene === 'wall' || scene === 'plfull') {
            document.querySelector('#plViewSeg button[data-pv="wall"]')?.click();
            setTimeout(() => document.getElementById('plGrid')?.scrollIntoView({ block: 'center' }), 900);
            if (scene === 'plfull') setTimeout(() => document.getElementById('btnPlFull')?.click(), 1400);
          }
          if (kw) {
            const inp = document.getElementById('homeSearchInput');
            if (inp) {
              inp.value = kw;
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            }
            console.log('SHOT_READY scene=home-search kw=' + kw);
            return;
          }
          console.log('SHOT_READY scene=' + scene); return;
        }
        if (scene === 'folia') {
          this.dismissSplash();
          // 等待推荐歌单加载完成后点开第一张，进入 Folia 拼图
          const tryOpen = (n) => {
            const card = document.querySelector('#plGrid .pl-card, #plGrid .pw-card');
            if (card) { card.click(); console.log('SHOT_READY scene=folia'); }
            else if (n > 0) setTimeout(() => tryOpen(n - 1), 700);
            else console.log('SHOT_READY scene=folia(no-card)');
          };
          setTimeout(() => tryOpen(8), 1200);
          return;
        }
        this.dismissSplash();
        document.body.classList.add('show-chrome');
        try {
          await this.engine.playDemo();
          await this.applyDemoTrack();
          if (scene === 'fx' || scene === 'drawer' || scene === 'np' || scene === 'fulllyric' || scene === 'src' || scene === 'warn') {
            if (scene === 'fx') document.getElementById('fxPanel').classList.add('open');
            else if (scene === 'drawer') document.getElementById('drawer').classList.add('open');
            else if (scene === 'src') { document.getElementById('drawer').classList.add('open'); document.getElementById('tabSrcBtn')?.click(); }
            else if (scene === 'warn') { document.getElementById('drawer').classList.add('open'); document.getElementById('tabSrcBtn')?.click(); document.getElementById('btnSrcImport')?.click(); }
            else if (scene === 'fulllyric') { await new Promise(r => setTimeout(r, 1200)); this.toggleFullLyric(true); }
            else this.toggleNp(true);
            const r = (id) => { const b = document.getElementById(id)?.getBoundingClientRect(); return b ? [b.x | 0, b.width | 0] : null; };
            console.log('LAYOUT bb=' + r('bottombar') + ' center=' + r('btnPlay') + ' left=' + r('btnShuffle') + ' right=' + r('btnList') + ' vw=' + window.innerWidth);
            console.log('SHOT_READY scene=' + scene);
            return;
          }
          // 截图场景需直接展示目标场景：脱离主页门控（home-active 会强制圆环频谱）；
          // 背景图模式（user-bg）会隐藏 #stage 画布，截图时也需临时移除（仅改运行时 class，不动持久化设置）
          document.body.classList.remove('home-active');
          document.body.classList.remove('user-bg');
          this.scenes.setHomeMode(false);
          if (scene !== this.scenes.current) this.scenes.setScene(scene);
          document.querySelectorAll('.scene-btn').forEach(b => b.classList.toggle('active', b.dataset.scene === scene));
          console.log(`SHOT_READY scene=${this.scenes.current} target=${scene} lyrics=${document.getElementById('lyrics').className}`);
        } catch (e) { console.error('SHOT_FAIL', e && (e.stack || e.message)); }
      });
    }

    if (!this.engine.queue.length) {
      toast('点击任意处进入 · 首页搜索音乐，「视觉」面板可试演示曲', 4000);
    }
  }

  /* ---------- 启动页 ---------- */
  /** 初始化 Splash：稀疏星尘节点（仅 opacity 闪烁）+ canvas 丝绸飘带 + 丝滑进度 */
  _initSplash() {
    this.applySplashTheme(); // 启动页主题色跟随启动页背景（splash='follow' 时；启动时 settings 已就绪）
    // 星尘：26 个微小白点，随机位置/相位，动画本体在 CSS（低功耗，无位移）
    const box = document.getElementById('spStars');
    if (box && !box.childElementCount) {
      for (let i = 0; i < 26; i++) {
        const star = document.createElement('span');
        star.className = 'sp-star';
        const size = Math.random() < 0.75 ? 1.5 : 2.4;
        star.style.width = star.style.height = size.toFixed(1) + 'px';
        star.style.left = (Math.random() * 100).toFixed(2) + '%';
        star.style.top = (Math.random() * 100).toFixed(2) + '%';
        star.style.setProperty('--dur', (3.2 + Math.random() * 4).toFixed(2) + 's');
        star.style.setProperty('--delay', (-Math.random() * 6).toFixed(2) + 's');
        box.appendChild(star);
      }
    }
    const fill = document.getElementById('spBarFill');
    if (fill) this._initSplashProgress(fill);
  }

  /**
   * 丝滑进度条：rAF 每帧把显示值低通插值到连续 ease 目标曲线上，
   * 任何时刻都在匀速微动，杜绝离散阶段跳变与中途停滞；transform:scaleX 走合成线程
   */
  _initSplashProgress(fill) {
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    fill.style.transformOrigin = 'left center';
    const TOTAL = 3050;
    const easeInOut = (x) => (x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2);
    let shown = reduced ? 92 : 0;
    fill.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
    if (reduced) return;
    const t0 = performance.now();
    const step = (now) => {
      const p = Math.min(1, (now - t0) / TOTAL);
      const target = easeInOut(p) * 92; // 常规加载到 92%，dismiss 时冲满 100%
      shown += (target - shown) * 0.16;
      if (p === 1) shown = 92;
      fill.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
      this._spRaf = p < 1 ? requestAnimationFrame(step) : 0;
    };
    this._spRaf = requestAnimationFrame(step);
    // dismiss 时调用：快速但仍逐帧补满，绝不瞬跳
    this._spRush = () => {
      if (this._spRaf) cancelAnimationFrame(this._spRaf);
      this._spRaf = 0;
      const rush = () => {
        shown += (100 - shown) * 0.22;
        if (100 - shown < 0.25) shown = 100;
        fill.style.transform = `scaleX(${(shown / 100).toFixed(4)})`;
        if (shown < 100) this._spRaf = requestAnimationFrame(rush);
      };
      this._spRaf = requestAnimationFrame(rush);
    };
  }

  dismissSplash() {
    document.body.classList.add('show-chrome');
    const sp = document.getElementById('splash');
    if (!sp || this._splashGone) return;
    this._splashGone = true;
    // 停止启动页 rAF（释放 CPU）
    if (this._spRaf) cancelAnimationFrame(this._spRaf);
    this._stopSplashGalaxy();
    // 进度先逐帧丝滑补齐 100%，再让整个 Splash 淡出（幂等，点击跳过同样适用）
    this._spRush?.();
    setTimeout(() => sp.classList.add('gone'), 380);
  }

  /* ---------- 启动页「银河」预设：Mineradio 启动页 WebGL 银河背景的稳态移植 ----------
     着色器逐字参考开源项目 Mineradio（GPL-3.0）public/js/modules/10-shell/03-splash.js，
     仅把时间轴改为持续稳态循环（原作为一次性 intro/climax 演出，本预设常亮运行）；
     WebGL 不可用时隐藏 canvas，自动回退原 CSS 网格/雾气背景 */
  _startSplashGalaxy() {
    const cv = document.getElementById('spGalaxy');
    if (!cv || this._spGalaxyRaf) return;
    let gl = null;
    try {
      gl = cv.getContext('webgl', { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, powerPreference: 'high-performance' });
    } catch { /* noop */ }
    if (!gl) { cv.style.display = 'none'; return; }

    const VERT = [
      'attribute vec2 aPosition;',
      'varying vec2 vUv;',
      'void main(){',
      '  vUv = aPosition * 0.5 + 0.5;',
      '  gl_Position = vec4(aPosition, 0.0, 1.0);',
      '}'
    ].join('\n');
    const FRAG = [
      'precision highp float;',
      'varying vec2 vUv;',
      'uniform vec2 uResolution;',
      'uniform float uTime;',
      '',
      'float saturate(float v){ return clamp(v, 0.0, 1.0); }',
      'float ease(float v){ v = saturate(v); return v * v * (3.0 - 2.0 * v); }',
      'mat2 rot(float a){ float c = cos(a); float s = sin(a); return mat2(c, -s, s, c); }',
      'float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }',
      'float noise(vec2 p){',
      '  vec2 i = floor(p);',
      '  vec2 f = fract(p);',
      '  vec2 u = f * f * (3.0 - 2.0 * f);',
      '  return mix(mix(hash(i), hash(i + vec2(1.0,0.0)), u.x), mix(hash(i + vec2(0.0,1.0)), hash(i + vec2(1.0,1.0)), u.x), u.y);',
      '}',
      '',
      'float animatedLoop(vec2 uv, float t, float channel){',
      '  vec2 q = uv;',
      '  q *= rot(0.28 + sin(t * 0.18) * 0.12);',
      '  q.x += 0.055 * sin(t * 0.30 + channel);',
      '  q.y += 0.040 * cos(t * 0.24 + channel * 1.7);',
      '  float ang = atan(q.y, q.x);',
      '  float angularShift = sin(ang * 3.0 + t * 0.72 + channel * 1.9) * 0.078;',
      '  angularShift += sin(ang * 7.0 - t * 0.54 + channel) * 0.020;',
      '  float neonD = length(q) + angularShift;',
      '  float warpD = length(q * vec2(1.34 + 0.06 * sin(t * 0.25), 0.82 + 0.04 * cos(t * 0.31)));',
      '  warpD += 0.026 * sin(q.x * 4.4 + t * 0.62) + 0.018 * sin(q.y * 5.2 - t * 0.45);',
      '  float diamondD = abs(q.x) * 1.20 + abs(q.y) * 0.84;',
      '  float d = mix(warpD, diamondD, 0.32);',
      '  d = mix(d, neonD, 0.20 + 0.04 * sin(t * 0.18 + channel));',
      '  float pattern = mod((q.x + q.y) * 0.62 + sin(q.x * 5.5 + t) * 0.015 + sin(q.y * 7.0 - t * 0.75) * 0.012, 0.20);',
      '  float acc = 0.0;',
      '  for (int i = 1; i <= 6; i++) {',
      '    float fi = float(i);',
      '    float f = fract(t * 0.152 - channel * 0.018 + 0.011 * fi) * 4.70 - d + pattern;',
      '    acc += 0.00110 * fi * fi / max(abs(f), 0.0065);',
      '  }',
      '  float threadCoord = q.x * 0.92 - q.y * 0.58 + 0.030 * sin(q.x * 5.2 + t * 0.72);',
      '  float threadLines = 0.0065 / max(abs(sin((threadCoord + t * 0.10 + channel * 0.035) * 27.0)), 0.070);',
      '  acc += threadLines * (0.50 + 0.30 * sin(ang * 1.2 + t + channel));',
      '  return min(acc, 1.95);',
      '}',
      '',
      'void main(){',
      '  vec2 p = vUv * 2.0 - 1.0;',
      '  p.x *= uResolution.x / max(uResolution.y, 1.0);',
      '  float t = uTime;',
      // 原作时间轴完整保留：intro 淡入 → bloom 绽放 → climax 同步波峰 → 余辉 → 沉稳态
      '  float intro = ease(t / 0.72);',
      '  float bloomIn = ease((t - 0.10) / 1.10);',
      '  float climax = exp(-pow((t - 3.62) / 0.58, 2.0));',
      '  float preClimax = ease((t - 2.15) / 1.25) * (1.0 - ease((t - 3.86) / 0.72));',
      '  float afterglow = exp(-pow((t - 4.14) / 0.62, 2.0));',
      '  float calm = 1.0 - 0.22 * ease((t - 4.75) / 0.70);',
      '  float settle = 1.0 - 0.34 * ease((t - 5.05) / 0.52);',
      '  vec2 uv = p * (0.98 + 0.05 * sin(t * 0.25));',
      '  uv += vec2(0.0, -0.025);',
      '  vec2 flowAxis = normalize(vec2(0.86, -0.50));',
      '  vec2 crossAxis = vec2(-flowAxis.y, flowAxis.x);',
      '  float lane = dot(p, flowAxis);',
      '  float crossLane = dot(p, crossAxis);',
      '  float syncWave = sin(crossLane * 5.4 + lane * 1.1 - t * 1.85);',
      '  uv += flowAxis * syncWave * 0.055 * climax;',
      '  uv += crossAxis * sin(lane * 7.2 + t * 1.25) * 0.034 * climax;',
      '  uv *= 1.0 + 0.045 * preClimax - 0.020 * climax;',
      '  vec3 ch1 = vec3(1.00, 0.13, 0.31);',
      '  vec3 ch2 = vec3(0.16, 1.00, 0.86);',
      '  vec3 ch3 = vec3(1.00, 0.76, 0.28);',
      '  float a = animatedLoop(uv, t, 0.0);',
      '  float b = animatedLoop(uv * 1.018 + vec2(0.012, -0.008), t + 0.18, 1.0);',
      '  float c = animatedLoop(uv * 0.986 + vec2(-0.010, 0.010), t + 0.35, 2.0);',
      '  vec3 loopCol = ch1 * a + ch2 * b + ch3 * c;',
      '  float tunnel = animatedLoop(uv * 1.42 + vec2(sin(t * 0.2) * 0.08, cos(t * 0.17) * 0.05), t * 1.12 + 1.7, 2.7);',
      '  loopCol += mix(ch2, ch3, 0.35 + 0.25 * sin(t)) * tunnel * (0.30 + 0.24 * preClimax);',
      '  float syncBand = exp(-pow((lane + 0.08 * sin(t * 0.72)) / 0.62, 2.0));',
      '  float phaseThread = pow(0.5 + 0.5 * sin(crossLane * 13.5 + lane * 2.2 - t * 3.1), 8.0);',
      '  float phaseThread2 = pow(0.5 + 0.5 * sin(crossLane * 9.0 - lane * 5.4 + t * 2.4), 10.0);',
      '  vec3 climaxCol = (mix(ch2, ch3, 0.36) * phaseThread + ch1 * phaseThread2 * 0.52) * syncBand * climax;',
      '  float afterBand = exp(-pow((lane - 0.34) / 0.72, 2.0));',
      '  climaxCol += mix(ch1, ch2, vUv.x) * afterBand * afterglow * 0.13;',
      '  float centerBeam = exp(-abs(p.y + 0.005 * sin(t * 3.0)) * 24.0) * (0.14 + 0.52 * exp(-pow((t - 0.74) / 0.34, 2.0)));',
      '  float bladeMask = smoothstep(-1.55, -0.08, p.x) * (1.0 - smoothstep(0.08, 1.55, p.x));',
      '  vec3 blade = mix(ch1, ch2, vUv.x) * centerBeam * bladeMask * (0.40 + 0.28 * climax);',
      '  float flare = exp(-dot(p, p) * 3.6) * exp(-pow((t - 0.88) / 0.40, 2.0));',
      '  vec3 col = vec3(0.002, 0.004, 0.005);',
      '  col += loopCol * (0.56 + 0.46 * bloomIn) * calm * settle;',
      '  col += climaxCol * 0.22;',
      '  float diagonalGlint = exp(-pow(lane * 1.2 + crossLane * 0.10, 2.0) / 0.030) * climax;',
      '  col += blade + vec3(1.0, 0.78, 0.42) * flare * 0.18 + vec3(1.0, 0.86, 0.58) * diagonalGlint * 0.07;',
      '  float scan = 0.92 + 0.08 * sin((vUv.y * uResolution.y + t * 52.0) * 0.72);',
      '  float grain = noise(vUv * uResolution.xy * 0.52 + t * 17.0) - 0.5;',
      '  col *= scan;',
      '  col += grain * 0.018;',
      '  col *= intro;',
      '  col = max(col - vec3(0.010, 0.012, 0.012), 0.0);',
      '  col = vec3(1.0) - exp(-max(col, 0.0) * (0.62 + 0.18 * climax));',
      '  float vignette = smoothstep(1.52, 0.20, length(p * vec2(0.78, 1.04)));',
      '  col *= 0.38 + 0.86 * vignette;',
      '  col += vec3(0.020, 0.010, 0.014) * (1.0 - vignette);',
      '  gl_FragColor = vec4(col, 1.0);',
      '}'
    ].join('\n');

    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) { gl.deleteShader(s); return null; }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, VERT), fs = compile(gl.FRAGMENT_SHADER, FRAG);
    if (!vs || !fs) { cv.style.display = 'none'; return; }
    const prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) { cv.style.display = 'none'; return; }
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'aPosition');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uResolution');
    const uTime = gl.getUniformLocation(prog, 'uTime');

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.75); // 限 DPR 控制 GPU 负载
      const w = Math.max(1, Math.round(cv.clientWidth * dpr));
      const h = Math.max(1, Math.round(cv.clientHeight * dpr));
      if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
      gl.viewport(0, 0, w, h);
    };
    resize();
    window.addEventListener('resize', resize);
    const t0 = performance.now();
    const frame = (now) => {
      gl.uniform2f(uRes, cv.width, cv.height);
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      this._spGalaxyRaf = requestAnimationFrame(frame);
    };
    this._spGalaxyRaf = requestAnimationFrame(frame);
    this._spGalaxyGL = { gl, cv, resize };
  }
  _stopSplashGalaxy() {
    if (this._spGalaxyRaf) { cancelAnimationFrame(this._spGalaxyRaf); this._spGalaxyRaf = 0; }
    const g = this._spGalaxyGL;
    if (g) {
      window.removeEventListener('resize', g.resize);
      try { g.gl.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* noop */ }
      this._spGalaxyGL = null;
    }
  }

  /* ---------- 首启安全提示（合规声明：主程序不内置任何音源；第三方插件自担责任） ---------- */
  showSecurityNotice() {
    const m = document.getElementById('secNoticeModal');
    if (!m) return;
    m.classList.remove('hidden');
    const ack = document.getElementById('secNoticeAck');
    const ok = document.getElementById('secNoticeOk');
    if (ack && ok) {
      ok.disabled = true;
      ack.addEventListener('change', () => { ok.disabled = !ack.checked; });
    }
    ok?.addEventListener('click', () => {
      m.classList.add('hidden');
      this.settings.securityAck = true;
      window.api.setSetting('securityAck', true);
    }, { once: true });
    m.addEventListener('click', (e) => {
      // 点遮罩不关闭，必须显式确认（合规要求）
      if (e.target === m) toast('请阅读并确认安全提示后继续', 2600);
    });
  }

  /* ---------- 关闭确认：主进程拦截 ✕/Alt+F4 转发至此弹窗（记住选择持久化到主进程 store） ---------- */
  setupCloseAsk() {
    const m = document.getElementById('closeAskModal');
    if (!m) return;
    const cb = document.getElementById('closeAskRemember');
    window.api.onCloseAsk?.(() => m.classList.remove('hidden'));
    const pick = (action) => {
      m.classList.add('hidden');
      window.api.closeChoice?.({ action, remember: !!cb?.checked });
      if (cb?.checked) this.settings.closeAction = action;
    };
    document.getElementById('closeAskMin')?.addEventListener('click', () => pick('minimize'));
    document.getElementById('closeAskExit')?.addEventListener('click', () => pick('exit'));
  }

  /* ---------- 启动页主题：飘带/标题辉光颜色跟随背景主色相 ---------- */
  /** 预设渐变 → 主色相映射（与 applyBg 中各预设视觉主色一致） */
  static SPLASH_PRESET_HUE = {
    aurora: 168, dusk: 275, mono: 215, mint: 168, rose: 338, forest: 148,
    graphite: 218, violet: 262, ocean: 205, cosmos: 258, ember: 22, jade: 160
  };
  /**
   * 计算并写入 #splash 的 --sp-hue（启动页主题色独立于全局主题色，互不冲突）：
   * settings.splash === 'follow'（默认）→ 跟随启动页背景：自定义背景图取主色相，无图用默认冷蓝
   * 数字 hue → 手动指定（设置·外观「启动页」色板 / 自定义取色），此时主页背景变化不影响启动页
   */
  applySplashTheme() {
    const sp = document.getElementById('splash');
    if (!sp) return;
    const setHue = (v) => sp.style.setProperty('--sp-hue', String(v));
    const opt = this.settings?.splash ?? 'follow';
    // 「银河」预设：WebGL 动态背景（Mineradio 风）。标题颜色仍可由用户自定义 ——
    // 取最近一次手动选定的启动页色相（settings.splashGalaxyHue，默认青绿 165）作为虹彩起点。
    if (opt === 'mr-galaxy') {
      const gh = +this.settings?.splashGalaxyHue;
      setHue(isFinite(gh) ? gh : 165);
      sp.classList.add('sp-galaxy');
      this._startSplashGalaxy();
      return;
    }
    sp.classList.remove('sp-galaxy');
    this._stopSplashGalaxy();
    if (opt !== 'follow' && isFinite(+opt)) {
      setHue(+opt);
      // 记忆手动色相：之后切到「银河」，标题虹彩以此为起点展开
      if (String(this.settings?.splashGalaxyHue ?? '') !== String(+opt)) {
        this.settings.splashGalaxyHue = +opt;
        window.api?.setSetting?.('splashGalaxyHue', +opt);
      }
      return;
    }
    // 跟随启动页背景：settings.splashBg 自定义图 → canvas 采样提取最饱和主色相（异步，未就绪前用默认色）
    const spBg = this.settings?.splashBg;
    if (spBg) {
      this._hueFromImage(spBg).then(h => { if (h != null) setHue(h); }).catch(() => {});
      return;
    }
    setHue(220); // 无自定义启动页背景 → 默认冷蓝（默认深色渐变背景的主色相）
  }
  /** 从图片 dataURL 提取主色相：小画布采样，取「饱和度高且不过暗」的像素桶中最大众的色相段 */
  _hueFromImage(dataUrl) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const n = 24, cv = document.createElement('canvas');
          cv.width = cv.height = n;
          const cx = cv.getContext('2d', { willReadFrequently: true });
          cx.drawImage(img, 0, 0, n, n);
          const d = cx.getImageData(0, 0, n, n).data;
          const buckets = new Float32Array(24);
          for (let i = 0; i < n * n; i++) {
            const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
            const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
            const sat = (mx - mn) / (mx + 0.001), luma = (r * 0.3 + g * 0.6 + b * 0.1) / 255;
            if (mx < 30 || sat < 0.22 || luma > 0.92) continue; // 跳过灰暗与白
            let h;
            if (mx === r) h = ((g - b) / (mx - mn)) % 6;
            else if (mx === g) h = (b - r) / (mx - mn) + 2;
            else h = (r - g) / (mx - mn) + 4;
            h = ((h * 60) + 360) % 360;
            buckets[Math.floor(h / 15) % 24] += sat * (0.35 + luma);
          }
          let best = -1, bv = 0;
          for (let i = 0; i < 24; i++) if (buckets[i] > bv) { bv = buckets[i]; best = i; }
          resolve(best < 0 ? null : Math.round(best * 15 + 7.5));
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /* ---------- 启动页自定义背景图：铺满 + 深色压暗罩，网格/星尘/飘带仍在其上 ---------- */
  /**
   * 应用启动页背景图（settings.splashBg；localStorage 键 spBgImg 双写兜底同步启动）。
   * 先经 Image 预检：加载成功才注入 #spBgImg 背景层，失败则移除并回退纯色渐变主题
   */
  applySplashBg(dataUrl) {
    const sp = document.getElementById('splash');
    if (!sp) return;
    const clear = () => { document.getElementById('spBgImg')?.remove(); };
    if (!dataUrl) { clear(); return; }
    const probe = new Image();
    probe.onload = () => {
      if (this._splashGone) return; // 启动页已退场则不再铺
      let el = document.getElementById('spBgImg');
      if (!el) {
        el = document.createElement('div');
        el.id = 'spBgImg';
        sp.prepend(el); // CSS z-index:-1 → 压在网格/雾/星尘/飘带之下、#splash 渐变之上
      }
      el.style.backgroundImage = `url("${dataUrl}")`;
    };
    probe.onerror = () => clear(); // 图片加载失败：回退纯色主题（压暗罩随层一并移除）
    probe.src = dataUrl;
  }

  /* ---------- 全局 UI 字体：写 :root 的 --ui-font（body 引用），缺省回落 --font-sans ---------- */
  /** 各字体族补全 CJK/通用回退，选项与歌词字体一致；歌词走 --lyric-font 独立变量、互不影响 */
  static UI_FONT_STACKS = {
    'Microsoft YaHei': '"Microsoft YaHei", "Noto Sans SC", sans-serif',
    'SimSun': '"SimSun", "Noto Serif SC", serif',
    'SimHei': '"SimHei", "Noto Sans SC", sans-serif',
    'KaiTi': '"KaiTi", "STKaiti", serif',
    'FangSong': '"FangSong", "STFangsong", serif',
    'DengXian': '"DengXian", "Microsoft YaHei", sans-serif',
    'Georgia': 'Georgia, "Times New Roman", serif',
    'Consolas': 'Consolas, "Cascadia Mono", monospace'
  };
  applyUiFont(family) {
    const r = document.documentElement.style;
    const stack = family && App.UI_FONT_STACKS[family];
    if (stack) r.setProperty('--ui-font', stack);
    else r.removeProperty('--ui-font'); // 默认 → 移除覆盖，回落 --font-sans
  }

  /* ---------- 全局亮度：body::after 全屏遮罩（pointer-events:none 不拦截点击，盖住包括弹窗在内的全部界面） ---------- */
  /** 低于 100% 黑色压暗（alpha=1-b）；高于 100% 白色遮罩 + screen 混合提亮；恰为 100% 清除遮罩零开销 */
  applyUiBright(v) {
    const r = document.documentElement.style;
    const b = Math.max(60, Math.min(130, Math.round(+v || 100)));
    if (b < 100) {
      r.setProperty('--bright-ov', `rgba(0, 0, 0, ${(1 - b / 100).toFixed(3)})`);
      r.setProperty('--bright-blend', 'normal');
    } else if (b > 100) {
      r.setProperty('--bright-ov', `rgba(255, 255, 255, ${(((b - 100) / 30) * 0.32).toFixed(3)})`);
      r.setProperty('--bright-blend', 'screen');
    } else {
      r.removeProperty('--bright-ov');
      r.removeProperty('--bright-blend');
    }
  }

  /* ---------- 自定义背景：dataURL 图片 / 预设渐变 / 清除 ---------- */
  applyBg(dataUrl, preset) {
    const el = document.getElementById('userBg');
    if (!el) return;
    if (dataUrl) {
      el.style.background = `url("${dataUrl}") center / cover no-repeat`;
      document.body.classList.add('user-bg');
      document.body.classList.remove('bg-grad');
    } else if (preset) {
      const grad = {
        aurora: 'radial-gradient(120% 90% at 20% 15%, rgba(0, 245, 212, 0.22), transparent 50%), radial-gradient(100% 80% at 85% 85%, rgba(143, 108, 255, 0.20), transparent 55%), linear-gradient(160deg, #071511 0%, #0a211b 45%, #07090d 100%)',
        dusk: 'radial-gradient(110% 85% at 80% 20%, rgba(244, 210, 138, 0.20), transparent 50%), radial-gradient(120% 90% at 15% 85%, rgba(143, 108, 255, 0.22), transparent 55%), linear-gradient(150deg, #150b22 0%, #221232 50%, #0c0713 100%)',
        mono: 'radial-gradient(100% 80% at 50% 10%, rgba(255, 255, 255, 0.09), transparent 55%), linear-gradient(165deg, #171a20 0%, #0e1014 55%, #08090b 100%)',
        mint: 'radial-gradient(120% 90% at 25% 20%, rgba(0, 245, 212, 0.26), transparent 52%), radial-gradient(90% 70% at 85% 90%, rgba(0, 160, 140, 0.20), transparent 58%), linear-gradient(160deg, #041210 0%, #07231d 50%, #050b0a 100%)',
        rose: 'radial-gradient(115% 85% at 75% 18%, rgba(255, 120, 160, 0.20), transparent 52%), radial-gradient(110% 85% at 15% 88%, rgba(255, 90, 120, 0.14), transparent 55%), linear-gradient(155deg, #1b0a12 0%, #2a1020 52%, #10060c 100%)',
        forest: 'radial-gradient(120% 90% at 22% 16%, rgba(60, 200, 120, 0.16), transparent 52%), radial-gradient(100% 80% at 88% 85%, rgba(20, 120, 80, 0.18), transparent 56%), linear-gradient(160deg, #071209 0%, #0c2013 50%, #060a07 100%)',
        graphite: 'radial-gradient(110% 85% at 70% 15%, rgba(90, 140, 255, 0.16), transparent 52%), radial-gradient(100% 80% at 20% 88%, rgba(70, 100, 180, 0.14), transparent 55%), linear-gradient(160deg, #0c0f16 0%, #11141d 52%, #07080d 100%)',
        violet: 'radial-gradient(120% 90% at 30% 15%, rgba(143, 108, 255, 0.24), transparent 52%), radial-gradient(100% 80% at 85% 88%, rgba(210, 120, 255, 0.16), transparent 55%), linear-gradient(155deg, #0e0718 0%, #1a0f2e 50%, #0a0612 100%)',
        ocean: 'radial-gradient(120% 90% at 18% 18%, rgba(56, 189, 248, 0.24), transparent 52%), radial-gradient(105% 85% at 88% 82%, rgba(14, 116, 144, 0.26), transparent 58%), linear-gradient(155deg, #04101f 0%, #07233c 52%, #030810 100%)',
        cosmos: 'radial-gradient(120% 90% at 70% 12%, rgba(129, 140, 248, 0.22), transparent 50%), radial-gradient(110% 85% at 15% 88%, rgba(217, 70, 239, 0.16), transparent 55%), linear-gradient(160deg, #0b0716 0%, #180d2c 50%, #07040f 100%)',
        ember: 'radial-gradient(115% 85% at 80% 20%, rgba(251, 146, 60, 0.20), transparent 52%), radial-gradient(110% 85% at 18% 88%, rgba(244, 63, 94, 0.16), transparent 55%), linear-gradient(155deg, #1a0b06 0%, #2a120a 52%, #0f0504 100%)',
        jade: 'radial-gradient(120% 90% at 25% 18%, rgba(52, 211, 153, 0.18), transparent 52%), radial-gradient(100% 80% at 85% 85%, rgba(16, 185, 129, 0.15), transparent 56%), linear-gradient(160deg, #05140f 0%, #0a241c 50%, #040b09 100%)'
      }[preset];
      el.style.background = grad || '';
      // 渐变预设保留动态舞台（canvas 透明区域透出渐变），仅图片/视频背景隐藏舞台
      document.body.classList.remove('user-bg');
      document.body.classList.toggle('bg-grad', !!grad);
    } else {
      el.style.background = '';
      document.body.classList.remove('user-bg');
      document.body.classList.remove('bg-grad');
    }
    // 主题跟随主页背景：背景变化即刷新主题色相（图片→背景取色 / 预设渐变→固定色相；
    // 无自定义背景→封面取色兜底）。boot 阶段 theme 尚未创建，optional chaining 跳过
    this.theme?.applyFromTrack(this.engine.current);
  }

  /** 清除自定义图片/视频背景（切场景时调用，让动态舞台可见） */
  clearCustomBg() {
    const el = document.getElementById('userBg');
    el?.querySelector('video')?.remove();
    this.settings.bg = null;
    this.settings.bgVideo = null;
    window.api.setSetting('bg', null);
    window.api.setSetting('bgVideo', null);
    this.applyBg();
  }

  saveSettings() {
    const localPaths = this.engine.queue.filter(t => t.source === 'local').map(t => t.path);
    window.api.setSetting('localPaths', localPaths);
    window.api.setSetting('volume', this.engine.audio.volume);
    window.api.setSetting('scene', this.scenes.current);
    window.api.setSetting('lyricStyle', this.lyricStyle);
    window.api.setSetting('shuffle', this.engine.shuffle);
    window.api.setSetting('playMode', this.engine.playMode);
  }

  /* ---------- 导入本地 ---------- */
  async importPaths(paths, playFirst = false) {
    const tracks = [];
    for (const p of paths) {
      if (!AUDIO_EXT.test(p) || this.engine.queue.some(t => t.path === p)) continue;
      try {
        const meta = await window.api.parseMeta(p);
        const t = makeTrack({
          source: 'local', path: p,
          title: meta.title, artist: meta.artist, album: meta.album, duration: meta.duration || 0
        });
        if (meta.picture?.data) {
          t.coverBlob = URL.createObjectURL(new Blob([meta.picture.data], { type: meta.picture.format }));
        }
        tracks.push(t);
      } catch { /* 跳过损坏文件 */ }
    }
    if (!tracks.length) return;
    this.engine.addTracks(tracks, playFirst);
    if (!playFirst) toast(`已添加 ${tracks.length} 首歌曲`);
    this.saveSettings();
  }

  /* ---------- 在线播放 ---------- */
  async playOnline(song) {
    const t = makeTrack({
      source: 'online', songId: song.id, srcId: song.srcId || null,
      title: song.name, artist: song.artist, album: song.album,
      duration: song.duration > 10000 ? song.duration / 1000 : (song.duration || 0),
      coverUrl: song.coverUrl || null
    });
    this.engine.addTracks([t], true);
    this.toggleNp(true); // 任何页面点击歌曲/封面 → 直接进入歌词播放页
    toast(`正在播放：${song.name}`);
    // 记录最近播放
    try {
      const hist = (this.settings.onlineHistory || []).filter(x => !(x.id === song.id && x.srcId === song.srcId));
      hist.unshift({ id: song.id, name: song.name, artist: song.artist, album: song.album, coverUrl: song.coverUrl, duration: song.duration, srcId: song.srcId || null, srcName: song.srcName || null });
      this.settings.onlineHistory = hist.slice(0, 30);
      window.api.setSetting('onlineHistory', this.settings.onlineHistory);
    } catch { /* 忽略 */ }
  }

  /* ---------- 在线歌单批量播放 ----------
     startIndex：从歌单中第几首开始播（默认 0）。只触发一次 playIndex，
     避免 addTracks(true) 播第 0 首后再 playIndex(i) 的并发加载竞态（点歌错位） */
  playOnlineAll(songs, startIndex = 0) {
    if (!songs?.length) return;
    const tracks = songs.map(s => makeTrack({
      source: 'online', songId: s.id, srcId: s.srcId || null,
      title: s.name, artist: s.artist, album: s.album,
      duration: s.duration > 10000 ? s.duration / 1000 : (s.duration || 0),
      coverUrl: s.coverUrl || null
    }));
    this.engine.addTracks(tracks, false);
    const begin = this.engine.queue.length - tracks.length;
    this.engine.playIndex(begin + Math.max(0, Math.min(startIndex, tracks.length - 1)));
    toast(`已加入 ${tracks.length} 首 · 开始播放`);
    try {
      const ids = new Set(songs.map(s => s.id));
      const hist = (this.settings.onlineHistory || []).filter(x => !ids.has(x.id));
      for (const s of [...songs].reverse()) {
        hist.unshift({ id: s.id, name: s.name, artist: s.artist, album: s.album, coverUrl: s.coverUrl, duration: s.duration });
      }
      this.settings.onlineHistory = hist.slice(0, 30);
      window.api.setSetting('onlineHistory', this.settings.onlineHistory);
    } catch { /* 忽略 */ }
  }

  /* ---------- 演示曲 ---------- */
  async applyDemoTrack() {
    if (this.engine.current?.source === 'demo') return;
    // 移除旧演示曲，保持队列整洁
    for (let i = this.engine.queue.length - 1; i >= 0; i--) {
      if (this.engine.queue[i].source === 'demo') {
        this.engine.queue.splice(i, 1);
        if (i < this.engine.index) this.engine.index--;
      }
    }
    const demo = makeTrack({ source: 'demo', title: 'Neon Drift (演示曲)', artist: 'RhythmViz 内置合成' });
    this.engine.queue.unshift(demo);
    this.engine.index = 0; // 当前曲目指向演示曲，⏯ 可暂停/恢复
    this.engine.dispatchEvent(new CustomEvent('queue'));
    this.engine.dispatchEvent(new CustomEvent('track'));
    this.scenes.setCoverFromTrack(null);
    this.setLyric('', null, true); // 演示曲为合成纯音乐
  }

  /* ---------- 歌词 ---------- */
  setLyric(text, trans, pure) {
    if (text) this.lyrics.setLyric(text, trans);
    else this.lyrics.clear(pure === true); // 仅接口明确纯音乐才显示「纯音乐，请欣赏」；否则恢复默认提示
  }

  /* ---------- 视频动态背景（本地循环视频，静音） ---------- */
  applyVideoBg(src) {
    const el = document.getElementById('userBg');
    if (!el) return;
    if (!src) {
      el.querySelector('video')?.remove();
      if (!this.settings.bg && !this.settings.bgPreset) document.body.classList.remove('user-bg');
      return;
    }
    let v = el.querySelector('video');
    if (!v) {
      v = document.createElement('video');
      v.muted = true; v.loop = true; v.autoplay = true; v.playsInline = true;
      el.appendChild(v);
    }
    v.src = src;
    v.play().catch(() => {});
    el.style.background = '';
    document.body.classList.remove('bg-grad');
    document.body.classList.add('user-bg');
    this.settings.bg = null;
    this.settings.bgPreset = null;
    window.api.setSetting('bg', null);
    window.api.setSetting('bgPreset', null);
    window.api.setSetting('bgVideo', src);
    this.settings.bgVideo = src;
  }

  /* ---------- 播放页（大封面 + 沉浸歌词） ---------- */
  toggleNp(force) {
    const np = document.getElementById('np');
    const open = force != null ? force : !np.classList.contains('open');
    np.classList.toggle('open', open);
    np.classList.toggle('hidden', !open);
    document.body.classList.toggle('np-open', open);
    this.npOpen = open;
    if (open) {
      document.getElementById('fxPanel')?.classList.remove('open');
      document.getElementById('drawer')?.classList.remove('open');
      document.body.classList.remove('home-active');
      document.body.classList.remove('focus-mode');
    }
  }

  /* ---------- 全屏歌词：隐藏所有 UI，只留歌词 + 背景，ESC 退出 ---------- */
  toggleFullLyric(force) {
    const on = force != null ? force : !document.body.classList.contains('full-lyric');
    document.body.classList.toggle('full-lyric', on);
    if (on) {
      this.dismissSplash();
      document.body.classList.remove('home-active', 'focus-mode');
      if (!this.npOpen && this.engine.current) this.toggleNp(true);
    } else {
      document.body.classList.remove('np-open');
    }
  }

  /* ---------- 专注模式：一键隐藏全部 UI，只留可视化+歌词，点击鼠标或按任意键退出 ---------- */
  toggleFocus() {
    const on = !document.body.classList.contains('focus-mode');
    document.body.classList.toggle('focus-mode', on);
    if (on) {
      document.body.classList.remove('show-chrome');
      document.getElementById('fxPanel')?.classList.remove('open');
      document.getElementById('drawer')?.classList.remove('open');
      // 窗口级全屏覆盖系统任务栏（Electron 全屏会隐藏任务栏）
      if (window.api?.setFullscreen) window.api.setFullscreen(true);
      else document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      if (window.api?.setFullscreen) window.api.setFullscreen(false);
      else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    }
  }

  /* ---------- 拖放导入 ---------- */
  setupDragDrop() {
    let depth = 0;
    const hint = document.getElementById('dropHint');
    window.addEventListener('dragenter', (e) => {
      e.preventDefault();
      if (e.dataTransfer?.types?.includes('Files')) {
        depth++;
        hint.classList.remove('hidden');
      }
    });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('dragleave', () => {
      if (--depth <= 0) { depth = 0; hint.classList.add('hidden'); }
    });
    window.addEventListener('drop', async (e) => {
      e.preventDefault();
      depth = 0;
      hint.classList.add('hidden');
      const files = [...(e.dataTransfer?.files || [])];
      const paths = files.map(f => {
        try { return window.api.getPathForFile(f); } catch { return f.path || null; }
      }).filter(p => p && AUDIO_EXT.test(p));
      if (paths.length) await this.importPaths(paths, !this.engine.current);
      else toast('请拖入音频文件（mp3 / flac / m4a…）');
    });
  }

  /* ---------- 键盘 ---------- */
  setupKeys() {
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT') return;
      switch (e.key) {
        case ' ': e.preventDefault(); this.engine.playPause(); break;
        case 'ArrowRight': this.engine.seek(this.engine.time + 5); break;
        case 'ArrowLeft': this.engine.seek(this.engine.time - 5); break;
        case 'ArrowUp': e.preventDefault(); this.engine.setVolume(this.engine.audio.volume + 0.05); break;
        case 'ArrowDown': e.preventDefault(); this.engine.setVolume(this.engine.audio.volume - 0.05); break;
        case 'l': case 'L': this.toggleNp(); break;
        case 'f': case 'F':
          if (document.fullscreenElement) document.exitFullscreen();
          else document.documentElement.requestFullscreen().catch(() => {});
          break;
        case 'Escape':
          if (document.body.classList.contains('full-lyric')) { this.toggleFullLyric(false); break; }
          if (document.body.classList.contains('focus-mode')) { this.toggleFocus(); break; }
          if (this.npOpen) this.toggleNp(false);
          break;
      }
    });
  }

  /* ---------- Chrome 自动隐藏 ---------- */
  setupChromeAutohide() {
    const isOverUI = () => !!document.querySelector('#bottombar:hover, #drawer.open:hover, #fxPanel.open:hover');
    const show = (e) => {
      document.body.classList.add('show-chrome');
      clearTimeout(this._chromeTimer);
      this._chromeTimer = setTimeout(() => {
        if (this._shotMode) return; // 截图模式保持常显
        if (!document.querySelector('#drawer.open') && !isOverUI()) {
          document.body.classList.remove('show-chrome');
        }
      }, 3000);
    };
    window.addEventListener('mousemove', show);
    show();
  }

  /* ---------- 专注模式退出：点击鼠标或按任意键（非 Escape 原有逻辑） ---------- */
  setupFocusExit() {
    const exit = () => {
      if (document.body.classList.contains('focus-mode')) this.toggleFocus();
    };
    window.addEventListener('pointerdown', exit, true);
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') exit();
    }, true);
  }

  /* ---------- 自动化测试 ---------- */
  async runAutotest() {
    try {
      await this.engine.playDemo();
      await this.applyDemoTrack();
      let beats = 0;
      this.engine.addEventListener('beat', () => beats++);
      let n = 0;
      const iv = setInterval(() => {
        n++;
        const b = this.engine.bands;
        console.log(`AUTOTEST_ENERGY ${n} level=${b.level.toFixed(3)} bass=${b.bass.toFixed(3)} mid=${b.mid.toFixed(3)} treble=${b.treble.toFixed(3)} beats=${beats}`);
        if (n >= 16) {
          clearInterval(iv);
          console.log(`AUTOTEST_DONE level=${b.level.toFixed(3)} beats=${beats}`);
        }
      }, 300);
    } catch (e) {
      console.error('AUTOTEST_FAIL', e);
    }
  }
}

const app = new App();
// 移动端桥接层（mobile/src/bridge.js）需要复用播放/队列能力；桌面端无影响
try { window.__app = app; } catch { /* noop */ }
window.addEventListener('error', (e) => console.error('WIN_ERR', e.message));
window.addEventListener('unhandledrejection', (e) => console.error('WIN_REJ', String(e.reason)));
app.boot();

/* ============ 可视化场景：封面粒子 / 频谱反应堆 / 星河 / 唱片 ============ */

import { clamp, lerp } from './audio.js';

const TAU = Math.PI * 2;

class Scene {
  constructor(mgr) { this.mgr = mgr; }
  resize() {}
  setCover() {}
  frame() {}
}

/* =====================================================================
   可视化场景（Wallpaper Engine 顶级音乐节奏壁纸质量）
   12 个场景：封面粒子 / 圆环频谱 / 反应堆 / 能量核心 /
   CD弹出 / 粒子流场 / 粒子碰撞 / 黑胶唱片 / 声波涟漪 / 粒子能量场 / 镜像波形（另有歌词动画特殊场景）
   ===================================================================== */

/* ---------- 场景一：封面粒子（Three.js 真 3D 粒子云：封面像素采样 → 球面/云团，
   鼠标拖拽全方位旋转（手写 theta/phi + 惯性阻尼，不引 OrbitControls）+ 自动缓慢自转（可关）；
   bass 驱动粒子云轻微膨胀 / 鼓点亮度脉冲；无封面时按默认色相生成粒子不空白。
   渲染架构与 ReactorScene 同款：惰性 import three → 独立离屏 WebGLRenderer → 每帧 drawImage 合成回 2D 主画布；
   背景/星尘/节拍柔光仍为 2D 层） ---------- */
class CoverParticles extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0;
    this._bassSm = 0;              // 低频平滑（粒子云膨胀用）
    this.dust = Array.from({ length: 60 }, () => ({
      x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7,
      ph: Math.random() * TAU, sp: 0.15 + Math.random() * 0.4
    }));
    // 封面像素采样表：{ r,g,b,u,v }（u/v 为封面归一化坐标 → 平面粒子位置）
    this.samples = [];
    this.hasCover = false;
    this._img = null;
    this._pal = null;
    this._sampleCv = null;         // 封面缩采样布（64×64，setCover 时复用）
    // 平面粒子基准数据：_base 基准坐标（z 随节奏改写）、_uArr 横向坐标（映射频谱柱）、_phArr 随机相位（鼓点跳动差异）
    this._base = null; this._uArr = null; this._phArr = null;
    this._spec = new Float32Array(96); // 频谱平滑（攻击快衰减慢）
    // 旋转状态：拖拽手写 theta/phi + 惯性速度（松手后阻尼衰减）
    this.theta = 0;
    this.phi = -0.12;
    this.vTheta = 0; this.vPhi = 0;
    this._userTheta = 0;           // 用户/惯性确定的偏转角（自动摇摆在此基础上叠加）
    this._sway = 0;                // 自动摇摆相位（小幅来回，保证封面始终可辨）
    this._swayAmp = 0;             // 摇摆幅度（拖拽时渐隐防跳变）
    this._drag = null;             // { id, x, y }
    this._bound = false;           // 舞台指针事件只绑一次
    this._builtCount = 0;          // 当前 geometry 粒子数（数量设置变化 → 重建）
    // Three.js 渲染上下文（惰性初始化：首次 frame 动态 import three，失败则降级为纯 2D 背景）
    this._r3 = null;
    this._r3Dead = false;
    this._r3Loading = null;
    this._THREE = null;
  }
  /* 采样封面像素：缩到 64×64 读 RGBA → 采样表（经纬度 + 像素色）；无封面/跨域失败按默认色相随机兜底 */
  setCover(img, pal) {
    this._img = img;
    this._pal = pal;
    this.hasCover = !!(img && img.width);
    const N = 64;
    const hue = pal?.hue ?? this.mgr.pal.hue ?? 210;
    const out = [];
    if (this.hasCover) {
      if (!this._sampleCv) this._sampleCv = document.createElement('canvas');
      this._sampleCv.width = N; this._sampleCv.height = N;
      const c2 = this._sampleCv.getContext('2d', { willReadFrequently: true });
      try {
        c2.drawImage(img, 0, 0, N, N);
        const data = c2.getImageData(0, 0, N, N).data;
        for (let gy = 0; gy < N; gy++) {
          for (let gx = 0; gx < N; gx++) {
            const i4 = (gy * N + gx) * 4;
            out.push({ r: data[i4], g: data[i4 + 1], b: data[i4 + 2], u: (gx + 0.5) / N, v: (gy + 0.5) / N });
          }
        }
      } catch { /* 跨域读像素失败 → 走默认色相兜底 */ }
    }
    if (!out.length) {
      for (let i = 0; i < 512; i++) {
        const H = hue + (Math.random() - 0.5) * 50;
        const c = hslToRgb(H, 0.55, 0.3 + Math.random() * 0.35);
        out.push({ r: c[0], g: c[1], b: c[2], u: Math.random(), v: Math.random() });
      }
    }
    this.samples = out;
    if (this._r3) this._rebuildPoints(); // three 已就绪 → 立即按新采样重建粒子
  }
  resize() { if (this._r3) this._resize3(this.mgr.w, this.mgr.h); }
  /* Three.js 上下文（首次 frame 动态 import three，与 ReactorScene / JIZURA 同款按需加载策略） */
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('CoverParticles: three 加载失败，封面粒子降级为纯 2D 背景。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;   // 加载完成前为 null → 本帧跳过 3D 层
  }
  _init3() {
    const T = this._THREE;
    const w = this.mgr.w || 640, h = this.mgr.h || 360;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);        // 只改缓冲尺寸（canvas 不入 DOM，无需写 style）
    renderer.setClearColor(0x000000, 0);  // 透明清屏 → 2D 背景/星尘从粒子云四周透出
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(45, w / h, 0.05, 30);
    camera.position.set(0, 0, 2.9);
    camera.lookAt(0, 0, 0);
    const group = new T.Group();          // 粒子云容器：拖拽/自转/缩放全部作用在 group 上
    scene.add(group);
    const mat = new T.PointsMaterial({
      size: 0.022, sizeAttenuation: true, vertexColors: true,
      transparent: true, opacity: 0.9, depthWrite: false,
      blending: T.AdditiveBlending        // 加色混合 → 粒子交叠处自然发光
    });
    this._r3 = { renderer, scene, camera, group, mat, points: null };
    this._rebuildPoints();
  }
  /* 构建粒子云 geometry：采样表 → 【平面布局】（封面 u/v 直接映射到 XY 平面，正视即完整封面图像，
     粒子色 = 像素色（线性空间）；z 给微小厚度抖动，节奏跳动在 frame 中逐帧改写 z） */
  _rebuildPoints() {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    if (r3.points) { r3.group.remove(r3.points); r3.points.geometry.dispose(); r3.points = null; }
    const cfg = this.mgr.coverCfg || {};
    const count = Math.round(clamp(cfg.count == null ? 1000 : +cfg.count, 300, 99999)); // 上限 99999（Three.js Points 十万级无压力）
    const S = this.samples;
    const PLANE = 2.2;                       // 平面边长（相机 z=2.9 / fov45 可视高 ≈2.40，留边距）
    const pos = new Float32Array(count * 3);
    const col = new Float32Array(count * 3);
    const uArr = new Float32Array(count);
    const vArr = new Float32Array(count);
    const phArr = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const s = S[i % S.length];
      // 采样点重复使用时加位置抖动（约 1 像素级），让重复粒子填满像素间隙 → 图像连贯
      const ju = i < S.length ? 0 : (Math.random() - 0.5) * 0.016;
      const jv = i < S.length ? 0 : (Math.random() - 0.5) * 0.016;
      const u = s.u + ju, v = s.v + jv;
      pos[i * 3] = (u - 0.5) * PLANE;        // x：左 → 右
      pos[i * 3 + 1] = (0.5 - v) * PLANE;    // y：上 → 下（v 向下为正 → 翻转）
      pos[i * 3 + 2] = (Math.random() - 0.5) * 0.05;  // z：微厚度（节奏位移的基准噪声）
      uArr[i] = clamp(u, 0, 0.999);
      vArr[i] = clamp(v, 0, 0.999);
      phArr[i] = Math.random();
      col[i * 3] = sLin(s.r); col[i * 3 + 1] = sLin(s.g); col[i * 3 + 2] = sLin(s.b);
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('color', new T.BufferAttribute(col, 3));
    const points = new T.Points(geo, r3.mat);
    points.frustumCulled = false;
    r3.points = points;
    r3.group.add(points);
    this._base = pos.slice();                // 基准坐标副本（frame 按节奏改写 z 后以此复位）
    this._uArr = uArr; this._vArr = vArr; this._phArr = phArr;
    this._builtCount = count;
  }
  _resize3(w, h) {
    const r3 = this._r3;
    r3.renderer.setSize(w, h, false);
    r3.camera.aspect = w / h;
    r3.camera.updateProjectionMatrix();
  }
  /* 资源释放（当前 SceneManager 无场景销毁流程，留作安全接口，与 ReactorScene 同标准） */
  dispose() {
    const r3 = this._r3;
    if (!r3) return;
    if (r3.points) { r3.group.remove(r3.points); r3.points.geometry.dispose(); }
    r3.mat.dispose();
    r3.renderer.dispose();
    this._r3 = null;
  }
  /* 舞台拖拽旋转：pointer 捕获，增量映射到 theta/phi（惯性速度随拖拽更新，松手后阻尼衰减）；
     仅封面粒子场景为当前场景时响应，不影响其他场景 */
  _bindPointer() {
    if (this._bound) return;
    this._bound = true;
    const cv = this.mgr.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (this.mgr.current !== 'cover') return;
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.vTheta = 0; this.vPhi = 0; // 重新按下 → 清空上一段惯性
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      const dT = dx * 0.005, dP = dy * 0.005;
      this.theta += dT;
      this.phi = clamp(this.phi + dP, -1.25, 1.25); // 俯仰限位防翻转
      this._userTheta = this.theta;                  // 拖拽角即新的基准角（松手后摇摆以此为中心）
      this.vTheta = dT; this.vPhi = dP;             // 记录松手惯性
    });
    const endDrag = (e) => {
      if (this._drag && e.pointerId === this._drag.id) this._drag = null;
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.02, dt);
    this._bassSm += ((bands.bass || 0) - this._bassSm) * Math.min(1, dt * 8);
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    // 背景：深色径向渐变（与粒子云同色系）
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, `hsla(${hue},45%,8%,1)`);
    bg.addColorStop(1, 'hsla(0,0%,2%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    // 漂浮星尘
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.dust) {
      d.ph += d.sp * dt;
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(d.ph));
      ctx.fillStyle = `hsla(${hue2},85%,82%,${tw * 0.28 * d.z})`;
      ctx.beginPath(); ctx.arc(d.x * w, d.y * h, 0.8 + d.z * 1.6, 0, TAU); ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
    // —— 3D 粒子云（three 惰性加载；旋转/缩放/亮度每帧按设置与音频更新）——
    this._bindPointer();
    const r3 = this._ensureThree();
    if (r3 && r3.points) {
      // —— 设置（视觉控制台实时写入 mgr.coverCfg）：缩放 / 数量 / 自转开关 / 速度 ——
      const cfg = this.mgr.coverCfg || {};
      const scale = clamp(cfg.scale == null ? 1 : +cfg.scale, 0.5, 2);
      const spin = cfg.spin !== false;
      const spd = clamp(cfg.spd == null ? 0.3 : +cfg.spd, 0, 1);
      const wantCount = Math.round(clamp(cfg.count == null ? 1000 : +cfg.count, 300, 99999));
      if (wantCount !== this._builtCount) this._rebuildPoints(); // 数量设置变化 → 重建 geometry
      // 旋转：拖拽中由指针直控；否则「基准角 ± 小幅摇摆」（封面始终正面可辨，不再整圈自转）+ 惯性阻尼
      if (!this._drag) {
        if (spin) this._sway += dt * (0.45 + spd * 1.1);
        this._userTheta += this.vTheta;
        this.phi = clamp(this.phi + this.vPhi, -1.25, 1.25);
        const damp = Math.pow(0.04, dt);
        this.vTheta *= damp; this.vPhi *= damp;
      }
      // 摇摆幅度：拖拽中渐隐到 0（防松手瞬间跳变），空闲渐显到 0.34rad（约 ±19°）
      this._swayAmp += ((this._drag || !spin ? 0 : 0.34) - this._swayAmp) * Math.min(1, dt * 3);
      this.theta = this._drag ? this.theta : this._userTheta + Math.sin(this._sway) * this._swayAmp;
      const grp = r3.group;
      grp.rotation.set(this.phi, this.theta, 0);
      // —— 节奏跳动：粒子 z 逐帧改写（平面保持可辨，所有粒子跟着音乐向镜头方向弹跳）——
      // 频谱平滑（攻击快衰减慢，与其他场景同参数）；u/v 混合映射频谱柱 + 逐粒子相位抖动
      // → 打破「同列共享 bin 一起动」的列动观感，跳动呈碎块波浪扩散
      const spec = this._spec;
      for (let i = 0; i < 96; i++) spec[i] += (bins[i] - spec[i]) * Math.min(1, dt * (bins[i] > spec[i] ? 18 : 8));
      const posA = r3.points.geometry.attributes.position;
      const arr = posA.array, base = this._base, uA = this._uArr, vA = this._vArr, phA = this._phArr;
      const beat = this._beat, bass = this._bassSm, cnt = this._builtCount;
      const specAmp = 0.42 * (0.35 + 0.65 * bass + 0.35);   // 频谱位移幅度（低频越强跳越高）
      const beatAmp = beat * 0.26;                            // 鼓点整体前冲（逐粒子随机差异）
      for (let i = 0; i < cnt; i++) {
        const ph = phA[i];
        // 柱索引：u/v 加权混合 + 相位抖动 ±7 柱 → 同列粒子落到不同频谱柱
        const bin = (((uA[i] * 0.55 + vA[i] * 0.45) * 96) + (ph - 0.5) * 14) | 0;
        const sp = spec[bin < 0 ? 0 : (bin > 95 ? 95 : bin)];
        // 幅度逐粒子差异（0.35~1.0），进一步打散同步感
        const amp = 0.35 + 0.65 * ((ph * 5.13) % 1);
        arr[i * 3 + 2] = base[i * 3 + 2]
          + sp * specAmp * amp
          + beatAmp * (0.3 + 0.7 * ph)
          + Math.sin(t * 2.1 + uA[i] * 8 + ph * 6.28) * 0.018   // 待机微波（无音乐时也缓慢起伏）
          + Math.sin(t * 3.3 + vA[i] * 11.0 + uA[i] * 4.0) * 0.03 * (0.3 + bass); // v 向第二微波，低频联动
      }
      posA.needsUpdate = true;
      // 节拍联动：bass 轻微膨胀 + 鼓点亮度/粒径脉冲
      const pulse = scale * (1 + this._bassSm * 0.08 + this._beat * 0.05);
      grp.scale.set(pulse, pulse, pulse);
      r3.mat.opacity = Math.min(1, 0.82 + this._bassSm * 0.12 + this._beat * 0.08);
      r3.mat.size = 0.024 * (1 + this._bassSm * 0.15);
      r3.renderer.render(r3.scene, r3.camera);
      // WebGL 画布合成回 2D 主画布（render 与 drawImage 同一同步任务，无需 preserveDrawingBuffer）
      ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
    }
    // 节拍全屏柔光脉冲
    if (this._beat > 0.12) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `hsla(${hue2},90%,72%,${this._beat * 0.07})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
}

/* ---------- 场景二：圆环频谱（双层环 + 节拍涟漪 + 封面核心） ---------- */
class RingSpectrumScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this.coverImg = null;
    this.smooth = new Float32Array(96);
    this.ripples = [];
    this.stars = Array.from({ length: 80 }, () => ({
      x: Math.random(), y: Math.random(), z: 0.2 + Math.random() * 0.8,
      ph: Math.random() * TAU, sp: 0.5 + Math.random() * 2
    }));
    this._beat = 0;
  }
  setCover(img) { this.coverImg = (img && img.width) ? img : null; }
  resize() {}
  frame(ctx, w, h, dt, t, bands, bins) {
    for (let i = 0; i < 96; i++) this.smooth[i] += (bins[i] - this.smooth[i]) * Math.min(1, dt * (bins[i] > this.smooth[i] ? 16 : 7));
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.02, dt);
    if (bands.beat) this.ripples.push({ r: 0, a: 1 });
    while (this.ripples.length > 6) this.ripples.shift();
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const cx = w / 2, cy = h / 2;
    const baseR = Math.max(40, Math.min(w, h) * 0.17);
    // 背景
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    bg.addColorStop(0, `hsla(${hue},50%,6%,1)`);
    bg.addColorStop(1, 'hsla(0,0%,1%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    // 星尘
    ctx.globalCompositeOperation = 'lighter';
    for (const s of this.stars) {
      s.ph += s.sp * dt;
      const tw = 0.25 + 0.75 * Math.abs(Math.sin(s.ph));
      ctx.fillStyle = `hsla(${hue2},80%,86%,${tw * 0.32 * s.z})`;
      ctx.beginPath(); ctx.arc(s.x * w, s.y * h, 0.7 + s.z * 1.2, 0, TAU); ctx.fill();
    }
    // 节拍涟漪环
    for (const r of this.ripples) {
      r.r += dt * 220; r.a *= Math.pow(0.06, dt);
      const rr = Math.max(1, baseR + r.r);
      ctx.strokeStyle = `hsla(${hue2},90%,72%,${r.a * 0.5})`;
      ctx.lineWidth = 2 + r.a * 4;
      ctx.beginPath(); ctx.arc(cx, cy, rr, 0, TAU); ctx.stroke();
    }
    // 双层圆环频谱（脉冲强度设置 mgr.ringCfg.pulse 50-200% 缩放节拍振幅）
    const N = 72;
    const pk = clamp((this.mgr.ringCfg && this.mgr.ringCfg.pulse) || 1, 0.5, 2);
    const scale = 1 + (bands.beatPulse * 0.06 + this._beat * 0.1) * pk;
    const R = baseR * scale;
    const barW = Math.max(1, (TAU * R / N) * 0.6);
    for (let i = 0; i < N; i++) {
      const ang = (i / N) * TAU - Math.PI / 2;
      const v = this.smooth[Math.floor(i / N * 96)] || 0;
      const len = Math.max(3, v * baseR * 0.95 + 5);
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const x1 = cx + ca * R, y1 = cy + sa * R;
      // 外环柱
      const x2 = cx + ca * (R + len), y2 = cy + sa * (R + len);
      const g = ctx.createLinearGradient(x1, y1, x2, y2);
      g.addColorStop(0, `hsla(${hue},80%,48%,0.85)`);
      g.addColorStop(1, `hsla(${hue2},95%,76%,1)`);
      ctx.strokeStyle = g; ctx.lineWidth = barW;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
      // 内环柱
      const xi = cx + ca * Math.max(0, R - len * 0.6), yi = cy + sa * Math.max(0, R - len * 0.6);
      const gi = ctx.createLinearGradient(x1, y1, xi, yi);
      gi.addColorStop(0, `hsla(${hue},70%,42%,0.6)`);
      gi.addColorStop(1, `hsla(${hue2},85%,68%,0.9)`);
      ctx.strokeStyle = gi; ctx.lineWidth = barW * 0.7;
      ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(xi, yi); ctx.stroke();
      // 顶端辉光
      ctx.fillStyle = `hsla(${hue2},100%,86%,${0.5 + v * 0.5})`;
      ctx.beginPath(); ctx.arc(x2, y2, 2 + v * 3, 0, TAU); ctx.fill();
    }
    // 中心封面 + 外发光（发光强度同样随脉冲强度设置缩放）
    const gl = ctx.createRadialGradient(cx, cy, R * 0.85, cx, cy, R * 1.9);
    gl.addColorStop(0, `hsla(${hue2},90%,60%,${Math.min(1, 0.3 + this._beat * 0.35 * pk)})`);
    gl.addColorStop(1, 'transparent');
    ctx.fillStyle = gl; ctx.beginPath(); ctx.arc(cx, cy, R * 1.9, 0, TAU); ctx.fill();
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
    if (this.coverImg) {
      const im = this.coverImg; const s = (R * 2) / Math.min(im.width, im.height);
      ctx.drawImage(im, cx - im.width * s / 2, cy - im.height * s / 2, im.width * s, im.height * s);
    } else {
      ctx.fillStyle = `hsl(${hue},55%,14%)`; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    }
    ctx.restore();
    // 节拍全屏泛光
    if (this._beat > 0.1) {
      ctx.fillStyle = `hsla(${hue2},90%,70%,${this._beat * 0.06})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ---------- 场景三：反应堆（Three.js 真 3D 音频地形，参照 sonic-topography：
   频谱 → 圆盘高度场 → InstancedMesh 方块阵列逐帧写 instanceMatrix/instanceColor；
   低频在盘心成片造山、鼓点砸下集体隆起，中高频驱动外圈细碎起伏；
   鼓点环形波 + 水滴波纹在高度场上荡开 · 流星 · 盘心辉光 · 空间歌词悬浮。
   3D 渲染到独立小画布，每帧 drawImage 合成回 2D 主画布；天空/流星/歌词仍为 2D 层） ---------- */
class ReactorScene extends Scene {
  constructor(mgr) {
    super(mgr);
    // 网格规模：G×G 方格按窗口宽度缩放（resize 时重建），裁剪成圆形盘
    this.G = 0;
    this.cells = [];                   // 盘内格子（静态属性预存，逐帧零对象分配）
    this.hCur = new Float32Array(0);   // 当前柱高（低通 + 扩散后）
    this.hTgt = new Float32Array(0);   // 目标柱高（音频直驱）
    this.hTmp = new Float32Array(0);   // 扩散交换缓冲（预分配，避免每帧分配）
    this.ripN = new Float32Array(0);   // 彩色涟漪强度累积（柱体染色）
    this.ripW = new Float32Array(0);   // 白色涟漪强度累积
    // 涟漪池：5 圈环形高度波（预分配循环使用）
    this.ripples = Array.from({ length: 5 }, () => ({ on: false, gx: 0, gz: 0, age: 0, str: 0, white: 0 }));
    this._ripIdx = 0;
    this._ripRad = new Float32Array(5);   // 每圈当前波半径（格）
    this._ripFade = new Float32Array(5);  // 每圈距离衰减
    this._ripWid = new Float32Array(5);   // 每圈波峰宽度
    // 水滴涟漪池：3 颗（随机间隔落滴 → 圆形波纹环，径向正弦 + 指数衰减包络，比鼓点波纹更慢更圆）
    this.drops = Array.from({ length: 3 }, () => ({ on: false, gx: 0, gz: 0, age: 0, str: 1 }));
    this._nextDrop = 1.5;                 // 下次落滴时刻（秒；间隔由设置 rplFreq 决定）
    // 流星池：4 颗（预分配，2D 层绘制在 3D 地形之前 → 高山可遮挡）
    this.meteors = Array.from({ length: 4 }, () => ({ on: false, x: 0, y: 0, vx: 0, vy: 0, life: 0, lifeMax: 1 }));
    // 运行状态
    this.smooth = new Float32Array(96);
    this._kick = 0;            // 底鼓包络（快攻慢放 → 山体集体冲高）
    this._beat = 0;
    this._bassSm = 0;          // 歌词呼吸用低频
    this._prevTre = 0;
    this._lastMeteor = -9;
    this._nextMeteor = 2.5;
    // 歌词过渡状态
    this._lIdx = -99;
    this._lT = 9;
    // 调色缓存（每帧算一次 RGB 基色；2D 渐变按需重建，避免每帧 createLinearGradient）
    this._skyKey = ''; this._sky = null; this._gnd = null; this._hz = null;
    this._cFog = new Float32Array(3);
    this._cGlow = new Float32Array(3); this._cGlowHi = new Float32Array(3);
    this._cRip = new Float32Array(3);
    // 线性空间版基色（three 的 instanceColor / 雾 / 精灵色按线性解析）
    this._linFog = new Float32Array(3); this._linGlow = new Float32Array(3);
    this._linGlowHi = new Float32Array(3); this._linRip = new Float32Array(3);
    // Three.js 渲染上下文（惰性初始化：首次 frame 动态 import three，失败则降级为无地形）
    this._r3 = null;
    this._r3Dead = false;    // WebGL / three 加载失败标记（不再重试）
    this._r3Loading = null;
    this._THREE = null;
    this._projV = null;      // 地平线投影用向量（r3 就绪后创建）
    // 拖拽旋转状态（全方位旋转：手写 theta/phi + 惯性阻尼，模式照抄 CoverParticles._bindPointer）
    this.theta = 0;                  // 方位角偏移（拖拽/自转累积）
    this.phiD = 0;                   // 俯仰角偏移（叠加在「倾斜角度」默认俯仰之上）
    this.vTheta = 0; this.vPhi = 0;  // 松手惯性速度
    this._drag = null;               // { id, x, y }
    this._bound = false;             // 舞台指针事件只绑一次
    // 逐柱色相缓存：per-cell 冷/暖/高亮三组线性 RGB（hue 变化时重烘焙，每帧零分配）
    this._hueKey = '';
    this.cCool = new Float32Array(0);
    this.cWarm = new Float32Array(0);
    this.cHi = new Float32Array(0);
  }
  /* 保留接口；本场景配色全部来自 pal.hue/hue2（封面取色），不使用封面图 */
  setCover() {}
  resize() {
    this._skyKey = '';
    this._syncGrid();                      // 网格密度由设置决定（cfg.grid，32-72）
    if (this._r3) this._resize3(this.mgr.w, this.mgr.h);
  }
  /* 网格密度校准：设置「网格密度」变化 → 重建高度场与实例网格（每帧/resize 均调用，内部变更检测常态零开销） */
  _syncGrid() {
    const cfg = this.mgr.reactorCfg || {};
    const G = Math.round(clamp(cfg.grid == null ? 96 : +cfg.grid, 32, 128)); // 上限 128²=16384 实例；默认 96×96
    if (G !== this.G) {
      this.G = G;
      this._buildGrid();
      this._hueKey = '';                   // cells 重建 → 逐柱色相缓存待重烘焙
      if (this._r3) this._rebuildMesh();   // 格距随 G 变化 → 重建实例网格
    }
  }
  _rand(n) { const s = Math.sin(n) * 43758.5453; return s - Math.floor(s); }
  /* 构建圆盘格子：世界坐标 / 圆盘遮罩 / 频谱 bin / 地形分区权重 一次算好存进 cells */
  _buildGrid() {
    const G = this.G, N = G * G;
    this.hCur = new Float32Array(N); this.hTgt = new Float32Array(N);
    this.hTmp = new Float32Array(N);
    this.ripN = new Float32Array(N); this.ripW = new Float32Array(N);
    const cells = [];
    for (let gz = 0; gz < G; gz++) {
      const wz = ((gz + 0.5) / G) * 2 - 1;
      for (let gx = 0; gx < G; gx++) {
        const wx = ((gx + 0.5) / G) * 2 - 1;
        const r = Math.sqrt(wx * wx + wz * wz);
        // 圆盘遮罩：0.72 起渐隐、≥1 盘外无柱（smoothstep 渐隐到盘缘归零）
        const u = Math.min(1, Math.max(0, (r - 0.72) / 0.28));
        const mask = 1 - u * u * (3 - 2 * u);
        if (mask < 0.02) continue;
        const r1 = this._rand(gx * 12.9898 + gz * 78.233 + 7.13);
        const r2 = this._rand(gx * 78.233 + gz * 12.9898 + 3.7);
        // 低频平滑色相噪声：三组低频 sin 混合 → 相邻柱色相接近不突兀（归一到 ±1 后展开 ±22°）
        const hn = (Math.sin(wx * 2.3 + wz * 1.7) + Math.sin(wx * 1.2 - wz * 2.6 + 1.3) * 0.75
          + Math.sin((wx + wz) * 0.8 + 4.2) * 0.55) / 2.3;
        cells.push({
          gi: gz * G + gx, gx, gz, wx, wz, mask, rad: r,
          hueOff: hn * 14 + (r1 - 0.5) * 46,                        // 逐柱色相差（度）：低频缓变打底 + 逐柱随机抖动 → 相邻柱明显区分（旧版纯低频，邻柱几乎同色）
          bin: Math.min(95, Math.floor(Math.pow(r, 1.15) * 94)),  // 半径 → 频谱 bin（盘心低频、外圈高频）
          rndPh: r1 * TAU * 3 + r2 * 7.0,                      // 随机跳动相位（每柱独立，跟随音乐能量脉动）
          rndSp: 1.5 + r1 * 4.5,                                // 随机跳动频率（每柱不同，制造错落感）
          gateB: r1,                                              // >0.25 的格子参与低频山体
          gateT: r2 > 0.72 ? 0.45 + (r2 - 0.72) * 1.6 : 0,        // 约 28% 格子响应高频尖刺
          cBass: Math.exp(-(r * r) / 0.30),                       // 盘心低频权重（成片山峰）
          cMid: Math.exp(-((r - 0.58) * (r - 0.58)) / 0.10),      // 中频环带权重
          cOut: Math.min(1, Math.max(0, (r - 0.28) / 0.62))       // 外圈高频权重
        });
      }
    }
    this.cells = cells;
    // 逐柱色相缓存（per-cell 冷/暖/高亮三组线性 RGB，_palette 内按 hueKey 变化重烘焙）
    const M = cells.length;
    this.cCool = new Float32Array(M * 3);
    this.cWarm = new Float32Array(M * 3);
    this.cHi = new Float32Array(M * 3);
  }
  /* Three.js 上下文（首次 frame 动态 import three，与 JIZURA 引擎同款按需加载策略） */
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('ReactorScene: three 加载失败，3D 地形降级为无地形。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;   // 加载完成前为 null → 本帧跳过 3D 层
  }
  _init3() {
    const T = this._THREE;
    const w = this.mgr.w || 640, h = this.mgr.h || 360;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);        // 只改缓冲尺寸（canvas 不入 DOM，无需写 style）
    renderer.setClearColor(0x000000, 0);  // 透明清屏 → 2D 天空/地面渐变从地形四周透出
    const scene = new T.Scene();
    scene.fog = new T.Fog(0x101018, 2.0, 4.6);   // 雾色每帧随取色更新 → 远缘沉入天际
    const camera = new T.PerspectiveCamera(40, w / h, 0.05, 30);
    const amb = new T.AmbientLight(0xffffff, 0.7); scene.add(amb);
    const sun = new T.DirectionalLight(0xffffff, 2.15);  // 固定主光：方块顶/侧面明暗分离，金属高光带
    sun.position.set(0.55, 1.5, 0.75);
    scene.add(sun);
    const fill = new T.DirectionalLight(0xffffff, 0.5); // 副光（对侧低位）：与主光/相机方位共同作用，
    fill.position.set(-0.9, 0.5, -0.65);                 // 柱面高光随视角流动（光泽反射的可行近似，不引 envMap）
    scene.add(fill);
    // 盘心辉光精灵（径向渐变纹理，additive 叠加，随 bass/kick 呼吸）
    const glow = new T.Sprite(new T.SpriteMaterial({
      map: new T.CanvasTexture(this._glowTexture()),
      transparent: true, opacity: 0.12, depthWrite: false, depthTest: false,
      blending: T.AdditiveBlending
    }));
    glow.position.set(0, 0.32, 0);
    glow.scale.set(1.3, 1.3, 1);
    glow.renderOrder = 10;
    scene.add(glow);
    // 金属质感：Phong 高光（specular 近白 + shininess 收紧光斑）；逐实例颜色走 instanceColor（乘进漫反射，高光保持近白）
    // metal 配置实时调节：specular 亮度 + shininess + 环境光占比 → 从哑光到镜面金属连续过渡
    const mat = new T.MeshPhongMaterial({ color: 0xffffff, specular: 0xcfd4e2, shininess: 110 });
    this._r3 = {
      renderer, scene, camera, glow, amb, sun, fill, mat, mesh: null
    };
    this._rebuildMesh();
  }
  /* 盘心辉光纹理（一次性生成 128×128 径向渐变） */
  _glowTexture() {
    const cv = document.createElement('canvas'); cv.width = cv.height = 128;
    const c = cv.getContext('2d');
    const g = c.createRadialGradient(64, 64, 0, 64, 64, 64);
    g.addColorStop(0, 'rgba(255,255,255,0.9)');
    g.addColorStop(0.25, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = g; c.fillRect(0, 0, 128, 128);
    return cv;
  }
  /* 构建实例网格：BoxGeometry 方块阵列（矩阵模板一次写好，逐帧只改 Y 缩放与高度） */
  _rebuildMesh() {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    if (r3.mesh) { r3.scene.remove(r3.mesh); r3.mesh.geometry.dispose(); r3.mesh = null; }
    const cells = this.cells;
    const cell = (2 / this.G) * 0.92;   // 方块边长（格距的 92%，留缝 → 单柱立体的网格感）
    const geo = new T.BoxGeometry(cell, 1, cell);
    const mesh = new T.InstancedMesh(geo, r3.mat, cells.length);
    mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
    mesh.frustumCulled = false;         // 高度逐帧变化，跳过包围盒剔除
    const m = mesh.instanceMatrix.array;
    for (let i = 0; i < cells.length; i++) {
      const o = i * 16;
      m[o] = 1; m[o + 5] = 1; m[o + 10] = 1; m[o + 15] = 1;   // 单位旋转（尺寸已建进几何体）
      m[o + 12] = cells[i].wx; m[o + 14] = cells[i].wz;       // XZ 落位固定，逐帧只改高度
    }
    mesh.instanceColor = new T.InstancedBufferAttribute(new Float32Array(cells.length * 3), 3);
    mesh.instanceColor.setUsage(T.DynamicDrawUsage);
    r3.mesh = mesh;
    r3.scene.add(mesh);
  }
  _resize3(w, h) {
    const r3 = this._r3;
    r3.renderer.setSize(w, h, false);
    r3.camera.aspect = w / h;
    r3.camera.updateProjectionMatrix();
  }
  /* 资源释放（当前 SceneManager 无场景销毁流程，留作安全接口） */
  dispose() {
    const r3 = this._r3;
    if (!r3) return;
    if (r3.mesh) { r3.scene.remove(r3.mesh); r3.mesh.geometry.dispose(); }
    r3.mat.dispose();
    r3.glow.material.map.dispose();
    r3.glow.material.dispose();
    r3.renderer.dispose();
    this._r3 = null;
  }
  /* 舞台拖拽旋转地形：pointer 捕获，增量映射到 theta/phi 偏移（惯性速度随拖拽更新，松手后阻尼衰减）；
     模式照抄 CoverParticles._bindPointer；仅反应堆为当前场景时响应，与封面粒子的拖拽绑定互不干扰 */
  _bindPointer() {
    if (this._bound) return;
    this._bound = true;
    const cv = this.mgr.canvas;
    cv.addEventListener('pointerdown', (e) => {
      if (this.mgr.current !== 'reactor') return;
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
      this.vTheta = 0; this.vPhi = 0; // 重新按下 → 清空上一段惯性
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!this._drag || e.pointerId !== this._drag.id) return;
      const dx = e.clientX - this._drag.x, dy = e.clientY - this._drag.y;
      this._drag.x = e.clientX; this._drag.y = e.clientY;
      const dT = dx * 0.005, dP = dy * 0.004;
      this.theta += dT;
      this.phiD = clamp(this.phiD + dP, -0.42, 0.5); // 俯仰偏移限位防翻转
      this.vTheta = dT; this.vPhi = dP;              // 记录松手惯性
    });
    const endDrag = (e) => {
      if (this._drag && e.pointerId === this._drag.id) this._drag = null;
    };
    cv.addEventListener('pointerup', endDrag);
    cv.addEventListener('pointercancel', endDrag);
  }
  /* 网格坐标 → 圆盘归一化半径（遮罩判定与鼓点/水滴落点采样共用） */
  _discR(gx, gz) {
    const wx = ((gx + 0.5) / this.G) * 2 - 1;
    const wz = ((gz + 0.5) / this.G) * 2 - 1;
    return Math.sqrt(wx * wx + wz * wz);
  }
  /* 水滴：盘内随机落点（拒绝采样，兜底盘中部），触发圆形波纹环 */
  _spawnDrop() {
    const G = this.G;
    let gx = G * 0.5, gz = G * 0.45;
    for (let q = 0; q < 8; q++) {
      const tx = Math.random() * (G - 1), tz = Math.random() * (G - 1);
      if (this._discR(tx, tz) < 0.68) { gx = tx; gz = tz; break; }
    }
    let slot = this.drops[0];
    for (const d of this.drops) { if (!d.on) { slot = d; break; } if (d.age > slot.age) slot = d; }
    slot.on = true; slot.gx = gx; slot.gz = gz; slot.age = 0;
    slot.str = 0.85 + Math.random() * 0.4; // 每滴强弱略随机
  }
  /* 每帧基色（仿 themes 情绪映射：warmth=低频占比 → 暖色偏移；accent=涟漪色；另备线性空间版给 three） */
  _palette(hue, hue2, bass, mid, tre) {
    // 逐柱色相缓存重烘焙：hue/hue2 变化（换歌/封面取色）→ 每柱按 hueOff 展开出自己的冷/暖/高亮色（低频重算，每帧零分配）
    const hk = hue + '|' + hue2;
    if (hk !== this._hueKey) {
      this._hueKey = hk;
      const cells = this.cells, cc = this.cCool, cw = this.cWarm, ch = this.cHi;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i], off = c.hueOff, i3 = i * 3;
        // 单柱即冷暖渐变：冷端深暗压底（偏 hue2）、暖端鲜亮（偏 hue）、高亮端向白提亮 55%（金属顶光）
        const cool = hslToRgb(hue2 + off, 0.88, 0.30), warm = hslToRgb(hue + off * 0.6, 0.94, 0.55);
        cc[i3] = sLin(cool[0]); cc[i3 + 1] = sLin(cool[1]); cc[i3 + 2] = sLin(cool[2]);
        cw[i3] = sLin(warm[0]); cw[i3 + 1] = sLin(warm[1]); cw[i3 + 2] = sLin(warm[2]);
        ch[i3] = sLin(warm[0] + (255 - warm[0]) * 0.55);
        ch[i3 + 1] = sLin(warm[1] + (255 - warm[1]) * 0.55);
        ch[i3 + 2] = sLin(warm[2] + (255 - warm[2]) * 0.55);
      }
    }
    const cFog = hslToRgb(hue2, 0.5, 0.14); // 雾色与 2D 天空地平线同系
    this._cFog[0] = cFog[0]; this._cFog[1] = cFog[1]; this._cFog[2] = cFog[2];
    const cool = hslToRgb(hue2, 0.9, 0.6), warm = hslToRgb(hue, 0.92, 0.58);
    const k = Math.min(1, bass / (bass + mid + tre + 0.001)) * 0.85;
    const g = this._cGlow, hi = this._cGlowHi;
    for (let i = 0; i < 3; i++) {
      g[i] = cool[i] + (warm[i] - cool[i]) * k;
      hi[i] = g[i] + (255 - g[i]) * 0.45;
    }
    const cRip = hslToRgb(hue2, 0.95, 0.78);
    this._cRip[0] = cRip[0]; this._cRip[1] = cRip[1]; this._cRip[2] = cRip[2];
    for (let i = 0; i < 3; i++) {
      this._linFog[i] = sLin(cFog[i]);
      this._linGlow[i] = sLin(g[i]);
      this._linGlowHi[i] = sLin(hi[i]);
      this._linRip[i] = sLin(cRip[i]);
    }
  }
  _spawnMeteor(w, h) {
    for (const m of this.meteors) {
      if (m.on) continue;
      const dir = Math.random() < 0.5 ? -1 : 1;
      m.on = true;
      m.x = w * (0.12 + Math.random() * 0.76);
      m.y = h * (0.02 + Math.random() * 0.14);
      m.vx = dir * (w * 0.09 + Math.random() * w * 0.08);
      m.vy = h * (0.15 + Math.random() * 0.1);
      m.life = 0; m.lifeMax = 0.9 + Math.random() * 0.8;
      return;
    }
  }
  /* 流星：天空斜划发光拖尾；陨落处触发白色锐利涟漪（仿 snare 白波） */
  _drawMeteors(ctx, w, h, dt, horizon, hue2) {
    for (const m of this.meteors) {
      if (!m.on) continue;
      m.x += m.vx * dt; m.y += m.vy * dt; m.life += dt;
      if (m.life >= m.lifeMax || m.y > horizon + h * 0.05) {
        m.on = false;
        const r = this.ripples[this._ripIdx]; this._ripIdx = (this._ripIdx + 1) % this.ripples.length;
        r.on = true; r.age = 0; r.white = 1; r.str = 0.85;
        // 陨落点落在盘内随机位置（盘外无柱，波纹不可见）：拒绝采样，兜底盘中部
        r.gx = this.G * 0.5; r.gz = this.G * 0.45;
        for (let q = 0; q < 6; q++) {
          const tx = Math.random() * (this.G - 1), tz = Math.random() * (this.G - 1);
          if (this._discR(tx, tz) < 0.7) { r.gx = tx; r.gz = tz; break; }
        }
        continue;
      }
      const tx = m.x - m.vx * 0.3, ty = m.y - m.vy * 0.3;
      const g = ctx.createLinearGradient(m.x, m.y, tx, ty);
      g.addColorStop(0, 'rgba(255,255,255,0.95)');
      g.addColorStop(0.4, `hsla(${hue2},95%,76%,0.5)`);
      g.addColorStop(1, `hsla(${hue2},95%,66%,0)`);
      ctx.strokeStyle = g; ctx.lineWidth = 2.2; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(m.x, m.y); ctx.lineTo(tx, ty); ctx.stroke();
      ctx.lineCap = 'butt';
      ctx.fillStyle = 'rgba(255,255,255,0.92)';
      ctx.beginPath(); ctx.arc(m.x, m.y, 1.8, 0, TAU); ctx.fill();
      ctx.fillStyle = `hsla(${hue2},95%,82%,0.25)`;
      ctx.beginPath(); ctx.arc(m.x, m.y, 5.5, 0, TAU); ctx.fill();
    }
  }
  /* 空间歌词（sonic-topography 风格）：当前行大号发光文字浮于地形上空，
     卡拉OK扫光填充；下一行小字预告于地平线上方；纯音乐显示曲名 */
  _drawLyrics(ctx, w, h, dt, t, horizon) {
    const L = this.mgr.lyr;
    const lines = (L && L.lines) || [];
    const idx = L ? (L.idx | 0) : -1;
    const lt = (L && L.time) || 0;
    const cur = lines[idx] || null;
    if (idx !== this._lIdx) { this._lIdx = idx; this._lT = 0; } // 切行 → 重启过渡
    this._lT += dt;
    const ease = 1 - Math.pow(1 - Math.min(1, this._lT / 0.5), 3); // 淡入上浮
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const hasLines = lines.length > 0;
    // 有歌词但处于前奏/间奏（idx=-1 或空行）→ 留空；纯音乐 → 曲名
    const txt = hasLines
      ? (cur && cur.text && String(cur.text).trim() ? String(cur.text) : '')
      : (this.mgr.trackTitle || '');
    if (!txt) return;
    const bob = Math.sin(t * 0.55) * h * 0.008;                 // 缓慢浮动
    const y = h * 0.42 + bob + (1 - ease) * 26;                 // 上 1/3~1/2 之间
    const fs = Math.min(w * 0.055, h * 0.095, 96) * (1 + this._bassSm * 0.045); // 低频呼吸
    const fam = this.mgr.lyricFont ? `"${this.mgr.lyricFont}","PingFang SC","Microsoft YaHei",sans-serif` : '"PingFang SC","Microsoft YaHei",sans-serif';
    ctx.save();
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = `800 ${fs.toFixed(1)}px ${fam}`;
    let tw = ctx.measureText(txt).width;
    const maxW = w * 0.86;
    if (tw > maxW) { ctx.font = `800 ${(fs * maxW / tw).toFixed(1)}px ${fam}`; tw = ctx.measureText(txt).width; }
    // 卡拉OK进度：逐字时间可用 → 按已唱字数；否则整行点亮
    let prog = 1;
    if (cur && cur.chars && cur.chars.length) {
      let lit = 0;
      for (let ci = 0; ci < cur.chars.length; ci++) { if (lt >= cur.chars[ci].t) lit++; }
      prog = lit / cur.chars.length;
    }
    ctx.globalAlpha = (hasLines ? 0.88 + this._bassSm * 0.12 : 0.6) * (0.25 + 0.75 * ease);
    // 第一遍：暗底 + 黑投影（可读性）
    ctx.shadowColor = 'rgba(0,0,0,0.85)'; ctx.shadowBlur = 12; ctx.shadowOffsetY = 4;
    ctx.fillStyle = `hsla(${hue2},30%,18%,0.6)`;
    ctx.fillText(txt, w / 2, y);
    // 第二遍：主题辉光 + 扫光填充（柔和渐变过渡，仿参考实现的 smoothstep 擦除）
    ctx.shadowColor = `hsla(${hue},95%,62%,0.6)`; ctx.shadowBlur = 26; ctx.shadowOffsetY = 0;
    const x0 = w / 2 - tw / 2;
    const g = ctx.createLinearGradient(x0, 0, x0 + tw, 0);
    const p0 = Math.max(0.001, prog - 0.05), p1 = Math.min(0.999, prog + 0.05);
    g.addColorStop(0, `hsla(${hue2},95%,82%,1)`);
    g.addColorStop(p0, `hsla(${hue2},95%,78%,1)`);
    g.addColorStop(p1, `hsla(${hue2},95%,70%,0.15)`);
    g.addColorStop(1, `hsla(${hue2},95%,70%,0.15)`);
    ctx.fillStyle = g;
    ctx.fillText(txt, w / 2, y);
    // 下一行预告：地平线上方小号暗字
    const nxt = hasLines ? lines[idx + 1] : null;
    if (nxt && nxt.text && String(nxt.text).trim()) {
      ctx.font = `600 ${(fs * 0.38).toFixed(1)}px ${fam}`;
      ctx.globalAlpha = 0.32 * ease;
      ctx.shadowBlur = 6; ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.fillStyle = `hsla(${hue2},45%,80%,1)`;
      ctx.fillText(String(nxt.text), w / 2, horizon - h * 0.035);
    }
    ctx.restore();
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    // —— 设置（视觉控制台实时写入 mgr.reactorCfg）：滴水间隔 / 相机俯仰 / 高度增益 / 整体大小 / 网格密度 / 流星频率 / 自转 ——
    const cfg = this.mgr.reactorCfg || {};
    const dropInt = clamp(cfg.freq == null ? 3.5 : +cfg.freq, 1, 8);
    const tilt = clamp(cfg.tilt == null ? 4 : +cfg.tilt, 0, 10);
    const gain = clamp(cfg.gain == null ? 1 : +cfg.gain, 0.5, 2);
    const scaleS = clamp(cfg.scale == null ? 1 : +cfg.scale, 0.5, 2);    // 整体大小（地形/辉光整体缩放）
    const spin = cfg.spin !== false;                                     // 自动旋转开关
    const mtrF = clamp(cfg.mtrFreq == null ? 55 : +cfg.mtrFreq, 0, 100); // 流星频率（0=关）
    this._syncGrid();   // 网格密度设置校准（内部变更检测，常态零开销；变化 → 重建高度场与实例网格）
    const G = this.G;
    const bass = bands.bass || 0, mid = bands.mid || 0, tre = bands.treble || 0;
    // —— 频谱低通（上升快、回落慢）——
    for (let i = 0; i < 96; i++) this.smooth[i] += (bins[i] - this.smooth[i]) * Math.min(1, dt * (bins[i] > this.smooth[i] ? 18 : 8));
    // —— 鼓点：底鼓包络（快攻慢放）驱动盘心山体集体冲高 + 随机柱脉冲 ——
    if (bands.beat) {
      this._beat = 1;
      this._kick = Math.max(this._kick, 0.6 + (bands.beatPulse || 0) * 0.45);
    }
    this._beat *= Math.pow(0.02, dt);
    this._kick *= Math.pow(0.06, dt);
    this._bassSm += (bass - this._bassSm) * Math.min(1, dt * 8);
    // —— 流星触发：频率由设置「流星频率」决定（0=关；默认 55 ≈ 每 2.7-4.5s 一颗，100 → 0.8s 密集），
    //     高频尖峰仍可提前触发，但受最小间隔节流防刷屏 ——
    if (mtrF > 0) {
      const mInt = 0.8 + (1 - mtrF / 100) * 6.2;
      if ((t > this._nextMeteor || (tre > 0.5 && this._prevTre <= 0.45)) && t - this._lastMeteor > mInt * 0.45) {
        this._spawnMeteor(w, h);
        this._lastMeteor = t;
        this._nextMeteor = t + mInt * (0.75 + Math.random() * 0.5);
      }
    }
    this._prevTre = tre;

    // —— 1) 目标高度：频段分区驱动（sonic-topography 地形分区映射到圆盘半径）——
    const smooth = this.smooth, cells = this.cells, hTgt = this.hTgt;
    const rndK = cfg.rnd; // 随机跳动强度（0=关，1=默认，2=最强）
    const energy = bass + mid + tre; // 总能量驱动随机跳动幅度
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      const b = smooth[c.bin] || 0;
      let hgt = 0;
      // 低频山：盘心成片山峰，鼓点（kick 包络）落下集体冲高
      if (c.gateB > 0.25) {
        hgt += (bass * 2.3 + this._kick * 3.0) * c.cBass * (0.55 + c.gateB * 0.65);
      }
      // 中频环带：随 bin 起伏的丘陵
      hgt += b * 1.9 * c.cMid;
      // 高频尖刺：外圈细碎起伏快速响应
      if (c.gateT > 0) hgt += tre * b * 2.2 * c.gateT * c.cOut;
      // 随机跳动：随机「数量」的柱体跳跃，而非所有柱体随机高度
      // 每柱独立相位正弦在 0..1 间振荡；阈值随能量下降 → 能量越高、越过阈值的柱越多（跳的柱数量随机变化）
      if (rndK > 0.001) {
        const phase = Math.sin(t * c.rndSp + c.rndPh) * 0.5 + 0.5;   // 每柱独立 0..1 相位
        const threshold = 1.0 - energy * rndK * 0.7;               // 能量↑ → 阈值↓ → 跳的柱数量↑
        if (phase > threshold) {
          const amt = (phase - threshold) / (1 - threshold);      // 超出阈值的程度映射到 0..1
          hgt += energy * 1.6 * rndK * amt;
        }
        // 鼓点随机脉冲：鼓点瞬间随机数量的柱体猛然跳起（爆米花式错落）
        if (this._kick > 0.15 && c.gateB > 0.55) {
          const kp = Math.sin(c.rndPh * 3.7) * 0.5 + 0.5;
          if (kp > 1.0 - this._kick * rndK * 0.8) {
            hgt += this._kick * 2.2 * rndK;
          }
        }
      }
      // 噪声门：接近静音保持平地
      hTgt[c.gi] = Math.max(0, hgt - 0.14);
    }
    // —— 2) 波动：鼓点环形波（盘心扩散）+ 水滴波包（随机落点局域波包），叠加进高度场与染色缓冲；
    //     边缘增益按半径压低（盘心 1 → 盘缘 0.35），与圆盘遮罩叠加后边缘跟波但动作小 ——
    // 鼓点触发盘心环形波（彩色款；白色款由流星陨落触发），强度跟随 beatPulse
    if (bands.beat) {
      const rp = this.ripples[this._ripIdx]; this._ripIdx = (this._ripIdx + 1) % this.ripples.length;
      rp.on = true; rp.age = 0; rp.white = 0;
      rp.str = 0.55 + (bands.beatPulse || 0) * 0.65;
      rp.gx = G * 0.5; rp.gz = G * 0.5;
    }
    // 水滴按「滴水间隔」落滴（间隔 ±30% 随机抖动）
    this._nextDrop -= dt;
    if (this._nextDrop <= 0) {
      this._spawnDrop();
      this._nextDrop = dropInt * (0.7 + Math.random() * 0.6);
    }
    // 推进波纹年龄：当前半径/衰减/宽度写入预分配数组（环形波快而窄，水滴波包慢而宽）
    const ripples = this.ripples, drops = this.drops;
    for (let k = 0; k < ripples.length; k++) {
      const rp = ripples[k];
      if (!rp.on) { this._ripFade[k] = 0; continue; }
      rp.age += dt;
      rp.wx = ((rp.gx + 0.5) / G) * 2 - 1; rp.wz = ((rp.gz + 0.5) / G) * 2 - 1;
      this._ripRad[k] = rp.age * 0.62;
      this._ripFade[k] = Math.exp(-rp.age * 1.15) * rp.str;
      this._ripWid[k] = 0.085;
      if (this._ripFade[k] < 0.03) rp.on = false;
    }
    for (let k = 0; k < drops.length; k++) {
      const dp = drops[k];
      if (!dp.on) { dp.env = 0; continue; }
      dp.age += dt;
      dp.wx = ((dp.gx + 0.5) / G) * 2 - 1; dp.wz = ((dp.gz + 0.5) / G) * 2 - 1;
      dp.rad = dp.age * 0.30;                          // 比鼓点环形波扩散更慢
      dp.env = Math.exp(-dp.age * 1.0) * dp.str;
      if (dp.env < 0.03) dp.on = false;
    }
    this.ripN.fill(0); this.ripW.fill(0);
    const ripN = this.ripN, ripW = this.ripW;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      let wH = 0, nA = 0, wA = 0;
      // 环形波：窄环高斯包络，波峰处柱体抬高并染色
      for (let k = 0; k < ripples.length; k++) {
        if (this._ripFade[k] <= 0) continue;
        const rp = ripples[k];
        const dx = c.wx - rp.wx, dz = c.wz - rp.wz;
        const q = (Math.sqrt(dx * dx + dz * dz) - this._ripRad[k]) / this._ripWid[k];
        if (q > 3 || q < -3) continue;
        const e = Math.exp(-q * q) * this._ripFade[k];
        wH += e * 1.5;
        if (rp.white) wA += e * 1.2; else nA += e * 1.1;
      }
      // 水滴波包：宽高斯包络 × 径向余弦载波 → 局域振荡波包，向外缓慢扩散衰减
      for (let k = 0; k < drops.length; k++) {
        const dp = drops[k];
        if (dp.env <= 0) continue;
        const dx = c.wx - dp.wx, dz = c.wz - dp.wz;
        const d = Math.sqrt(dx * dx + dz * dz);
        const q = (d - dp.rad) / 0.15;
        if (q > 3 || q < -3) continue;
        const e = Math.exp(-q * q) * dp.env;
        wH += Math.cos((d - dp.rad) * 14) * e * 0.9;
        nA += e * 0.55;
      }
      // 边缘跟随起伏但动作小：波动位移按半径平方衰减（盘缘仅 35%）
      if (wH !== 0) hTgt[c.gi] += wH * (1 - c.rad * c.rad * 0.65);
      if (nA > 0.01) ripN[c.gi] = Math.min(1, nA);
      if (wA > 0.01) ripW[c.gi] = Math.min(1, wA);
    }
    // 圆盘遮罩统一生效：盘缘渐隐、盘外归零；波包载波可产生负位移，钳制防柱体反向生长
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      hTgt[c.gi] = Math.max(0, hTgt[c.gi] * c.mask);
    }
    // —— 3) 低通追踪目标（上升快、回落慢）；已移除邻居均值扩散，柱体各自独立跳动 ——
    for (let c = 0; c < this.hCur.length; c++) {
      const tg = this.hTgt[c];
      this.hCur[c] += (tg - this.hCur[c]) * Math.min(1, dt * (tg > this.hCur[c] ? 14 : 6.5));
    }

    // ================= 合成 =================
    this._palette(hue, hue2, bass, mid, tre);
    // —— 天空 / 地面 / 地平线辉光带（2D 背景层；渐变按倾角量化缓存，3D 地形叠在其上）——
    const skyH = h * (0.30 + (tilt / 10) * 0.22);
    const skyKey = ((w * 7 + h) | 0) + '|' + (hue | 0) + '|' + (hue2 | 0) + '|' + ((tilt * 10) | 0);
    if (skyKey !== this._skyKey) {
      const sky = ctx.createLinearGradient(0, 0, 0, skyH);
      sky.addColorStop(0, `hsl(${hue},55%,3%)`);
      sky.addColorStop(0.72, `hsl(${hue},48%,7%)`);
      sky.addColorStop(1, `hsl(${hue2},55%,13%)`);
      const gnd = ctx.createLinearGradient(0, skyH, 0, h);
      gnd.addColorStop(0, `hsl(${hue2},45%,9%)`);
      gnd.addColorStop(1, `hsl(${hue},50%,4%)`);
      const hz = ctx.createLinearGradient(0, skyH - h * 0.06, 0, skyH + h * 0.1);
      hz.addColorStop(0, `hsla(${hue2},95%,62%,0)`);
      hz.addColorStop(0.55, `hsla(${hue2},95%,62%,0.3)`);
      hz.addColorStop(1, `hsla(${hue2},95%,62%,0)`);
      this._sky = sky; this._gnd = gnd; this._hz = hz; this._skyKey = skyKey;
    }
    ctx.fillStyle = this._sky; ctx.fillRect(0, 0, w, skyH + 1);
    ctx.fillStyle = this._gnd; ctx.fillRect(0, skyH, w, h - skyH);
    // 地平线辉光带（beat 时增强）
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55 + this._beat * 0.6;
    ctx.fillStyle = this._hz;
    ctx.fillRect(0, skyH - h * 0.06, w, h * 0.16);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    // —— 3D 地形（three 惰性加载；先摆相机与地平线，再画流星，最后渲染合成）——
    const r3 = this._ensureThree();
    let horizon = skyH;
    if (r3 && r3.mesh) {
      this._bindPointer();     // 舞台拖拽旋转（仅本场景响应，绑一次）
      const cam = r3.camera;
      // 旋转：拖拽中由指针直控；否则自动缓慢自转（可关）+ 惯性阻尼衰减（照抄 CoverParticles 模式）
      if (!this._drag) {
        if (spin) this.theta += 0.05 * dt;
        this.theta += this.vTheta;
        this.phiD = clamp(this.phiD + this.vPhi, -0.42, 0.5);
        const damp = Math.pow(0.04, dt);
        this.vTheta *= damp; this.vPhi *= damp;
      }
      // 相机：「倾斜角度」滑块为默认俯仰（0 → 近乎平视 22°，10 → 俯瞰 63°），拖拽 phiD 在其基础上偏移；
      // 方位角 = 缓慢摇移视差 + 拖拽/自转累积
      const el = clamp(0.38 + (tilt / 10) * 0.72 + this.phiD, 0.12, 1.42);
      const az = Math.sin(t * 0.05) * 0.16 + this.theta;
      // 地形铺满到软件边缘：相机距离按视口宽高比自适应（盘半径 1.06 横向贴满视口；竖屏夹取防过远）
      const tanH = Math.tan(cam.fov * Math.PI / 360) * cam.aspect;
      const D = clamp(1.06 / tanH, 1.3, 3.4);
      cam.position.set(Math.sin(az) * Math.cos(el) * D, Math.sin(el) * D, Math.cos(az) * Math.cos(el) * D);
      cam.lookAt(0, 0.18, 0);
      cam.updateMatrixWorld();
      // 整体大小：地形/辉光整体缩放（设置 50-200%）；雾距随缩放同步平移保持观感一致
      r3.mesh.scale.setScalar(scaleS);
      r3.scene.fog.near = D - 0.45 * scaleS;
      r3.scene.fog.far = D + 2.15 * scaleS;
      r3.glow.position.y = 0.32 * scaleS;
      // 地平线 = 盘远缘世界点投影 → 流星/歌词锚定真实地形边缘
      if (!this._projV) this._projV = new this._THREE.Vector3();
      this._projV.set(-Math.sin(az) * 1.3 * scaleS, 0.06 * scaleS, -Math.cos(az) * 1.3 * scaleS).project(cam);
      horizon = clamp((1 - this._projV.y) * 0.5 * h, h * 0.10, h * 0.72);
    }
    // —— 流星（2D 层画在 3D 地形之前 → 高山可遮挡，更有纵深）——
    this._drawMeteors(ctx, w, h, dt, horizon, hue2);

    // —— 3D 地形渲染与合成：逐实例写高度/颜色 → render → drawImage 回主画布 ——
    if (r3 && r3.mesh) {
      const cam = r3.camera;
      // 雾色 / 盘心辉光随取色与低频呼吸
      r3.scene.fog.color.setRGB(this._linFog[0], this._linFog[1], this._linFog[2]);
      const gm = r3.glow.material;
      gm.color.setRGB(this._linGlowHi[0], this._linGlowHi[1], this._linGlowHi[2]);
      gm.opacity = Math.min(0.55, 0.10 + bass * 0.22 + this._beat * 0.25);
      const gs = 1.15 + this._kick * 0.9 + this._bassSm * 0.5;
      r3.glow.scale.set(gs * scaleS, gs * scaleS, 1);   // 盘心辉光随「整体大小」同步缩放
      // —— 金属质感实时调节：metal 0.3(哑光) ~ 2(镜面金属) ——
      // shininess 从 30 到 200（光斑由宽到极窄），specular 从暗灰到近白，环境光压低、主光加强 → 高对比金属反光带
      const mt = cfg.metal;
      r3.mat.shininess = 30 + mt * 85;
      const sp = 0.55 + mt * 0.22; // specular 灰阶（线性）
      r3.mat.specular.setRGB(sp, sp, sp);
      r3.amb.intensity = Math.max(0.25, 0.75 - mt * 0.28); // 金属越强 → 环境光越暗 → 明暗反差越大
      r3.sun.intensity = 1.8 + mt * 0.5;
      r3.fill.intensity = 0.35 + mt * 0.2;
      const mesh = r3.mesh;
      const m = mesh.instanceMatrix.array;
      const col = mesh.instanceColor.array;
      const HK = 0.115 * gain;                       // 高度倍率（设置「高度增益」实时生效）
      const cc = this.cCool, cw = this.cWarm, ch = this.cHi, lf = this._linFog, lr = this._linRip;
      for (let i = 0; i < cells.length; i++) {
        const c = cells[i];
        const hgt = this.hCur[c.gi];
        const s = 0.015 + hgt * HK;                  // Y 缩放 = 柱高；柱心落地 → 自地面向上生长
        const o = i * 16;
        m[o + 5] = s; m[o + 13] = s * 0.5;
        // ① 高度渐变明暗：矮柱沉暗、高柱浅亮——冷暗 → 暖 → 亮三段随高度推进（幂曲线拉对比），
        //    叠加在能量染色之上（线性空间，零对象分配）
        const eN = Math.min(1, hgt / 6.5);
        const k1 = Math.min(1, eN * 1.6);            // 前段：冷暗 → 暖
        const k2 = Math.max(0, eN * 1.25 - 0.45);    // 后段：暖 → 亮（交叠过渡更顺滑）
        const i3 = i * 3;
        // ⑥ 逐柱色相：每柱用自己的冷/暖/亮三色（低频噪声 ±22° 展开，hue 变化时重烘焙于 _palette）
        let rC = cc[i3] + (cw[i3] - cc[i3]) * k1;
        let gC = cc[i3 + 1] + (cw[i3 + 1] - cc[i3 + 1]) * k1;
        let bC = cc[i3 + 2] + (cw[i3 + 2] - cc[i3 + 2]) * k1;
        rC += (ch[i3] - rC) * k2; gC += (ch[i3 + 1] - gC) * k2; bC += (ch[i3 + 2] - bC) * k2;
        // ⑤ 径向光衰减：中心全亮，越靠盘缘越暗（归一化半径平方衰减）
        const rA = 1 - c.rad * c.rad * 0.52;
        rC *= rA; gC *= rA; bC *= rA;
        let k = (1 - c.mask) * 0.6;                  // 盘缘一圈渐隐融进雾色
        rC += (lf[0] - rC) * k; gC += (lf[1] - gC) * k; bC += (lf[2] - bC) * k;
        const rn = this.ripN[c.gi], rw = this.ripW[c.gi];
        if (rn > 0.03) { k = Math.min(0.92, rn); rC += (lr[0] - rC) * k; gC += (lr[1] - gC) * k; bC += (lr[2] - bC) * k; }
        if (rw > 0.03) { k = Math.min(0.95, rw); rC += (1 - rC) * k; gC += (1 - gC) * k; bC += (1 - bC) * k; }
        col[i3] = rC; col[i3 + 1] = gC; col[i3 + 2] = bC;
      }
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor.needsUpdate = true;
      r3.renderer.render(r3.scene, cam);
      // WebGL 画布合成回 2D 主画布（render 与 drawImage 同一同步任务，无需 preserveDrawingBuffer）
      ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
    }
    // —— 节拍全屏柔光脉冲 ——
    if (this._beat > 0.08) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `hsla(${hue2},90%,70%,${(this._beat * 0.055).toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
      ctx.globalCompositeOperation = 'source-over';
    }
    // —— 空间歌词（最上层，保持清晰）——
    this._drawLyrics(ctx, w, h, dt, t, horizon);
  }
}

/* ---------- 场景八：黑胶唱片（旋转 + 唱臂 + 环形频谱） ---------- */
class VinylScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this.coverImg = null;
    this.smooth = new Float32Array(96);
    this.notes = Array.from({ length: 20 }, () => ({
      x: Math.random(), y: Math.random(), sz: 1 + Math.random() * 2,
      ph: Math.random() * TAU, sp: 0.15 + Math.random() * 0.4, vy: 0.1 + Math.random() * 0.2
    }));
    this._beat = 0;
    this._rot = 0;
  }
  setCover(img) { this.coverImg = (img && img.width) ? img : null; }
  resize() {}
  frame(ctx, w, h, dt, t, bands, bins) {
    for (let i = 0; i < 96; i++) this.smooth[i] += (bins[i] - this.smooth[i]) * Math.min(1, dt * (bins[i] > this.smooth[i] ? 16 : 7));
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.02, dt);
    this._rot += dt * (0.22 + bands.bass * 0.5); // 唱盘自转：慢速基速 + 低频轻微加速（原 0.8+bass*2 过快）
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const cx = w / 2, cy = h / 2;
    // 动态响应：唱盘随鼓点脉冲缩放（bands/bins 已含灵敏度倍率，「动态」滑块调节实时生效）
    const pulse = 1 + bands.beatPulse * 0.05 + this._beat * 0.09;
    const R = Math.min(w, h) * 0.32 * pulse;
    const jitter = bands.bass * 3 * (bands.beat ? 1 : 0.3);
    const vx = cx + (Math.random() - 0.5) * jitter, vy = cy + (Math.random() - 0.5) * jitter;
    // 背景径向渐变
    const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.max(w, h) * 0.7);
    bg.addColorStop(0, `hsla(${hue},45%,7%,1)`);
    bg.addColorStop(1, 'hsla(0,0%,2%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';
    // 漂浮音符粒子
    for (const n of this.notes) {
      n.ph += n.sp * dt;
      n.y -= dt * n.vy;
      if (n.y < 0) { n.y = 1; n.x = Math.random(); }
      ctx.fillStyle = `hsla(${hue2},80%,80%,${0.2 + 0.2 * Math.abs(Math.sin(n.ph))})`;
      ctx.beginPath(); ctx.arc(n.x * w, n.y * h, n.sz, 0, TAU); ctx.fill();
    }
    // 唱片圆盘
    ctx.globalCompositeOperation = 'source-over';
    ctx.save(); ctx.translate(vx, vy);
    // 黑胶底
    const disc = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
    disc.addColorStop(0, 'hsla(0,0%,12%,1)');
    disc.addColorStop(0.7, 'hsla(0,0%,6%,1)');
    disc.addColorStop(1, 'hsla(0,0%,15%,1)');
    ctx.fillStyle = disc;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    // 同心圆纹路
    ctx.strokeStyle = `hsla(0,0%,20%,0.5)`;
    ctx.lineWidth = 1;
    for (let i = 1; i < 20; i++) {
      ctx.beginPath(); ctx.arc(0, 0, R * (0.3 + i * 0.035), 0, TAU); ctx.stroke();
    }
    // 环形频谱（外圈 64 柱）
    ctx.globalCompositeOperation = 'lighter';
    const NB = 64;
    for (let i = 0; i < NB; i++) {
      const ang = (i / NB) * TAU + this._rot;
      const v = this.smooth[Math.floor(i / NB * 96)] || 0;
      // 频谱柱长度随律动缩放，鼓点瞬间额外冲高（消费 _beat，与其他场景一致）
      const len = Math.max(2, v * R * 0.3 + this._beat * R * 0.07);
      const r1 = R * 1.02, r2 = r1 + len;
      const ca = Math.cos(ang), sa = Math.sin(ang);
      const g = ctx.createLinearGradient(ca * r1, sa * r1, ca * r2, sa * r2);
      g.addColorStop(0, `hsla(${hue},75%,50%,0.7)`);
      g.addColorStop(1, `hsla(${hue2},95%,75%,1)`);
      ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, (TAU * r1 / NB) * 0.5);
      ctx.beginPath(); ctx.moveTo(ca * r1, sa * r1); ctx.lineTo(ca * r2, sa * r2); ctx.stroke();
    }
    // 中心标签圆（封面）
    const labelR = R * 0.35;
    ctx.save();
    ctx.rotate(this._rot);
    ctx.beginPath(); ctx.arc(0, 0, labelR, 0, TAU); ctx.clip();
    if (this.coverImg) {
      const im = this.coverImg; const s = (labelR * 2) / Math.min(im.width, im.height);
      ctx.drawImage(im, -im.width * s / 2, -im.height * s / 2, im.width * s, im.height * s);
    } else {
      const lg = ctx.createRadialGradient(0, 0, 0, 0, 0, labelR);
      lg.addColorStop(0, `hsl(${hue},60%,30%)`);
      lg.addColorStop(1, `hsl(${hue2},60%,15%)`);
      ctx.fillStyle = lg; ctx.fillRect(-labelR, -labelR, labelR * 2, labelR * 2);
    }
    ctx.restore();
    // 中心孔
    ctx.fillStyle = 'hsla(0,0%,5%,1)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.03, 0, TAU); ctx.fill();
    ctx.restore();
    // 唱臂（从右上角延伸到唱片边缘，随播放进度摆动）
    const armBase = { x: w * 0.82, y: h * 0.15 };
    const armAng = -0.6 + Math.sin(t * 0.1) * 0.15 + this._rot * 0.02;
    const armLen = R * 1.3;
    const tipX = armBase.x + Math.cos(armAng) * armLen;
    const tipY = armBase.y + Math.sin(armAng) * armLen;
    ctx.strokeStyle = `hsla(0,0%,60%,0.9)`;
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(armBase.x, armBase.y); ctx.lineTo(tipX, tipY); ctx.stroke();
    ctx.fillStyle = `hsla(0,0%,40%,1)`;
    ctx.beginPath(); ctx.arc(armBase.x, armBase.y, 8, 0, TAU); ctx.fill();
    ctx.fillStyle = `hsla(${hue2},80%,60%,1)`;
    ctx.beginPath(); ctx.arc(tipX, tipY, 5, 0, TAU); ctx.fill();
    // 鼓点全屏微闪（消费 _beat 的节拍反馈，幅度随「动态」灵敏度缩放）
    if (this._beat > 0.1) {
      ctx.fillStyle = `hsla(${hue2},90%,70%,${this._beat * 0.06})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ---------- 歌词动画场景默认配置（JIZURA 渲染核心） ---------- */
const PV_DEF = { style: 'noir', size: 1, y: 0.52, dim: 0.35 };
/* JIZURA 的 12 种基础风格键（= J.STYLE_ORDER）；预设在此基础上扩展到 20 种（含 base 复用）。
   旧配置里的未知值（如 'karaoke'）回退 'noir' */
const PV_JIZURA_STYLES = ['noir', 'crimson', 'caution', 'magenta', 'paper', 'hud', 'mint', 'specimen', 'transit', 'blueprint', 'rouge', 'mono'];

/* ---------- 12 风格 → 差异化 preset bundle（整体风格，不止换色） ----------
   每个按钮 = style（JIZURA 配色/字体/排版基调）+ mood（情绪，约束手法池，见 08b_omakase.js J.MOODS）
   + fx 参数组合 + 部件集开关 + 独立 seed 盐，让 12 个按钮呈现明显不同的整体观感。
   mood 取值：glitch 故障 | calm 静 | pop 波普 | graphic 图形 | editorial 编辑 | emotional 情绪。
   fx 取值域（= J.defaultProject().fx，扁平键值）：motion/glitch/chroma/decor/density/texture/bgSwitch ∈ 0..1，
   flash bool，koma 15|10|0（逐帧动画密度，0=每帧），hud 'auto'|'on'|'off'。
   表里只写与默认值不同的项；_buildPlan 里与 defaultProject().fx 合并（fx 无嵌套，Object.assign 即深合并）。 */
const PV_PRESETS = {
  /* 黑白默片：极简编辑风——慢节奏、少装饰、低故障，纸质颗粒，只留基础部件 */
  noir:      { mood: 'editorial', salt: 'noir-min', typeset: true, unify: true, sets: { extra: false, wa: false },
               fx: { motion: 0.45, glitch: 0.12, chroma: 0.25, decor: 0.25, density: 0.4, texture: 0.85, bgSwitch: 0.15, flash: false, koma: 15, hud: 'off' } },
  /* 绯红：情绪大字报——动感强、中故障、高色差，冲击闪白 */
  crimson:   { mood: 'emotional', salt: 'crimson-emo',
               fx: { motion: 0.75, glitch: 0.45, chroma: 0.7, decor: 0.4, density: 0.6, texture: 0.7, bgSwitch: 0.35, flash: true, koma: 15, hud: 'off' } },
  /* 警示黄：高密度警示条纹 + 高频 glitch，仪表 HUD 常开，8koma 逐帧抖动 */
  caution:   { mood: 'graphic', salt: 'caution-warn',
               fx: { motion: 0.8, glitch: 0.85, chroma: 0.6, decor: 0.85, density: 0.8, texture: 0.55, bgSwitch: 0.5, flash: true, koma: 10, hud: 'on' } },
  /* 品红：霓虹波普——高动感、频繁换配色，中故障、快闪 */
  magenta:   { mood: 'pop', salt: 'magenta-pop',
               fx: { motion: 0.9, glitch: 0.3, chroma: 0.5, decor: 0.7, density: 0.65, texture: 0.35, bgSwitch: 0.6, flash: true, koma: 15, hud: 'off' } },
  /* 纸张：静·手作——纸张纹理全开、极低故障、慢速 8koma，和风素材点缀 */
  paper:     { mood: 'calm', salt: 'paper-ink', typeset: true, sets: { extra: false, wa: true },
               fx: { motion: 0.35, glitch: 0.05, chroma: 0.2, decor: 0.3, density: 0.3, texture: 1, bgSwitch: 0.1, flash: false, koma: 10, hud: 'off' } },
  /* HUD：仪表盘全开——高故障高色差、装饰拉满，koma 0 每帧刷新，放开追加分部件 */
  hud:       { mood: 'glitch', salt: 'hud-dark', sets: { extra: true },
               fx: { motion: 0.7, glitch: 0.9, chroma: 0.85, decor: 0.9, density: 0.6, texture: 0.9, bgSwitch: 0.3, flash: false, koma: 0, hud: 'on' } },
  /* 薄荷：终端标签——中高故障 + 扫描线质感，HUD 辅助 */
  mint:      { mood: 'glitch', salt: 'mint-term',
               fx: { motion: 0.65, glitch: 0.7, chroma: 0.75, decor: 0.5, density: 0.55, texture: 0.75, bgSwitch: 0.3, flash: false, koma: 15, hud: 'on' } },
  /* 标本：字典注记——极静、低色差、统一排版 */
  specimen:  { mood: 'editorial', salt: 'specimen-dic', typeset: true, unify: true, sets: { extra: false, wa: false },
               fx: { motion: 0.4, glitch: 0.08, chroma: 0.15, decor: 0.35, density: 0.45, texture: 0.8, bgSwitch: 0.12, flash: false, koma: 15, hud: 'off' } },
  /* 换乘指示：图形标识——箭头/计数器装饰多、高密度、频繁换背景 */
  transit:   { mood: 'graphic', salt: 'transit-sign',
               fx: { motion: 0.7, glitch: 0.2, chroma: 0.35, decor: 0.75, density: 0.7, texture: 0.5, bgSwitch: 0.45, flash: true, koma: 15, hud: 'off' } },
  /* 蓝图：制图风——低密度大留白、低故障、8koma，只留基础图形部件 */
  blueprint: { mood: 'graphic', salt: 'blueprint-grid', unify: true, sets: { extra: false, wa: false },
               fx: { motion: 0.5, glitch: 0.15, chroma: 0.3, decor: 0.45, density: 0.25, texture: 0.4, bgSwitch: 0.15, flash: false, koma: 10, hud: 'off' } },
  /* 胭脂：渐变情绪——中动感、柔和装饰、少故障 */
  rouge:     { mood: 'emotional', salt: 'rouge-grad',
               fx: { motion: 0.6, glitch: 0.25, chroma: 0.45, decor: 0.55, density: 0.55, texture: 0.55, bgSwitch: 0.3, flash: false, koma: 15, hud: 'off' } },
  /* 单色：强 RGB 分离（该风格自带 ghost 1.3）——中高故障 + 重颗粒 */
  mono:      { mood: 'glitch', salt: 'mono-rgb',
               fx: { motion: 0.65, glitch: 0.6, chroma: 1, decor: 0.4, density: 0.5, texture: 0.85, bgSwitch: 0.25, flash: true, koma: 15, hud: 'off' } },
  /* ===== 扩展 8 种（复用 JIZURA 基础风格 + 差异化 mood/fx/salt，合计 20 种）===== */
  /* 极光：冷色流动光带——静、低故障、高纹理、慢节奏，薄荷基底换冷调 */
  aurora:    { base: 'mint', mood: 'calm', salt: 'aurora-borealis',
               fx: { motion: 0.4, glitch: 0.15, chroma: 0.4, decor: 0.45, density: 0.4, texture: 0.9, bgSwitch: 0.2, flash: false, koma: 15, hud: 'off' } },
  /* 赛博：未来科技 HUD——高故障高色差、装饰满、koma 0 每帧刷，HUD 基底增强 */
  cyber:     { base: 'hud', mood: 'glitch', salt: 'cyber-2099', sets: { extra: true },
               fx: { motion: 0.85, glitch: 0.92, chroma: 0.8, decor: 0.92, density: 0.7, texture: 0.6, bgSwitch: 0.4, flash: false, koma: 0, hud: 'on' } },
  /* 落日：暖色黄昏——情绪、中动感、柔和装饰、少故障，胭脂基底暖调 */
  sunset:    { base: 'rouge', mood: 'emotional', salt: 'sunset-glow',
               fx: { motion: 0.55, glitch: 0.18, chroma: 0.4, decor: 0.5, density: 0.5, texture: 0.6, bgSwitch: 0.28, flash: false, koma: 15, hud: 'off' } },
  /* 水墨：东方水墨——极静、低故障、纸张纹理全开、统一排版，纸张基底和风 */
  ink:       { base: 'paper', mood: 'calm', salt: 'ink-wash', typeset: true, unify: true, sets: { extra: false, wa: true },
               fx: { motion: 0.3, glitch: 0.04, chroma: 0.15, decor: 0.25, density: 0.25, texture: 1, bgSwitch: 0.08, flash: false, koma: 10, hud: 'off' } },
  /* 霓虹：都市霓虹——波普、高动感、频繁换背景、快闪，品红基底提亮 */
  neon:      { base: 'magenta', mood: 'pop', salt: 'neon-city',
               fx: { motion: 0.92, glitch: 0.35, chroma: 0.55, decor: 0.72, density: 0.7, texture: 0.3, bgSwitch: 0.65, flash: true, koma: 15, hud: 'off' } },
  /* 复古：老电影胶片——编辑、低故障、重颗粒、慢 8koma，标本基底做旧 */
  vintage:   { base: 'specimen', mood: 'editorial', salt: 'vintage-film', typeset: true, unify: true, sets: { extra: false, wa: false },
               fx: { motion: 0.38, glitch: 0.1, chroma: 0.22, decor: 0.4, density: 0.42, texture: 0.95, bgSwitch: 0.1, flash: false, koma: 10, hud: 'off' } },
  /* 矩阵：数字雨——故障、强 RGB 分离、HUD 辅助、单色基底改绿调 */
  matrix:    { base: 'mono', mood: 'glitch', salt: 'matrix-code',
               fx: { motion: 0.7, glitch: 0.85, chroma: 0.95, decor: 0.55, density: 0.6, texture: 0.8, bgSwitch: 0.3, flash: false, koma: 15, hud: 'on' } },
  /* 梦境：朦胧柔焦——情绪、低对比、慢节奏、少故障，黑白基底柔化 */
  dream:     { base: 'noir', mood: 'emotional', salt: 'dream-soft', typeset: true, unify: true, sets: { extra: false, wa: false },
               fx: { motion: 0.32, glitch: 0.08, chroma: 0.18, decor: 0.3, density: 0.3, texture: 0.7, bgSwitch: 0.12, flash: false, koma: 15, hud: 'off' } },
};

/* 按情绪约束手法池（确定性版，参照 vendor/jizura/08b_omakase.js 的 enabled 构建逻辑）：
   每组只开放「打了该 mood 标签 + 情绪自带清单」的手法，并保底补足最小数量让规划器有选择空间；
   cut 进出场 / 无文字处理 / 无背景 / 缓推镜头 / 静止 hold 始终可用。需在 sets 开关应用后调用
   （randomOk 依赖 project.extra / wa / typo / kinetic）。 */
function buildPvEnabled(J, project, mood) {
  const M = mood && J.MOODS[mood];
  if (!M) return null;
  const MIN = { layout: 6, enter: 5, exit: 5, hold: 3, decor: 6, treat: 4, bg: 4, cam: 3, fx: 4, trans: 3 };
  const moodSetOk = d => !(d && d.set) || !Object.values(J.MOODS).some(m => m.set === d.set) || M.set === d.set;
  const enabled = {};
  for (const g of J.GROUP_KEYS) {
    const order = J.order(g).filter(k => {
      const d = J.registry(g)[k] || {};
      return !d.special && (!J.randomOk || J.randomOk(project, g, k)) && moodSetOk(d);
    });
    const hand = (g === 'layout' || g === 'enter' || g === 'exit') && Array.isArray(M[g]) ? M[g] : [];
    const prefer = new Set([...hand, ...J.taggedWith(g, mood)]);
    const on = {};
    for (const k of J.order(g)) if (!moodSetOk(J.registry(g)[k] || {})) on[k] = false;
    for (const k of order) on[k] = prefer.has(k);
    let n = order.filter(k => on[k]).length;
    for (const k of order) { if (n >= Math.min(MIN[g] || 3, order.length)) break; if (!on[k]) { on[k] = true; n++; } }
    enabled[g] = on;
  }
  enabled.enter.cut = true; enabled.exit.cut = true;
  if (enabled.treat) enabled.treat.none = true;
  if (enabled.bg) enabled.bg.none = true;
  if (enabled.cam) enabled.cam.push = true;
  for (const k of (M.noHold || [])) if (enabled.hold[k] !== undefined) enabled.hold[k] = false;
  enabled.hold.still = true;
  return enabled;
}

/* ---------- 性能：离屏降分辨率 + 限帧 ----------
   JIZURA 设计分辨率 16:9 = 1920×1080；离屏按 720p 出图（plan.H → PV_OFF_H，像素量 ≈ 44%），
   renderer.frame 传 scale 让引擎按比例出图，主画布 contain 缩放绘制，观感损失很小。 */
const PV_OFF_H = 720;

/* ---------- JIZURA 引擎懒加载 ----------
   vendor/jizura/ 下的 IIFE 脚本共享全局命名空间 J（01_util.js 创建）。
   加载顺序 = 文件名字典序（与上游 build.py 的 src/*.js 排序一致，
   已排除 11_export.js / 12_ui.js）。串行注入，全部完成后 resolve 全局 J。 */
let _jizuraP = null;
function loadJizura() {
  if (_jizuraP) return _jizuraP;
  const files = [
    '01_util.js', '02_fonts.js', '02b_lang.js', '03_text.js', '04_styles.js',
    '05_anim.js', '05b_registry.js', '06_layouts.js', '07_decor.js',
    '08_planner.js', '08b_omakase.js', '09_render.js', '10_audio.js',
    '11p_bgcamB.js', '11p_decor.js', '11p_decorB.js', '11p_enter.js', '11p_enterB.js',
    '11p_exit.js', '11p_exitB.js', '11p_fxB.js', '11p_horror1.js', '11p_horror2.js',
    '11p_horror3.js', '11p_kinetic1.js', '11p_kinetic2.js', '11p_kinetic3.js',
    '11p_layoutsA.js', '11p_layoutsB.js', '11p_layoutsC.js', '11p_layoutsD.js',
    '11p_looks.js', '11p_styles.js', '11p_treattrans.js', '11p_typo1.js', '11p_typo2.js',
    '11p_typo3.js', '11q_sets.js'
  ].sort(); // 与上游 build.py 相同的字典序拼接顺序
  _jizuraP = new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= files.length) {
        if (window.J && window.J.plan && window.J.Renderer) resolve(window.J);
        else { _jizuraP = null; reject(new Error('JIZURA engine incomplete after load')); }
        return;
      }
      const s = document.createElement('script');
      s.src = './vendor/jizura/' + files[i++];
      s.onload = next;
      s.onerror = () => { _jizuraP = null; reject(new Error('JIZURA load failed: ' + s.src)); };
      document.head.appendChild(s);
    };
    next();
  });
  return _jizuraP;
}

/* ---------- 歌词动画场景：JIZURA 文字 MV 引擎渲染核心 ----------
   歌词行 → 合成 LRC → J.plan() 生成整曲渲染计划 → Renderer 按 720p 缩放逐帧
   （限帧 ~30fps）画到离屏画布，contain 等比居中合成到主画布。
   引擎未就绪 / 计划构建失败时走简单兜底渲染，绝不抛错。 */
class PvScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._linesRef = null;   // 上次构建计划用的歌词数组引用（引用变化 → 重建）
    this._styleKey = null;   // 上次构建计划用的风格键
    this._plan = null;       // J.plan() 结果
    this._renderer = null;   // J.Renderer 实例
    this._off = null;        // 离屏画布（1280×720，只建一次，尺寸随计划调整）
    this._offCtx = null;
    this._buildSeq = 0;      // 异步构建序号：防止过期回调覆盖新计划
    this._lastLt = -1;       // 上次离屏重绘的歌词时间（seek 检测）
    this._lastIdx = -2;      // 上次离屏重绘的歌词行号（切行强制刷新）
    this._lastTq = -1;       // 上次离屏重绘的 koma 步进时间（步进对齐限帧）
    this._stepDur = 1 / 30;  // koma 步进时长（计划构建时按 plan.fx/fps 更新）
  }

  /* JIZURA 自带整套背景美术，封面不参与该场景渲染（保留基类接口） */
  setCover() {}

  /* 歌词行 → 带 LRC 时间戳的合成文本：每行 `[mm:ss.xx]text`；空文本行跳过；行末 ! 保留 */
  _synthLrc(lines) {
    const out = [];
    for (const ln of lines) {
      const txt = String(ln && ln.text || '').trim();
      if (!txt || ln.time == null || !isFinite(ln.time)) continue;
      const t = Math.max(0, ln.time);
      const mm = String(Math.floor(t / 60)).padStart(2, '0');
      const ss = String(Math.floor(t % 60)).padStart(2, '0');
      const cs = String(Math.floor((t % 1) * 100)).padStart(2, '0');
      out.push(`[${mm}:${ss}.${cs}]${txt}`);
    }
    return out.join('\n');
  }

  /* 构建 JIZURA 渲染计划（异步：先确保引擎加载完成）；失败静默走兜底 */
  _buildPlan(lines, styleKey) {
    const seq = ++this._buildSeq;
    loadJizura().then((J) => {
      if (seq !== this._buildSeq) return;
      try {
        const lrc = this._synthLrc(lines);
        if (!lrc) { this._plan = null; this._renderer = null; return; }
        const project = J.defaultProject();
        /* 整体风格 bundle：style 之外再叠 mood（约束手法池）/ fx 参数 / 部件集开关 / typeset·unify / 独立 seed 盐 */
        const bundle = PV_PRESETS[styleKey] || PV_PRESETS.noir;
        project.lyrics = lrc;
        project.style = bundle.base || (PV_JIZURA_STYLES.includes(styleKey) ? styleKey : 'noir');
        project.aspect = '16:9';
        project.res = 720;
        project.fps = 30;
        project.lang = 'auto';
        project.title = this.mgr.trackTitle || '';
        project.seed = J.sid((project.title || 'pv') + '|' + bundle.salt); // 歌曲名+风格盐 hash → 每风格不同的确定性美术
        project.mood = bundle.mood;
        if (bundle.typeset != null) project.typeset = bundle.typeset;
        if (bundle.unify != null) project.unify = bundle.unify;
        if (bundle.sets) Object.assign(project, bundle.sets);
        project.fx = Object.assign({}, project.fx, bundle.fx); // fx 扁平键值：默认值打底 → bundle 覆盖，不丢默认项
        const en = buildPvEnabled(J, project, bundle.mood);    // 必须在 sets 应用之后构建（randomOk 依赖 extra/wa 开关）
        if (en) project.enabled = en;
        const plan = J.plan(project, null);
        if (seq !== this._buildSeq) return;
        this._plan = plan;
        this._renderer = new J.Renderer();
        this._lastLt = -1; this._lastIdx = -2; this._lastTq = -1; // 新计划 → 下一帧强制重绘
        this._stepDur = (typeof J.stepDur === 'function') ? J.stepDur(plan.fx, plan.fps) : (1 / (plan.fps || 24));
        if (!this._off) { this._off = document.createElement('canvas'); this._offCtx = this._off.getContext('2d'); }
        // 离屏按 720p 出图（engine 设计 1920×1080 × scale），renderer.frame 由 scale 等比缩小
        const ok = PV_OFF_H / plan.H;
        const ow = Math.round(plan.W * ok / 2) * 2, oh = Math.round(plan.H * ok / 2) * 2;
        if (this._off.width !== ow || this._off.height !== oh) { this._off.width = ow; this._off.height = oh; }
        // 字体按需懒加载（在线提升观感；离线/被拦截时引擎自动回退系统字体，不阻塞渲染）
        try { J.ensureFonts(lrc, J.fontsOfPlan(plan)).catch(() => {}); } catch (e) { /* 忽略 */ }
      } catch (e) {
        console.warn('PvScene: JIZURA 计划构建失败，使用兜底渲染。', e);
        if (seq === this._buildSeq) { this._plan = null; this._renderer = null; }
      }
    }).catch((e) => {
      console.warn('PvScene: JIZURA 引擎加载失败，使用兜底渲染。', e);
      if (seq === this._buildSeq) { this._plan = null; this._renderer = null; }
    });
  }

  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = Object.assign({}, PV_DEF, this.mgr.pvCfg);
    const L = this.mgr.lyr || { lines: [], idx: -1, time: 0 };
    const lines = L.lines || [];
    const lt = L.time || 0; // 歌词时间 = 音频时间（同一时基）

    // 歌词引用 / 风格变化 → 重建渲染计划（异步，不阻塞当前帧）
    if (lines !== this._linesRef || cfg.style !== this._styleKey) {
      this._linesRef = lines;
      this._styleKey = cfg.style;
      this._buildPlan(lines, cfg.style);
    }

    // ---- 计划就绪：JIZURA 按 koma 步进渲染到离屏画布，contain 等比居中合成（黑边留白） ----
    if (this._plan && this._renderer && this._offCtx) {
      try {
        // ---- 离屏重绘按 koma 步进对齐（关键优化）----
        // JIZURA 把动画时间量化到 stepDur（tq = floor(t/stepDur)*stepDur），tq 不变则渲染输出逐像素相同。
        // 旧逻辑固定 30fps 轮询，koma=15 时约半数重绘在画同一帧。改为只在步进推进 / 首帧 / seek 回退 /
        // 切行时调 renderer.frame（另留 0.5s 兜底），主画布每帧仍 drawImage 缓存帧 ——
        // 重绘次数与引擎 koma 时钟严格一致（koma=15 → 15 次/秒），无任何视觉差异。
        const lineChanged = L.idx !== this._lastIdx;
        const tq = Math.floor(lt / this._stepDur + 1e-6) * this._stepDur;
        if (this._lastLt < 0 || lt < this._lastLt - 0.01 || tq !== this._lastTq ||
            lineChanged || lt - this._lastLt > 0.5) {
          this._lastLt = lt; this._lastIdx = L.idx; this._lastTq = tq;
          this._renderer.frame(this._offCtx, this._plan, lt, { scale: this._off.height / this._plan.H });
        }
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        const ow = this._off.width, oh = this._off.height; // 按离屏实际尺寸（720p）contain 居中
        const s = Math.min(w / ow, h / oh);
        const dw = ow * s, dh = oh * s;
        ctx.drawImage(this._off, (w - dw) / 2, (h - dh) / 2, dw, dh);
      } catch (e) {
        console.warn('PvScene: JIZURA 帧渲染异常，使用兜底渲染。', e);
        this._plan = null; this._renderer = null;
      }
    } else {
      // ---- 兜底渲染：深底 + 居中当前行白字（引擎未就绪 / 构建失败 / 纯音乐无歌词） ----
      ctx.fillStyle = '#06070c';
      ctx.fillRect(0, 0, w, h);
      const cur = lines[L.idx];
      const txt = cur ? String(cur.text || '') : (this.mgr.trackTitle || '');
      if (txt) {
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const fs = Math.min(w * 0.058, h * 0.13, 88) * (cfg.size || 1);
        const fam = this.mgr.lyricFont ? `"${this.mgr.lyricFont}","PingFang SC","Microsoft YaHei",sans-serif` : '"PingFang SC","Microsoft YaHei",sans-serif';
        ctx.font = `600 ${fs}px ${fam}`;
        ctx.fillStyle = 'rgba(240,244,255,0.9)';
        ctx.fillText(txt, w / 2, h * (cfg.y || 0.52), w * 0.86);
        ctx.restore();
      }
    }

    // 背景暗度罩（「背景暗度」滑块 dim 0..1 → 黑罩 alpha = dim * 0.6）
    const dimAlpha = clamp(cfg.dim || 0, 0, 1) * 0.6;
    if (dimAlpha > 0.001) {
      ctx.fillStyle = `rgba(0,0,0,${dimAlpha.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
}

/* ---------- 工具 ---------- */
function hslToRgb(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return [f(0), f(8), f(4)];
}
/* sRGB 0..255 → 线性 0..1（three 材质/实例色按线性空间解析，避免色彩发灰） */
function sLin(v) {
  const u = v / 255;
  return u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
}
/* =====================================================================
   3D 光追场景基座（2026-10-14 重写：能量核心/极光/频谱花朵/声波涟漪共用）
   惰性 import three → 离屏 WebGLRenderer + 全屏三角形 + ShaderMaterial：
   光线步进（ray marching）/ 体积累积 / 反射着色全部在 fragment shader 内完成，
   呈现 GPU 光追质感（辉光、菲涅尔、法线光照、反射全由逐像素光线计算）。
   统一 uniforms：uRes/uTime/uBass/uMid/uTre/uBeat/uLevel/uColA/uColB——
   颜色每帧取 mgr.pal（跟随全局调色板：主题/背景/封面来源由 theme.js colorSrc 决定）。
   离屏按 0.72 倍分辨率出图再放大合成（光追开销大，柔和画面放大观感无损）。
   ===================================================================== */
class RaymarchSceneBase extends Scene {
  constructor(mgr, frag) {
    super(mgr);
    this._frag = frag;
    this._r3 = null; this._r3Dead = false; this._r3Loading = null; this._THREE = null;
    this._beat = 0; this._bass = 0; this._mid = 0; this._tre = 0;
  }
  resize() { if (this._r3) this._fit3(); }
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn(this.constructor.name + ': three 加载失败，降级为深色底。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;
  }
  _init3() {
    const T = this._THREE;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x050608, 1);
    this._rs = 0.72;                                     // 离屏渲染比例（光追开销大）
    const w = Math.max(2, Math.round((this.mgr.w || 640) * this._rs));
    const h = Math.max(2, Math.round((this.mgr.h || 360) * this._rs));
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    const scene = new T.Scene();
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const uniforms = {
      uRes: { value: new T.Vector2(w, h) },
      uTime: { value: 0 },
      uBass: { value: 0 }, uMid: { value: 0 }, uTre: { value: 0 },
      uBeat: { value: 0 }, uLevel: { value: 0 },
      uColA: { value: new T.Color(0.2, 0.9, 0.8) },
      uColB: { value: new T.Color(0.6, 0.4, 0.9) }
    };
    this._uniforms3x?.(T, uniforms);                     // 场景追加 uniforms（如涟漪鼓点事件）
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    const mat = new T.ShaderMaterial({
      uniforms,
      vertexShader: 'void main(){ gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: this._frag,
      depthTest: false, depthWrite: false
    });
    scene.add(new T.Mesh(geo, mat));
    this._r3 = { renderer, scene, camera, uniforms };
    this._init3x?.(T, this._r3);
  }
  _fit3() {
    const r3 = this._r3;
    const w = Math.max(2, Math.round(this.mgr.w * this._rs));
    const h = Math.max(2, Math.round(this.mgr.h * this._rs));
    r3.renderer.setSize(w, h, false);
    r3.uniforms.uRes.value.set(w, h);
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    this._beat = bands.beat ? 1 : this._beat * Math.pow(0.02, dt);
    const k = Math.min(1, dt * 10);
    this._bass += ((bands.bass || 0) - this._bass) * k;
    this._mid += ((bands.mid || 0) - this._mid) * k;
    this._tre += ((bands.treble || 0) - this._tre) * k;
    const r3 = this._ensureThree();
    if (!r3) { ctx.fillStyle = '#050608'; ctx.fillRect(0, 0, w, h); return; }
    const u = r3.uniforms;
    u.uTime.value = t;
    u.uBass.value = this._bass; u.uMid.value = this._mid; u.uTre.value = this._tre;
    u.uBeat.value = this._beat; u.uLevel.value = bands.level || 0;
    // 全局调色板 → 线性空间着色（跟随主题/背景/封面，由 theme.js colorSrc 统一决定）
    const c1 = hslToRgb(this.mgr.pal.hue, 0.85, 0.60);
    const c2 = hslToRgb(this.mgr.pal.hue2, 0.80, 0.62);
    u.uColA.value.setRGB(sLin(c1[0]), sLin(c1[1]), sLin(c1[2]));
    u.uColB.value.setRGB(sLin(c2[0]), sLin(c2[1]), sLin(c2[2]));
    this._frame3x?.(dt, t, bands, bins);
    r3.renderer.render(r3.scene, r3.camera);
    ctx.globalAlpha = this._alpha ? this._alpha() : 1;
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
}

/* ---------- 场景四：能量核心（光线步进：fbm 形变等离子球 + 体积辉光 + 电晕射线 + 星空） ---------- */
const RM_NOISE = `
float rmHash(vec3 p){ p=fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }
float rmNoise(vec3 x){ vec3 i=floor(x),f=fract(x); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(rmHash(i),rmHash(i+vec3(1.0,0.0,0.0)),f.x),mix(rmHash(i+vec3(0.0,1.0,0.0)),rmHash(i+vec3(1.0,1.0,0.0)),f.x),f.y),
             mix(mix(rmHash(i+vec3(0.0,0.0,1.0)),rmHash(i+vec3(1.0,0.0,1.0)),f.x),mix(rmHash(i+vec3(0.0,1.0,1.0)),rmHash(i+vec3(1.0,1.0,1.0)),f.x),f.y),f.z); }
float rmFbm(vec3 p){ float v=0.0,a=0.5; for(int i=0;i<5;i++){ v+=a*rmNoise(p); p*=2.03; a*=0.5; } return v; }
`;
const CORE_FRAG = `
uniform vec2 uRes; uniform float uTime,uBass,uMid,uTre,uBeat,uLevel;
uniform vec3 uColA,uColB;
${RM_NOISE}
float map(vec3 p){
  float r=0.92+0.16*uBass+0.10*uBeat;
  float d=rmFbm(p*2.4+vec3(0.0,uTime*0.5,uTime*0.3));
  return length(p)-r-(d-0.5)*(0.16+0.34*uTre);
}
void main(){
  vec2 uv=(2.0*gl_FragCoord.xy-uRes)/uRes.y;
  float sway=uTime*0.15;
  vec3 ro=vec3(sin(sway)*0.35,0.15*sin(uTime*0.23),3.05);
  vec3 rd=normalize(vec3(uv,-1.9)-vec3(sin(sway)*0.11,0.0,0.0));
  // 深空背景 + 星点
  vec3 col=mix(vec3(0.006,0.008,0.014),uColA*0.05+uColB*0.04,pow(1.0-abs(rd.y),2.0));
  vec3 sg=floor(rd*140.0);
  float st=rmHash(sg);
  if(st>0.9965) col+=vec3(0.7)*(0.35+0.65*sin(uTime*3.0+st*90.0));
  float t=0.0; float glow=0.0; float d=1.0;
  for(int i=0;i<56;i++){
    vec3 p=ro+rd*t;
    d=map(p);
    glow+=0.0016/(0.012+d*d);
    if(d<0.004){
      vec2 e=vec2(0.0025,-0.0025);
      vec3 n=normalize(e.xyy*map(p+e.xyy)+e.yyx*map(p+e.yyx)+e.yxy*map(p+e.yxy)+e.xxx*map(p+e.xxx));
      float fre=pow(1.0-max(0.0,dot(-rd,n)),3.0);
      float pl=rmFbm(p*3.5+vec3(uTime*0.7));
      float li=max(0.0,dot(n,normalize(vec3(0.6,0.8,0.5))));
      vec3 sc=mix(uColA*0.25,uColB,pl)*(0.30+0.70*li);
      col=sc+fre*mix(uColA,uColB,0.5+0.5*pl)*1.7;
      break;
    }
    if(t>6.5) break;
    t+=max(d*0.55,0.012);
  }
  col+=glow*mix(uColA,uColB,0.35+0.35*sin(uTime*0.6))*(0.50+0.85*uBass+0.55*uBeat);
  // 电晕放射线（角向 fbm，随高频闪烁、鼓点增亮）
  float ang=atan(uv.y,uv.x);
  float rays=pow(max(0.0,rmFbm(vec3(cos(ang),sin(ang),0.0)*3.0+vec3(uTime*0.4))),3.0);
  col+=rays*mix(uColA,uColB,0.5)*(0.08+0.5*uTre+0.35*uBeat)*exp(-length(uv)*1.4);
  col*=1.0+0.45*uBeat;
  col*=1.0-0.35*dot(uv*0.55,uv*0.55); // 暗角
  gl_FragColor=vec4(pow(max(col,vec3(0.0)),vec3(0.85)),1.0);
}
`;
class EnergyCoreScene extends RaymarchSceneBase {
  constructor(mgr) { super(mgr, CORE_FRAG); }
}

/* ---------- 场景五：CD 弹出旋转（2D：方形封面卡 + 从封套右侧弹出的 CD 碟片持续旋转；
   碟面贴封面图，中心透明孔；背景为封面高斯模糊满铺（无封面走调色板渐变）；
   配置：旋转速度 / 弹出幅度 / 整体亮度（uCfg → mgr.auroraCfg 每帧实时生效） ---------- */
class CDScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this.coverImg = null;
    this._rot = 0;                 // 碟片当前角度
    this._beat = 0;
    this._bassSm = 0;              // 低频平滑（转速/呼吸用）
    // 漂浮微尘（背景点缀，跟随调色板色相）
    this.dust = Array.from({ length: 36 }, () => ({
      x: Math.random(), y: Math.random(), sz: 0.8 + Math.random() * 1.8,
      ph: Math.random() * TAU, sp: 0.1 + Math.random() * 0.3, vy: 0.06 + Math.random() * 0.14
    }));
  }
  setCover(img) { this.coverImg = (img && img.width) ? img : null; }
  resize() {}
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.auroraCfg || { spd: 1, den: 1, brt: 1 };
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.04, dt);
    this._bassSm += (bands.bass - this._bassSm) * Math.min(1, dt * 5);
    // 碟片转速：基础匀速 + 低频微加速（音量再大也不狂转，保持「唱片感」）
    this._rot += dt * (1.2 + this._bassSm * 0.9) * cfg.spd;
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;

    /* ---- 背景：封面模糊满铺（无封面 → 调色板渐变），整体亮度作用于全画面 ---- */
    const im = this.coverImg;
    if (im) {
      ctx.save();
      try { ctx.filter = 'blur(28px)'; } catch { /* 旧内核无 filter 直接画 */ }
      const s = Math.max(w / im.width, h / im.height) * 1.08;
      ctx.globalAlpha = 0.55;
      ctx.drawImage(im, (w - im.width * s) / 2, (h - im.height * s) / 2, im.width * s, im.height * s);
      ctx.restore();
      ctx.fillStyle = 'rgba(5,6,10,0.62)';
      ctx.fillRect(0, 0, w, h);
    } else {
      const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
      bg.addColorStop(0, `hsl(${hue},48%,9%)`);
      bg.addColorStop(1, `hsl(${hue2},52%,3%)`);
      ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    }
    // 漂浮微尘
    for (const n of this.dust) {
      n.ph += n.sp * dt;
      n.y -= dt * n.vy;
      if (n.y < 0) { n.y = 1; n.x = Math.random(); }
      ctx.fillStyle = `hsla(${hue2},80%,80%,${0.10 + 0.12 * Math.abs(Math.sin(n.ph))})`;
      ctx.beginPath(); ctx.arc(n.x * w, n.y * h, n.sz, 0, TAU); ctx.fill();
    }

    /* ---- 布局：封面卡居中偏左，碟心位于封套右缘 + 弹出幅度 ---- */
    const S = Math.min(w, h) * 0.40 * (1 + this._beat * 0.015); // 卡片边长（鼓点微呼吸）
    const cardCX = w / 2 - S * 0.30, cardCY = h / 2;
    const R = S * 0.56;                                           // 碟半径（略大于卡高一半）
    const eject = clamp(0.30 + (cfg.den - 0.4) / 1.2 * 0.70, 0.30, 1.0); // den 0.4-1.6 → 弹出 30%-100%
    const discX = cardCX + S / 2 - R + 2 * R * eject;
    const discY = cardCY;

    /* ---- CD 碟片（先画碟，卡片后画盖住碟左半 → 从封套弹出的层次） ---- */
    ctx.save();
    ctx.translate(discX, discY);
    // 碟底：银色盘面 + 边缘透明圈
    const base = ctx.createRadialGradient(0, 0, R * 0.2, 0, 0, R);
    base.addColorStop(0, `hsla(0,0%,72%,1)`);
    base.addColorStop(0.45, `hsla(0,0%,38%,1)`);
    base.addColorStop(0.9, `hsla(0,0%,22%,1)`);
    base.addColorStop(1, `hsla(0,0%,55%,1)`);
    ctx.fillStyle = base;
    ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    // 盘面贴封面（随碟同转）
    ctx.save();
    ctx.rotate(this._rot);
    ctx.beginPath(); ctx.arc(0, 0, R * 0.985, 0, TAU); ctx.clip();
    if (im) {
      const s2 = (R * 2) / Math.min(im.width, im.height);
      ctx.drawImage(im, -im.width * s2 / 2, -im.height * s2 / 2, im.width * s2, im.height * s2);
    } else {
      const lg = ctx.createLinearGradient(-R, -R, R, R);
      lg.addColorStop(0, `hsl(${hue},65%,34%)`);
      lg.addColorStop(1, `hsl(${hue2},65%,16%)`);
      ctx.fillStyle = lg; ctx.fillRect(-R, -R, R * 2, R * 2);
    }
    // 同心刻纹 + 旋转高光楔（CD 彩虹扫光）
    ctx.strokeStyle = 'hsla(0,0%,100%,0.10)';
    ctx.lineWidth = 1;
    for (let i = 1; i <= 14; i++) {
      ctx.beginPath(); ctx.arc(0, 0, R * (0.36 + i * 0.045), 0, TAU); ctx.stroke();
    }
    const sheen = ctx.createConicGradient
      ? ctx.createConicGradient(0, 0, 0)
      : null;
    if (sheen) {
      sheen.addColorStop(0, 'hsla(0,0%,100%,0.0)');
      sheen.addColorStop(0.06, `hsla(${hue},90%,80%,0.28)`);
      sheen.addColorStop(0.12, 'hsla(0,0%,100%,0.0)');
      sheen.addColorStop(0.55, 'hsla(0,0%,100%,0.0)');
      sheen.addColorStop(0.62, `hsla(${hue2},90%,82%,0.22)`);
      sheen.addColorStop(0.68, 'hsla(0,0%,100%,0.0)');
      sheen.addColorStop(1, 'hsla(0,0%,100%,0.0)');
      ctx.fillStyle = sheen;
      ctx.beginPath(); ctx.arc(0, 0, R, 0, TAU); ctx.fill();
    }
    ctx.restore(); // 结束旋转层
    // 中心透明防滑圈 + 主轴孔
    ctx.fillStyle = 'hsla(0,0%,100%,0.20)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.30, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'hsla(0,0%,100%,0.35)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.30, 0, TAU); ctx.stroke();
    ctx.fillStyle = 'rgba(5,6,10,0.9)';
    ctx.beginPath(); ctx.arc(0, 0, R * 0.085, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'hsla(0,0%,100%,0.5)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.arc(0, 0, R * 0.085, 0, TAU); ctx.stroke();
    // 碟外圈柔光（鼓点增强、整体亮度缩放）
    ctx.strokeStyle = `hsla(${hue},85%,65%,${(0.25 + this._beat * 0.4) * cfg.brt})`;
    ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(0, 0, R + 2, 0, TAU); ctx.stroke();
    ctx.restore();

    /* ---- 方形封面卡（压在碟左半上，圆角 + 描边柔光） ---- */
    const r = S * 0.06;
    const x0 = cardCX - S / 2, y0 = cardCY - S / 2;
    ctx.save();
    ctx.shadowColor = `hsla(${hue},85%,60%,${0.45 * cfg.brt})`;
    ctx.shadowBlur = 30 * cfg.brt;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, S, S, r); else ctx.rect(x0, y0, S, S);
    if (im) {
      ctx.save(); ctx.clip();
      const s3 = S / Math.min(im.width, im.height);
      ctx.drawImage(im, cardCX - im.width * s3 / 2, cardCY - im.height * s3 / 2, im.width * s3, im.height * s3);
      ctx.restore();
    } else {
      const cg = ctx.createLinearGradient(x0, y0, x0 + S, y0 + S);
      cg.addColorStop(0, `hsl(${hue},60%,30%)`);
      cg.addColorStop(1, `hsl(${hue2},60%,14%)`);
      ctx.fillStyle = cg; ctx.fill();
    }
    ctx.shadowBlur = 0;
    ctx.strokeStyle = 'hsla(0,0%,100%,0.22)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(x0, y0, S, S, r); else ctx.rect(x0, y0, S, S);
    ctx.stroke();
    ctx.restore();

    // 鼓点全屏微闪（亮度缩放）
    if (this._beat > 0.1) {
      ctx.fillStyle = `hsla(${hue2},90%,70%,${this._beat * 0.05 * cfg.brt})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ---------- 场景六：粒子流场（2026-10-14 再重做：光带河——旧版粒子均匀散布像满屏噪点，
   没有「流」的连贯感；现改为 26 条错相流带：粒子按频谱位置归属流带，共享带基线与相位 →
   一整整发光绸带横贯画面连续流动；24 段对数频谱着色器内线性插值（无频段分割），
   颜色沿流带从低频 A 色（下）连续渐变到高频 B 色（上）；鼓点整带呼吸起伏；
   配置：粒子数量（重建 geometry）/ 流动速度 / 光点大小（实时写入） ---------- */
class ParticleFlowScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._r3 = null; this._r3Dead = false; this._r3Loading = null; this._THREE = null;
    this._beat = 0; this._bass = 0; this._mid = 0;
    this._spec = new Float32Array(24);   // 连续频谱（对数分布 + 攻击快衰减慢）
    this._builtN = 0;                    // 当前 geometry 粒子数（数量设置变化 → 重建）
  }
  resize() { if (this._r3) this._fit3(); }
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('ParticleFlowScene: three 加载失败，降级为深色底。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;
  }
  _init3() {
    const T = this._THREE;
    const w = this.mgr.w || 640, h = this.mgr.h || 360;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: false, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(55, w / h, 0.1, 20);
    camera.position.set(0, 0, 3.4);
    const uniforms = {
      uTime: { value: 0 }, uBass: { value: 0 }, uBeat: { value: 0 }, uLevel: { value: 0 },
      uSpec: { value: new Float32Array(24) },
      uCfg: { value: new T.Vector2(1, 1) },        // x 流动速度 / y 光点大小
      uColA: { value: new T.Color(0.2, 0.9, 0.8) },
      uColB: { value: new T.Color(0.6, 0.4, 0.9) }
    };
    this._r3 = { renderer, scene, camera, uniforms, points: null };
    this._buildPoints();
  }
  /* 构建/重建粒子河：aInfo = seed / 连续频谱位置 0..1 / 尺寸随机 / 速度随机 */
  _buildPoints() {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    if (r3.points) { r3.scene.remove(r3.points); r3.points.geometry.dispose(); r3.points.material.dispose(); r3.points = null; }
    const N = this._builtN = Math.round(clamp(this.mgr.flowCfg?.count ?? 6000, 800, 15000));
    const pos = new Float32Array(N * 3);
    const info = new Float32Array(N * 4);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 6.4;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 2.6;
      pos[i * 3 + 2] = (Math.random() - 0.5) * 3.0;   // z 纵深 ±1.5（相机 3.4，膨胀后不越相机平面）
      info[i * 4] = Math.random();
      info[i * 4 + 1] = Math.pow(Math.random(), 0.8); // 连续频谱位置（略偏低频，低频能量足）
      info[i * 4 + 2] = Math.random();
      info[i * 4 + 3] = Math.random();
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('aInfo', new T.BufferAttribute(info, 4));
    const mat = new T.ShaderMaterial({
      uniforms: r3.uniforms,
      vertexShader: `
        attribute vec4 aInfo;
        uniform float uTime,uBass,uBeat,uLevel;
        uniform vec2 uCfg;
        uniform float uSpec[24];
        varying float vB; varying float vMix;
        void main(){
          float seed=aInfo.x;
          float fx=aInfo.y*23.0;
          int fi=int(fx);
          float sp=mix(uSpec[fi],uSpec[min(fi+1,23)],fract(fx)); // 线性插值 → 无频段分割
          // 流带结构：26 条共享基线/相位的光带（lane 由频谱位置决定 → 同带粒子同频同色）
          float lane=floor(aInfo.y*25.999);
          float lh=fract(lane*0.618033+0.37);                     // 带哈希：错相/错幅/错速
          float laneY=(lane/25.0-0.5)*2.55;
          float t=uTime*uCfg.x*(0.30+aInfo.w*0.30)*(0.55+uLevel*1.1);
          vec3 p=position;
          p.x=mod(p.x+t*(0.55+lh*0.50)+seed*6.0,6.4)-3.2;         // 横向持续流动（无缝回绕）
          float ph=t*(0.80+lh*0.60)+lane*1.71;
          p.y=laneY
             +sin(p.x*(0.55+lh*0.35)+ph)*(0.10+0.16*lh)*(0.70+uBass*0.90)  // 带体大波形（低频呼吸）
             +sin(p.x*1.90-ph*1.35+seed*6.283)*0.035;                     // 个体微颤防呆板
          p.z=(lh-0.5)*2.2+sin(ph*0.5+seed*9.0)*0.30;
          p*=1.0+min(uBeat,0.8)*(0.10+0.18*fract(seed*7.31))+uBass*0.05; // 鼓点整带呼吸（限幅防越界）
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          float tw=0.75+0.25*sin(uTime*(2.0+lh*3.0)+seed*40.0);   // 逐点闪烁（慢起慢落）
          vB=(0.20+0.70*sp+uBeat*0.30)*tw;
          vMix=clamp(lane/25.0+(seed-0.5)*0.10,0.0,1.0);          // 颜色沿流带连续渐变（下A上B）
          gl_PointSize=(aInfo.z*2.2+1.0)*uCfg.y*(1.0+uBass*0.4+uBeat*0.6)*(30.0/max(1.2,-mv.z));
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: `
        uniform vec3 uColA,uColB;
        varying float vB; varying float vMix;
        void main(){
          vec2 q=gl_PointCoord-0.5;
          float d=length(q);
          float a=smoothstep(0.5,0.05,d);
          float core=smoothstep(0.16,0.0,d);
          vec3 c=mix(uColA,uColB,vMix)+core*0.5;
          gl_FragColor=vec4(c*(vB+core*0.6),a*vB);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const points = new T.Points(geo, mat);
    points.frustumCulled = false;
    r3.scene.add(points);
    r3.points = points;
  }
  _fit3() {
    const r3 = this._r3;
    r3.renderer.setSize(this.mgr.w, this.mgr.h, false);
    r3.camera.aspect = this.mgr.w / this.mgr.h;
    r3.camera.updateProjectionMatrix();
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    this._beat = bands.beat ? 1 : this._beat * Math.pow(0.02, dt);
    const k = Math.min(1, dt * 10);
    this._bass += ((bands.bass || 0) - this._bass) * k;
    this._mid += ((bands.mid || 0) - this._mid) * k;
    // 24 段对数频谱：低频段分辨率高（音乐能量集中区）；max 邻域取样 + 攻击快衰减慢
    const nb = bins ? bins.length : 0;
    for (let i = 0; i < 24; i++) {
      let s = 0;
      if (nb) {
        const c = Math.floor(Math.pow(i / 23, 1.5) * (nb - 1));
        const lo = Math.max(0, c - 1), hi = Math.min(nb - 1, c + 1);
        for (let j = lo; j <= hi; j++) s = Math.max(s, bins[j] || 0);
      }
      const cur = this._spec[i];
      this._spec[i] = cur + (s - cur) * Math.min(1, dt * (s > cur ? 16 : 5.5));
    }
    // 背景：深色径向渐变（与调色板同色系）
    const hue = this.mgr.pal.hue;
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, `hsla(${hue},45%,7%,1)`);
    bg.addColorStop(1, 'hsla(0,0%,2%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const r3 = this._ensureThree();
    if (!r3) return;
    if ((this.mgr.flowCfg?.count | 0) !== this._builtN) this._buildPoints(); // 数量设置变化 → 重建
    const cfg = this.mgr.flowCfg || { spd: 1, size: 1 };
    const u = r3.uniforms;
    u.uTime.value = t;
    u.uBass.value = this._bass; u.uBeat.value = this._beat; u.uLevel.value = bands.level || 0;
    u.uSpec.value.set(this._spec);
    u.uCfg.value.set(cfg.spd, cfg.size);
    const c1 = hslToRgb(this.mgr.pal.hue, 0.85, 0.60);
    const c2 = hslToRgb(this.mgr.pal.hue2, 0.80, 0.62);
    u.uColA.value.setRGB(sLin(c1[0]), sLin(c1[1]), sLin(c1[2]));
    u.uColB.value.setRGB(sLin(c2[0]), sLin(c2[1]), sLin(c2[2]));
    r3.renderer.render(r3.scene, r3.camera);
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
  }
}

/* ---------- 场景七：流星碰撞（2026-10-15 重做：Three.js 真 3D 不规则陨石——程序化噪声位移
   岩块 + 岩石 PBR 材质 + PMREM 环境反射 → 光追质感；陨石在宇宙内持续曲线飞行 + 翻滚自转
   + 加色拖尾；每个节拍在陨石当前位置触发撞击爆炸，碎片为 3D 岩块（InstancedMesh 实例化，
   随机翻滚/非均匀缩放/灼热→冷却实例色渐变），大节奏扩散大、小节奏扩散小（能量 = bass + beat）；
   30% 碎片附带辉光火花点云；飞行中陨石表面持续剥落小碎屑（高频驱动）；
   点光源随陨石移动照亮碎块产生动态反射；相机追尾视角穿越宇宙；
   配置：碎片数量 / 飞行阻尼 / 爆炸强度 / 拖尾亮度） ---------- */
class CollideScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0; this._bass = 0; this._mid = 0; this._tre = 0;
    this._beatE = 0;             // 节拍能量（大节奏扩散大，小节奏扩散小）
    // 流星本体
    this._mPos = null;           // THREE.Vector3 流星位置
    this._mVel = null;           // THREE.Vector3 流星速度
    this._mTrail = [];           // 拖尾位置环缓冲
    this._TRAIL_MAX = 96;
    // 爆炸碎片
    this._frags = [];            // {pos:Vector3, vel:Vector3, life, max, col:Array3, metal?:Mesh}
    // 相机：围绕流星缓慢独立环绕（不再固定在正后方）
    this._camAng = null;
    // Three.js 上下文（惰性初始化）
    this._r3 = null; this._r3Dead = false; this._r3Loading = null; this._THREE = null;
    this.dust = Array.from({ length: 90 }, () => ({
      x: Math.random(), y: Math.random(), z: 0.3 + Math.random() * 0.7,
      ph: Math.random() * TAU, sp: 0.1 + Math.random() * 0.35
    }));
  }
  resize() { if (this._r3) this._resize3(this.mgr.w, this.mgr.h); }
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('CollideScene: three 加载失败，流星碰撞降级为深色底。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;
  }
  /* 生成程序化环境贴图（深空渐变 + 彩色星云光斑）→ PMREM 预滤波 → 供金属材质反射，模拟光追质感 */
  _makeEnv(T, renderer) {
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 256;
    const g = cv.getContext('2d');
    // 深空径向渐变底色
    const bg = g.createLinearGradient(0, 0, 0, 256);
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    bg.addColorStop(0, `hsl(${hue2}, 70%, 6%)`);
    bg.addColorStop(0.5, `hsl(${hue}, 65%, 3%)`);
    bg.addColorStop(1, `hsl(${(hue + 40) % 360}, 60%, 5%)`);
    g.fillStyle = bg; g.fillRect(0, 0, 512, 256);
    // 彩色星云光斑（为金属反射提供彩色高光）
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * 512, y = Math.random() * 256, r = 30 + Math.random() * 90;
      const h = (Math.random() < 0.5 ? hue : hue2) + (Math.random() - 0.5) * 60;
      const rg = g.createRadialGradient(x, y, 0, x, y, r);
      rg.addColorStop(0, `hsla(${h}, 90%, 70%, 0.55)`);
      rg.addColorStop(1, `hsla(${h}, 90%, 70%, 0)`);
      g.fillStyle = rg; g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // 星点
    for (let i = 0; i < 300; i++) {
      g.fillStyle = `rgba(255,255,255,${0.3 + Math.random() * 0.7})`;
      g.fillRect(Math.random() * 512, Math.random() * 256, 1, 1);
    }
    const tex = new T.CanvasTexture(cv);
    tex.mapping = T.EquirectangularReflectionMapping;
    const pmrem = new T.PMREMGenerator(renderer);
    const env = pmrem.fromEquirectangular(tex).texture;
    pmrem.dispose(); tex.dispose();
    return env;
  }
  /* 程序化不规则岩块几何：Icosahedron 顶点按方向做多倍频三角噪声位移（同方向顶点位移一致，
     非索引几何也不会开裂）；fit=true 时等比收缩使最大半径恰为 radius（陨石需适配外围壳层） */
  _rockGeo(T, radius, detail, seed, fit) {
    const geo = new T.IcosahedronGeometry(radius, detail);
    const pos = geo.getAttribute('position');
    const v = new T.Vector3(), n = new T.Vector3();
    let maxR = 0;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i);
      n.copy(v).normalize();
      let d = 0;
      d += Math.sin(n.x * 3.1 + seed) * Math.cos(n.y * 2.7 + seed * 1.7) * Math.sin(n.z * 3.3 + seed * 0.6) * 0.22;
      d += Math.sin(n.x * 7.3 + seed * 2.1) * Math.cos(n.y * 6.1 + seed) * Math.sin(n.z * 6.7 + seed * 1.3) * 0.09;
      d += Math.sin(n.x * 13.7 + seed * 0.3) * Math.sin(n.y * 12.3 + seed * 2.7) * Math.sin(n.z * 14.1 + seed) * 0.045;
      const s = radius * (1 + d);
      pos.setXYZ(i, n.x * s, n.y * s, n.z * s);
      if (s > maxR) maxR = s;
    }
    if (fit && maxR > 0) {
      const k2 = radius / maxR;
      for (let i = 0; i < pos.count; i++) pos.setXYZ(i, pos.getX(i) * k2, pos.getY(i) * k2, pos.getZ(i) * k2);
    }
    geo.computeVertexNormals();
    return geo;
  }
  _init3() {
    const T = this._THREE;
    const w = this.mgr.w || 640, h = this.mgr.h || 360;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = T.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.0;
    const scene = new T.Scene();
    const env = this._makeEnv(T, renderer);
    scene.environment = env;
    const camera = new T.PerspectiveCamera(50, w / h, 0.05, 200);
    // 光源：环境光（弱）+ 主光（从流星方向补光）+ 流星点光源（随流星移动，照亮碎片产生动态反射）
    const amb = new T.AmbientLight(0xffffff, 0.40);
    const dir = new T.DirectionalLight(0xffffff, 0.75);
    dir.position.set(3, 5, 4);
    const meteorLight = new T.PointLight(0xffffff, 1.6, 40, 1.6);
    scene.add(amb, dir, meteorLight);
    // 径向柔光圆点贴图：Points 默认是硬边方块，挂贴图后火花/拖尾变柔和圆光斑
    const glowTex = (() => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 64;
      const g = cv.getContext('2d');
      const rg = g.createRadialGradient(32, 32, 0, 32, 32, 32);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.35, 'rgba(255,255,255,0.55)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, 64, 64);
      return new T.CanvasTexture(cv);
    })();
    // 流星本体：白炽光球（与岩块碎片明确区分）——光滑球体 + 自发光材质，
    // 火焰感交给外围 Fresnel 电晕/光晕/光刺壳层；本体颜色随主题色、亮度随节拍呼吸
    const coreMat = new T.MeshBasicMaterial({ color: 0xffffff });
    const meteor = new T.Group();           // 组：承接位置/缩放脉冲
    const core = new T.Mesh(new T.SphereGeometry(0.30, 48, 48), coreMat);
    meteor.add(core);
    scene.add(meteor);
    // 能量核心式 Fresnel 边缘电晕：独立 ShaderMaterial 球壳，掠射角增亮（比 onBeforeCompile 更稳）
    const fresMat = new T.ShaderMaterial({
      uniforms: { uCol: { value: new T.Color(0xffffff) }, uPow: { value: 2.2 }, uAmp: { value: 1.6 } },
      vertexShader: `varying vec3 vN; varying vec3 vV;
        void main(){ vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uCol; uniform float uPow; uniform float uAmp; varying vec3 vN; varying vec3 vV;
        void main(){ float f = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), uPow); gl_FragColor = vec4(uCol * f * uAmp, f); }`,
      transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.FrontSide
    });
    const fres = new T.Mesh(new T.SphereGeometry(0.34, 48, 48), fresMat);
    meteor.add(fres);
    // 流星外壳光晕（略大的半透明加色球）
    const haloMat = new T.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.30,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const halo = new T.Mesh(new T.SphereGeometry(0.52, 32, 32), haloMat);
    meteor.add(halo);
    // 能量核心式电晕放射线：一圈细长加色面片从流星向外辐射，随高频闪烁、鼓点增亮
    // 顶点色从根部（亮）渐变到尖端（暗），加色混合下形成柔和光刺，而非硬边线条
    const RAY_N = 20;
    const rayGroup = new T.Group();
    for (let i = 0; i < RAY_N; i++) {
      const phi = Math.acos(1 - 2 * (i + 0.5) / RAY_N);
      const theta = Math.PI * (1 + Math.sqrt(5)) * i;
      const dir = new T.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta));
      const rGeo = new T.PlaneGeometry(0.03, 0.46, 1, 4);
      // 顶点色渐变：根部（y=-0.23）最亮，尖端（y=+0.23）渐隐
      const pos = rGeo.getAttribute('position');
      const cols = new Float32Array(pos.count * 3);
      for (let v = 0; v < pos.count; v++) {
        const y = pos.getY(v);            // -0.23 .. +0.23
        const t = (y + 0.23) / 0.46;      // 0=根, 1=尖
        const a = Math.pow(1 - t, 1.6);   // 根部亮，尖端渐隐
        cols[v * 3] = a; cols[v * 3 + 1] = a; cols[v * 3 + 2] = a;
      }
      rGeo.setAttribute('color', new T.BufferAttribute(cols, 3));
      const rayMat = new T.MeshBasicMaterial({
        vertexColors: true, transparent: true, opacity: 0.9, side: T.DoubleSide,
        blending: T.AdditiveBlending, depthWrite: false
      });
      const ray = new T.Mesh(rGeo, rayMat);
      ray.position.copy(dir.clone().multiplyScalar(0.50));
      ray.lookAt(ray.position.clone().add(dir));
      ray.rotateZ(Math.random() * Math.PI);
      ray.userData.dir = dir;
      ray.userData.phase = Math.random() * TAU;
      rayGroup.add(ray);
    }
    meteor.add(rayGroup);
    // 流星拖尾：相机朝向的连续带状网格（ribbon），头部白炽、尾部渐隐成主题色，
    // 宽度从头向尾收拢并随低频脉动；加色混合下黑色即透明，比圆点粒子更连贯
    const TRAIL_N = this._TRAIL_MAX;
    const trailGeo = new T.BufferGeometry();
    const trailPos = new Float32Array(TRAIL_N * 2 * 3);
    const trailCol = new Float32Array(TRAIL_N * 2 * 3);
    trailGeo.setAttribute('position', new T.BufferAttribute(trailPos, 3));
    trailGeo.setAttribute('color', new T.BufferAttribute(trailCol, 3));
    const tIdx = new Uint32Array((TRAIL_N - 1) * 6);
    for (let i = 0; i < TRAIL_N - 1; i++) {
      const a = i * 2;
      tIdx.set([a, a + 1, a + 2, a + 1, a + 3, a + 2], i * 6);
    }
    trailGeo.setIndex(new T.BufferAttribute(tIdx, 1));
    const trailMat = new T.MeshBasicMaterial({
      vertexColors: true, transparent: true, side: T.DoubleSide,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const trail = new T.Mesh(trailGeo, trailMat);
    trail.frustumCulled = false;
    scene.add(trail);
    // 爆炸碎片：加色发光点云（主碎片，数量多）
    const MAX_FRAG = 2400;
    const fragGeo = new T.BufferGeometry();
    const fragPos = new Float32Array(MAX_FRAG * 3);
    const fragCol = new Float32Array(MAX_FRAG * 3);
    fragGeo.setAttribute('position', new T.BufferAttribute(fragPos, 3));
    fragGeo.setAttribute('color', new T.BufferAttribute(fragCol, 3));
    fragGeo.setDrawRange(0, 0);
    const fragMat = new T.PointsMaterial({
      size: 0.13, sizeAttenuation: true, vertexColors: true, map: glowTex,
      transparent: true, opacity: 1, depthWrite: false, blending: T.AdditiveBlending
    });
    const fragPoints = new T.Points(fragGeo, fragMat);
    fragPoints.frustumCulled = false;
    scene.add(fragPoints);
    // 3D 陨石碎片池：两种噪声岩块几何 × InstancedMesh（实例色做灼热→冷却渐变，
    // 非均匀缩放 + 随机朝向制造碎块差异；岩石 PBR 材质 + 环境反射 → 光追质感）
    const rockGeoA = this._rockGeo(T, 0.075, 1, 3.1, false);
    const rockGeoB = this._rockGeo(T, 0.075, 1, 9.7, false);
    const rockMat = new T.MeshStandardMaterial({
      color: 0xffffff, metalness: 0.2, roughness: 0.68,
      emissive: 0x2a2e36, emissiveIntensity: 0.4,   // 微弱自发光托底，冷却碎块在暗场中仍有轮廓
      envMap: env, envMapIntensity: 1.1, flatShading: true
    });
    const mkRockPool = (g) => {
      const im = new T.InstancedMesh(g, rockMat, MAX_FRAG);
      im.instanceMatrix.setUsage(T.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      const zero = new T.Color(0x000000);
      for (let i = 0; i < MAX_FRAG; i++) im.setColorAt(i, zero); // 触发 instanceColor 分配
      im.instanceColor.setUsage(T.DynamicDrawUsage);
      scene.add(im);
      return im;
    };
    const rockPools = [mkRockPool(rockGeoA), mkRockPool(rockGeoB)];
    // 矩阵/颜色合成暂存（每帧复用，避免 GC）
    const scratch = {
      m4: new T.Matrix4(), q4: new T.Quaternion(),
      s3: new T.Vector3(), c3: new T.Color()
    };

    // ========== 宇宙背景：星空 / 银河 / 星云（营造在宇宙中飞行的穿越感） ==========
    // 星空：环绕流星的可回收星点盒（流星飞行时星点从身边掠过，出盒则回收到前方）
    const STAR_N = 4200, STAR_BOX = 42;
    const starGeo = new T.BufferGeometry();
    const sPos = new Float32Array(STAR_N * 3);
    const sCol = new Float32Array(STAR_N * 3);
    const sSize = new Float32Array(STAR_N);
    for (let i = 0; i < STAR_N; i++) {
      sPos[i * 3] = (Math.random() - 0.5) * STAR_BOX * 2;
      sPos[i * 3 + 1] = (Math.random() - 0.5) * STAR_BOX * 2;
      sPos[i * 3 + 2] = (Math.random() - 0.5) * STAR_BOX * 2;
      const c = Math.random();
      let r = 1, g = 1, b = 1;
      if (c < 0.16) { r = 0.7; g = 0.82; b = 1.0; }          // 蓝白
      else if (c < 0.26) { r = 1.0; g = 0.93; b = 0.7; }      // 暖黄
      else if (c < 0.30) { r = 1.0; g = 0.75; b = 0.7; }      // 淡红
      sCol[i * 3] = r; sCol[i * 3 + 1] = g; sCol[i * 3 + 2] = b;
      sSize[i] = 0.5 + Math.random() * 1.8;
    }
    starGeo.setAttribute('position', new T.BufferAttribute(sPos, 3));
    starGeo.setAttribute('color', new T.BufferAttribute(sCol, 3));
    starGeo.setAttribute('size', new T.BufferAttribute(sSize, 1));
    const starMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float size; attribute vec3 color; varying vec3 vCol; varying float vTw; uniform float uTime;
        void main(){
          vCol = color;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          float tw = 0.7 + 0.3 * sin(uTime * 2.0 + position.x * 13.0 + position.y * 7.0);
          vTw = tw;
          gl_PointSize = size * (300.0 / max(-mv.z, 1.0)) * tw;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vCol; varying float vTw;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          float a = smoothstep(0.5, 0.0, d);
          a = pow(a, 1.6);
          gl_FragColor = vec4(vCol * (0.3 + vTw * 0.35), a);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending, vertexColors: true
    });
    const stars = new T.Points(starGeo, starMat);
    stars.frustumCulled = false;
    scene.add(stars);

    // 银河：远处倾斜的盘状星带（中心黄 → 边缘蓝，轻微螺旋臂）
    const GAL_N = 1800, GAL_R = 160;
    const galGeo = new T.BufferGeometry();
    const gPos = new Float32Array(GAL_N * 3);
    const gCol = new Float32Array(GAL_N * 3);
    for (let i = 0; i < GAL_N; i++) {
      const r = Math.pow(Math.random(), 0.5) * GAL_R;
      const ang = Math.random() * TAU + r * 0.018;                 // 轻微螺旋
      const thick = (1 - r / GAL_R) * 14 + 2;
      gPos[i * 3] = Math.cos(ang) * r;
      gPos[i * 3 + 1] = (Math.random() - 0.5) * thick;
      gPos[i * 3 + 2] = Math.sin(ang) * r;
      const tr = r / GAL_R;
      gCol[i * 3] = 1.0 - tr * 0.3;
      gCol[i * 3 + 1] = 0.96 - tr * 0.25;
      gCol[i * 3 + 2] = 0.82 + tr * 0.18;
    }
    galGeo.setAttribute('position', new T.BufferAttribute(gPos, 3));
    galGeo.setAttribute('color', new T.BufferAttribute(gCol, 3));
    const galMat = new T.PointsMaterial({
      size: 2.0, sizeAttenuation: true, vertexColors: true, map: glowTex,
      transparent: true, opacity: 0.85, depthWrite: false, blending: T.AdditiveBlending
    });
    const galaxy = new T.Points(galGeo, galMat);
    galaxy.rotation.x = 1.05; galaxy.rotation.z = 0.4;
    scene.add(galaxy);

    // 星云：大号柔光精灵（彩色宇宙云团）
    const hue0 = this.mgr.pal.hue;
    const makeNebTex = (h) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const g = cv.getContext('2d');
      const rg = g.createRadialGradient(128, 128, 0, 128, 128, 128);
      rg.addColorStop(0, `hsla(${h}, 80%, 65%, 0.55)`);
      rg.addColorStop(0.35, `hsla(${h}, 70%, 52%, 0.20)`);
      rg.addColorStop(1, `hsla(${h}, 70%, 40%, 0)`);
      g.fillStyle = rg; g.fillRect(0, 0, 256, 256);
      return new T.CanvasTexture(cv);
    };
    const nebGroup = new T.Group();
    const nebulae = [];
    for (let i = 0; i < 8; i++) {
      const h = (hue0 + Math.random() * 100) % 360;
      const tex = makeNebTex(h);
      const mat = new T.SpriteMaterial({ map: tex, transparent: true, opacity: 0.22, blending: T.AdditiveBlending, depthWrite: false });
      const sp = new T.Sprite(mat);
      const s = 50 + Math.random() * 70;
      sp.scale.set(s, s, 1);
      sp.position.set((Math.random() - 0.5) * STAR_BOX * 1.6, (Math.random() - 0.5) * 30, (Math.random() - 0.5) * STAR_BOX * 1.6);
      nebGroup.add(sp);
      nebulae.push({ sprite: sp, base: sp.position.clone() });
    }
    scene.add(nebGroup);

    this._r3 = {
      renderer, scene, camera, env, amb, dir, meteorLight,
      meteor, core, coreMat, fres, fresMat, halo, haloMat, rayGroup,
      trail, trailMat, trailGeo,
      fragPoints, fragMat, fragGeo, fragPos, fragCol, MAX_FRAG,
      rockPools, scratch,
      // 宇宙背景
      stars, starMat, starGeo, sPos, STAR_N, STAR_BOX,
      galaxy, galMat,
      nebGroup, nebulae
    };
    // 初始化流星位置/速度
    this._mPos = new T.Vector3(0, 0, 0);
    this._mVel = new T.Vector3(0.6, 0.3, 0.2);
    // 相机初始放在流星后方，之后由环绕逻辑接管
    camera.position.set(0.8, 1.2, -7.5);
    camera.lookAt(0, 0, 4);
  }
  _resize3(w, h) {
    const r3 = this._r3;
    r3.renderer.setSize(w, h, false);
    r3.camera.aspect = w / h;
    r3.camera.updateProjectionMatrix();
  }
  /* 生成一枚 3D 陨石碎片：位置/速度 + 随机翻滚轴速 + 非均匀缩放 + 灼热→冷却实例色 */
  _mkFrag(px, py, pz, vx, vy, vz, { max, scl, hotHue, glow, col }) {
    const T = this._THREE;
    const ax = new T.Vector3(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5);
    if (ax.lengthSq() < 1e-6) ax.set(1, 0, 0); else ax.normalize();
    return {
      pos: new T.Vector3(px, py, pz), vel: new T.Vector3(vx, vy, vz),
      life: 0, max,
      col,                                   // 辉光点颜色（glow=true 时写入火花点云）
      pool: Math.random() < 0.5 ? 0 : 1,     // 两种岩块几何池
      rotAxis: ax, rotSpd: (2 + Math.random() * 6) * (Math.random() < 0.5 ? -1 : 1), rotAng: Math.random() * TAU,
      scl, stretch: [0.65 + Math.random() * 0.8, 0.65 + Math.random() * 0.8, 0.65 + Math.random() * 0.8],
      tintHot: new T.Color().setHSL((((hotHue + Math.random() * 24 - 12) % 360) + 360) % 360 / 360, 0.9, 0.70),
      tintCold: new T.Color().setHSL(0.06 + Math.random() * 0.05, 0.20 + Math.random() * 0.12, 0.24 + Math.random() * 0.16),
      glow
    };
  }
  /* 节拍爆炸：在流星当前位置生成碎片，扩散半径 ∝ 节拍能量 */
  _explode(intensity) {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    const cfg = this.mgr.collideCfg || { count: 1300, rest: 0.92, shock: 1, trail: 0.45 };
    const n = Math.min(r3.MAX_FRAG - this._frags.length, Math.round(cfg.count));
    if (n <= 0) return;
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const baseSpeed = intensity * (2.2 + this._bass * 3.5) * (cfg.shock ?? 1);
    const spread = 0.6 + intensity * 1.4;             // 大节奏扩散大
    for (let i = 0; i < n; i++) {
      // 球均匀随机方向
      let dx, dy, dz, d2;
      do { dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1; d2 = dx * dx + dy * dy + dz * dz; } while (d2 > 1 || d2 < 1e-6);
      const inv = 1 / Math.sqrt(d2);
      const sp = baseSpeed * (0.25 + Math.random() * 0.95) * spread;
      const col = Math.random() < 0.5 ? hslToRgb(hue, 0.9, 0.7) : hslToRgb(hue2, 0.9, 0.72);
      // 全部碎片为 3D 岩块（InstancedMesh 实例），30% 附带辉光火花点
      this._frags.push(this._mkFrag(
        this._mPos.x, this._mPos.y, this._mPos.z,
        dx * inv * sp, dy * inv * sp, dz * inv * sp,
        {
          max: 0.7 + Math.random() * 0.9, scl: 0.5 + Math.random() * 1.1,
          hotHue: Math.random() < 0.5 ? hue : hue2, glow: Math.random() < 0.3,
          col: [sLin(col[0]), sLin(col[1]), sLin(col[2])]
        }
      ));
    }
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.collideCfg || { count: 1300, rest: 0.92, shock: 1, trail: 0.45 };
    // 节拍能量（大节奏扩散大，小节奏扩散小）
    if (bands.beat) {
      this._beat = 1;
      this._beatE = clamp(0.4 + (bands.bass || 0) * 1.2 + (bands.beat || 1) * 0.6, 0.15, 2.5);
      this._explode(this._beatE);
    }
    this._beat *= Math.pow(0.03, dt);
    const k = Math.min(1, dt * 9);
    this._bass += ((bands.bass || 0) - this._bass) * k;
    this._mid += ((bands.mid || 0) - this._mid) * k;
    this._tre += ((bands.treble || 0) - this._tre) * k;

    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    // —— 2D 背景：深空渐变（宇宙飞行场景需保持画面干净、背景黑暗，星空才清晰可见）——
    const trailAmt = clamp(cfg.trail ?? 0.45, 0, 0.9);
    ctx.globalAlpha = Math.max(0.9, 1 - trailAmt * 0.18);   // 仅极轻微拖尾，避免碎片累积洗白星空
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.8);
    bg.addColorStop(0, `hsla(${hue}, 60%, 5%, 1)`);
    bg.addColorStop(1, 'hsla(0,0%,0.5%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'lighter';
    for (const d of this.dust) {
      d.ph += d.sp * dt;
      const tw = 0.3 + 0.7 * Math.abs(Math.sin(d.ph));
      ctx.fillStyle = `hsla(${hue2}, 90%, 85%, ${tw * 0.3 * d.z})`;
      ctx.beginPath(); ctx.arc(d.x * w, d.y * h, 0.7 + d.z * 1.4, 0, TAU); ctx.fill();
    }
    // 节拍全屏微闪
    if (this._beat > 0.02) {
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${this._beat * 0.08})`;
      ctx.fillRect(0, 0, w, h);
    }
    ctx.globalCompositeOperation = 'source-over';

    const r3 = this._ensureThree();
    if (!r3) return;
    const T = this._THREE;

    // —— 流星运动：在宇宙中持续向前飞行（z 轴推进 + x/y 轻柔弯曲漂移，无硬边界反射）——
    // 偶尔给侧向速度一个随机扰动，制造弯曲轨迹
    if (Math.random() < dt * 0.8) {
      this._mVel.x += (Math.random() - 0.5) * dt * 2.5;
      this._mVel.y += (Math.random() - 0.5) * dt * 2.5;
    }
    // 前向速度由中频驱动加速，保持持续推进感
    const targetFwd = 1.8 + this._mid * 3.0;
    this._mVel.z += (targetFwd - this._mVel.z) * Math.min(1, dt * 0.8);
    // 侧向阻尼，避免越飘越远
    this._mVel.x *= Math.pow(0.4, dt);
    this._mVel.y *= Math.pow(0.4, dt);
    // 若 x/y 偏离过远，柔和回拉（软边界，不反弹）
    if (Math.abs(this._mPos.x) > 9) this._mVel.x -= Math.sign(this._mPos.x) * dt * 3;
    if (Math.abs(this._mPos.y) > 7) this._mVel.y -= Math.sign(this._mPos.y) * dt * 3;
    this._mPos.addScaledVector(this._mVel, dt);
    r3.meteor.position.copy(this._mPos);
    r3.meteorLight.position.copy(this._mPos);
    // 光球本体：颜色随主题色，白炽度随节拍/低频呼吸 + 高频抖动模拟火焰不稳定
    const fl = 0.55 + this._beat * 0.45 + this._bass * 0.30 + Math.sin(t * 23.0) * 0.07 + Math.sin(t * 41.0) * 0.05;
    r3.coreMat.color.setHSL(hue / 360, 0.45, clamp(0.55 + fl * 0.35, 0, 0.93));
    r3.core.scale.setScalar(1 + this._bass * 0.10 + this._beat * 0.18 + Math.sin(t * 17.0) * 0.035);
    // 整体轻微呼吸脉冲（光球+壳层同步，形变克制）
    const pulse = 1 + this._bass * 0.09 + this._beat * 0.16;
    r3.meteor.scale.setScalar(pulse);
    r3.haloMat.opacity = 0.10 + this._beat * 0.28 + this._bass * 0.16;
    r3.halo.scale.setScalar(1 + this._beat * 0.5 + this._bass * 0.3);
    r3.meteorLight.intensity = 1.6 + this._beat * 2.6 + this._bass * 1.2;
    r3.meteorLight.color.setHSL(hue / 360, 0.8, 0.6);
    // Fresnel 电晕：颜色跟主题色，强度随鼓点爆发（能量核心式边缘辉光）
    r3.fresMat.uniforms.uAmp.value = 0.7 + this._beat * 1.3 + this._bass * 0.6;
    r3.fresMat.uniforms.uCol.value.setHSL(hue / 360, 0.9, 0.6 + this._beat * 0.25);
    // 电晕放射线：缓慢自转 + 高频闪烁 + 鼓点伸长增亮
    r3.rayGroup.rotation.y += dt * 0.6;
    r3.rayGroup.rotation.x += dt * 0.3;
    const rayPulse = 1 + this._tre * 0.5 + this._beat * 1.2;
    r3.rayGroup.children.forEach((ray, i) => {
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(t * 3.0 + ray.userData.phase));
      ray.material.opacity = (0.15 + tw * 0.45) * (0.6 + this._beat * 0.8);
      ray.scale.set(1, rayPulse * (0.7 + 0.3 * tw), 1);
      ray.material.color.setHSL((hue + i * 8) / 360, 0.85, 0.6);
    });

    // —— 流星拖尾：沿路径重建相机朝向的带状网格 ——
    // 每帧从 _mTrail 环缓冲取点，侧向 = 路径方向 × 指向相机，形成始终面向镜头的光带
    this._mTrail.unshift(this._mPos.clone());
    if (this._mTrail.length > this._TRAIL_MAX) this._mTrail.pop();
    const tPos = r3.trailGeo.getAttribute('position').array;
    const tCol = r3.trailGeo.getAttribute('color').array;
    const tr = trailAmt * 0.9 + 0.25;
    const camP = r3.camera.position;
    const headW = 0.30 + this._bass * 0.22 + this._beat * 0.18;   // 头部宽度随低频/节拍脉动
    // 头部白炽 → 尾部主题色 → 黑（加色混合下黑即透明）
    if (!this._trTmp) {
      this._trTmp = {
        dir: new T.Vector3(), side: new T.Vector3(), toCam: new T.Vector3(), off: new T.Vector3(),
        headC: new T.Color(), tailC: new T.Color(), cc: new T.Color()
      };
    }
    const tmp = this._trTmp;
    tmp.headC.setHSL(hue / 360, 0.30, 0.88);
    tmp.tailC.setHSL(hue2 / 360, 0.85, 0.42);
    const N = this._TRAIL_MAX;
    const lastP = this._mTrail[this._mTrail.length - 1];
    for (let i = 0; i < N; i++) {
      const p = this._mTrail[i] || lastP;
      const i6 = i * 6;
      if (!p) { for (let k2 = 0; k2 < 6; k2++) { tPos[i6 + k2] = 0; tCol[i6 + k2] = 0; } continue; }
      // 路径切线方向（前一点 - 后一点）
      const pp = this._mTrail[i - 1] || p, pn = this._mTrail[i + 1] || p;
      tmp.dir.subVectors(pp, pn);
      tmp.toCam.subVectors(camP, p);
      tmp.side.crossVectors(tmp.dir, tmp.toCam);
      if (tmp.side.lengthSq() < 1e-8) tmp.side.set(0, 1, 0); else tmp.side.normalize();
      const tt = i / (N - 1);                          // 0=头 1=尾
      const wdt = headW * Math.pow(1 - tt, 1.35) + 0.012;
      tmp.off.copy(tmp.side).multiplyScalar(wdt);
      tPos[i6] = p.x - tmp.off.x; tPos[i6 + 1] = p.y - tmp.off.y; tPos[i6 + 2] = p.z - tmp.off.z;
      tPos[i6 + 3] = p.x + tmp.off.x; tPos[i6 + 4] = p.y + tmp.off.y; tPos[i6 + 5] = p.z + tmp.off.z;
      const fade = Math.pow(1 - tt, 1.6) * tr;
      tmp.cc.copy(tmp.headC).lerp(tmp.tailC, Math.pow(tt, 0.65)).multiplyScalar(fade);
      tCol[i6] = tmp.cc.r; tCol[i6 + 1] = tmp.cc.g; tCol[i6 + 2] = tmp.cc.b;
      tCol[i6 + 3] = tmp.cc.r; tCol[i6 + 4] = tmp.cc.g; tCol[i6 + 5] = tmp.cc.b;
    }
    r3.trailGeo.getAttribute('position').needsUpdate = true;
    r3.trailGeo.getAttribute('color').needsUpdate = true;

    // —— 飞行剥蚀：陨石表面持续剥落小碎屑（高频越多剥得越快），周围粒子也是 3D 岩块 ——
    this._shedAcc = (this._shedAcc || 0) + dt * (3 + this._tre * 16);
    while (this._shedAcc >= 1) {
      this._shedAcc -= 1;
      if (this._frags.length >= r3.MAX_FRAG - 8) break;
      const ox = (Math.random() - 0.5) * 0.5, oy = (Math.random() - 0.5) * 0.5, oz = (Math.random() - 0.5) * 0.5;
      const sc = hslToRgb((hue + Math.random() * 30 - 15 + 360) % 360, 0.85, 0.68);
      this._frags.push(this._mkFrag(
        this._mPos.x + ox * 0.4, this._mPos.y + oy * 0.4, this._mPos.z + oz * 0.4,
        this._mVel.x * 0.3 + ox * 2.2, this._mVel.y * 0.3 + oy * 2.2, this._mVel.z * 0.3 + oz * 2.2,
        {
          max: 1.1 + Math.random() * 1.2, scl: 0.18 + Math.random() * 0.3,
          hotHue: hue, glow: Math.random() < 0.25,
          col: [sLin(sc[0]), sLin(sc[1]), sLin(sc[2])]
        }
      ));
    }

    // —— 碎片更新：积分 + 阻尼 + 翻滚 + 灼热冷却 + 写入 InstancedMesh 实例 ——
    const frags = this._frags;
    const drag = Math.pow(clamp(cfg.rest ?? 0.92, 0.5, 1), dt * 4); // rest 越大碎片飞得越远
    const fPos = r3.fragPos, fCol = r3.fragCol;
    const { m4, q4, s3, c3 } = r3.scratch;
    const poolN = [0, 0];
    const camX = r3.camera.position.x, camY = r3.camera.position.y, camZ = r3.camera.position.z;
    let alive = 0;
    for (let i = frags.length - 1; i >= 0; i--) {
      const f = frags[i];
      f.life += dt;
      if (f.life >= f.max) { frags.splice(i, 1); continue; }
      f.vel.multiplyScalar(drag);
      f.pos.addScaledVector(f.vel, dt);
      f.rotAng += f.rotSpd * dt;
      const fadeT = f.life / f.max;
      // 3D 岩块实例：矩阵（位置/翻滚/非均匀缩放，末段缩小消失）+ 实例色（灼热→冷却岩灰）
      // nearFade：碎块漂到相机近处时快速缩没，避免巨块糊屏
      const shrink = fadeT < 0.65 ? 1 : Math.max(0.001, 1 - (fadeT - 0.65) / 0.35);
      const dzc = camZ - f.pos.z, dxc = f.pos.x - camX, dyc = f.pos.y - camY;
      const nearFade = clamp((dzc * dzc + dxc * dxc + dyc * dyc - 0.36) / 1.6, 0, 1);
      const sh = shrink * nearFade;
      q4.setFromAxisAngle(f.rotAxis, f.rotAng);
      s3.set(f.scl * f.stretch[0] * sh, f.scl * f.stretch[1] * sh, f.scl * f.stretch[2] * sh);
      m4.compose(f.pos, q4, s3);
      const pool = r3.rockPools[f.pool], pi = poolN[f.pool]++;
      pool.setMatrixAt(pi, m4);
      const hot = Math.max(0, 1 - fadeT * 1.5);
      c3.copy(f.tintCold).lerp(f.tintHot, hot * hot);
      pool.setColorAt(pi, c3);
      // 30% 碎片附带辉光火花点，写入点云缓冲（alive 顺序压缩）；近相机的火花同样衰减
      if (f.glow && nearFade > 0.03) {
        const a3 = alive * 3;
        fPos[a3] = f.pos.x; fPos[a3 + 1] = f.pos.y; fPos[a3 + 2] = f.pos.z;
        const fade = 1 - fadeT;
        const bright = fade * fade * (1.4 + this._beat * 0.8) * nearFade;
        fCol[a3] = f.col[0] * bright; fCol[a3 + 1] = f.col[1] * bright; fCol[a3 + 2] = f.col[2] * bright;
        alive++;
      }
    }
    for (let p = 0; p < 2; p++) {
      r3.rockPools[p].count = poolN[p];
      r3.rockPools[p].instanceMatrix.needsUpdate = true;
      if (r3.rockPools[p].instanceColor) r3.rockPools[p].instanceColor.needsUpdate = true;
    }
    r3.fragGeo.setDrawRange(0, alive);
    r3.fragGeo.getAttribute('position').needsUpdate = alive > 0;
    r3.fragGeo.getAttribute('color').needsUpdate = alive > 0;
    r3.fragMat.size = 0.1 + this._tre * 0.08 + this._beat * 0.05;

    // —— 星空回收：以流星为中心的星盒，飞出盒子的星点回收到对侧，制造无限穿越 ——
    const sBox = r3.STAR_BOX, sPos = r3.sPos;
    const mx = this._mPos.x, my = this._mPos.y, mz = this._mPos.z;
    for (let i = 0; i < r3.STAR_N; i++) {
      const i3 = i * 3;
      let dx = sPos[i3] - mx, dy = sPos[i3 + 1] - my, dz = sPos[i3 + 2] - mz;
      if (dx > sBox) sPos[i3] -= sBox * 2; else if (dx < -sBox) sPos[i3] += sBox * 2;
      if (dy > sBox) sPos[i3 + 1] -= sBox * 2; else if (dy < -sBox) sPos[i3 + 1] += sBox * 2;
      if (dz > sBox) sPos[i3 + 2] -= sBox * 2; else if (dz < -sBox) sPos[i3 + 2] += sBox * 2;
    }
    r3.starGeo.getAttribute('position').needsUpdate = true;
    r3.starMat.uniforms.uTime.value = t;

    // 银河跟随流星作为远景天幕（缓慢自转，营造星带缓缓流转）
    r3.galaxy.position.set(mx, my, mz);
    r3.galaxy.rotation.z += dt * 0.02;
    r3.galMat.opacity = 0.85 + this._bass * 0.15;

    // 星云回收：飘到流星后方过远则回收到前方
    for (const n of r3.nebulae) {
      const dz = n.sprite.position.z - mz;
      if (dz < -sBox * 1.5) n.sprite.position.z += sBox * 3.2;
      else if (dz > sBox * 1.5) n.sprite.position.z -= sBox * 3.2;
      const dx = n.sprite.position.x - mx;
      if (dx > sBox * 1.6) n.sprite.position.x -= sBox * 3.2;
      else if (dx < -sBox * 1.6) n.sprite.position.x += sBox * 3.2;
      n.sprite.material.opacity = 0.18 + Math.sin(t * 0.3 + n.base.x) * 0.06 + this._bass * 0.1;
    }

    // —— 相机：不再钉死在流星正后方，而是在流星周围缓慢独立环绕 ——
    // 环绕角极慢推进（约 60s 一圈）+ 半径/高度正弦呼吸，视角在侧跟、迎头、俯拍、
    // 追尾之间连续流转；流星相对画面有飞远/飞近/横穿的纵深变化
    if (this._camAng == null) this._camAng = Math.PI * 1.5;      // 初始在后方偏下
    this._camAng += dt * (0.09 + this._mid * 0.04);
    const camR = 6.8 + Math.sin(t * 0.13) * 2.2;                 // 4.6 ~ 9.0 距离呼吸
    const camH = Math.sin(t * 0.09) * 2.6 + 0.6;                 // -2.0 ~ 3.2 俯仰呼吸
    const tx2 = mx + Math.cos(this._camAng) * camR;
    const ty2 = my + camH;
    const tz2 = mz + Math.sin(this._camAng) * camR;
    // 机位平滑趋近（慢阻尼，无任何跳变）
    const ck = Math.min(1, dt * 1.5);
    r3.camera.position.x += (tx2 - r3.camera.position.x) * ck;
    r3.camera.position.y += (ty2 - r3.camera.position.y) * ck;
    r3.camera.position.z += (tz2 - r3.camera.position.z) * ck;
    // 注视点：流星本体附近、沿速度方向少量提前，保证流星始终在画面内且有前进纵深感
    r3.camera.lookAt(mx + this._mVel.x * 0.5, my + this._mVel.y * 0.5, mz + 1.1);

    // —— 渲染 ——
    r3.renderer.render(r3.scene, r3.camera);
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
  }
}

/* ---------- 场景九：声波涟漪（2026-10-14 重做：赛博霓虹 3D 频谱环 + 漂浮线框三角 + 水面反射）
   中心巨大粉紫发光线框圆环（TorusGeometry 3D 厚度），外缘锯齿频谱凸起随节拍起伏，环身带细密点状灯带；
   大量空心线框三角形在 3D 空间漂浮穿梭（近大远小，部分朝镜头飞、部分后退）；深空星空底色；
   画面下方水面，圆环/霓虹在水面形成扭曲倒影，波光随鼓点晃动；全部自发光线框材质，无实体表面；
   配置：波高 amp（频谱凸起幅度）/ 涟漪 rip（水面波纹强度）/ 流速 spd（旋转与漂移速度） ---------- */
class WaveScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0; this._bass = 0; this._mid = 0; this._tre = 0;
    this._r3 = null; this._r3Dead = false; this._r3Loading = null; this._THREE = null;
    this._triData = [];     // 三角形数据：pos, vel, rot, rotSpd, size
    this._spectrumArr = null;
  }
  resize() { if (this._r3) this._resize3(this.mgr.w, this.mgr.h); }
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('WaveScene: three 加载失败，声波涟漪降级为深色底。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;
  }
  _init3() {
    const T = this._THREE;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: false, powerPreference: 'high-performance' });
    renderer.setClearColor(0x04030a, 1);
    const w = Math.max(2, this.mgr.w || 640);
    const h = Math.max(2, this.mgr.h || 360);
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);

    const scene = new T.Scene();
    scene.fog = new T.FogExp2(0x04030a, 0.06);

    const camera = new T.PerspectiveCamera(55, w / h, 0.1, 100);
    camera.position.set(0, 1.6, 7.5);
    camera.lookAt(0, 0, 0);

    // —— 星空：深空球壳星点 ——
    const starN = 900;
    const starPos = new Float32Array(starN * 3);
    for (let i = 0; i < starN; i++) {
      const r = 30 + Math.random() * 20;
      const th = Math.random() * TAU, ph = Math.acos(2 * Math.random() - 1);
      starPos[i * 3] = r * Math.sin(ph) * Math.cos(th);
      starPos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
      starPos[i * 3 + 2] = r * Math.cos(ph);
    }
    const starGeo = new T.BufferGeometry();
    starGeo.setAttribute('position', new T.BufferAttribute(starPos, 3));
    const starMat = new T.PointsMaterial({ size: 0.12, color: 0xffffff, transparent: true, opacity: 0.85, sizeAttenuation: true });
    const stars = new T.Points(starGeo, starMat);
    scene.add(stars);

    // —— 中心霓虹圆环：TorusGeometry 线框（3D 厚度）——
    const RING_R = 1.7;
    const TUBE_R = 0.09;
    const TUBULAR = 160, RADIAL = 8;
    const torusGeo = new T.TorusGeometry(RING_R, TUBE_R, RADIAL, TUBULAR);
    const torusMat = new T.MeshBasicMaterial({
      color: 0xff4fd8, wireframe: true, transparent: true, opacity: 0.85,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const torus = new T.Mesh(torusGeo, torusMat);
    torus.rotation.x = -0.12;
    scene.add(torus);

    // —— 频谱凸起：环上一圈径向小条（InstancedMesh），高度随音频 bin 起伏 ——
    const BARS = 96;
    const barGeo = new T.BoxGeometry(0.035, 1, 0.035);
    const barMat = new T.MeshBasicMaterial({
      color: 0xc77dff, transparent: true, opacity: 0.9,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const bars = new T.InstancedMesh(barGeo, barMat, BARS);
    bars.instanceMatrix.setUsage(T.DynamicDrawUsage);
    const dummy = new T.Object3D();
    for (let i = 0; i < BARS; i++) {
      const ang = (i / BARS) * TAU;
      dummy.position.set(Math.cos(ang) * (RING_R + 0.12), Math.sin(ang) * (RING_R + 0.12), 0);
      dummy.rotation.z = ang;
      dummy.scale.set(1, 0.05, 1);
      dummy.updateMatrix();
      bars.setMatrixAt(i, dummy.matrix);
    }
    bars.instanceMatrix.needsUpdate = true;
    scene.add(bars);

    // —— 点状灯带：沿环身细密发光点 ——
    const DOT_N = 160;
    const dotPos = new Float32Array(DOT_N * 3);
    for (let i = 0; i < DOT_N; i++) {
      const ang = (i / DOT_N) * TAU;
      dotPos[i * 3] = Math.cos(ang) * RING_R;
      dotPos[i * 3 + 1] = Math.sin(ang) * RING_R;
      dotPos[i * 3 + 2] = 0;
    }
    const dotGeo = new T.BufferGeometry();
    dotGeo.setAttribute('position', new T.BufferAttribute(dotPos, 3));
    const dotMat = new T.PointsMaterial({
      size: 0.09, color: 0xff9af0, transparent: true, opacity: 0.95,
      blending: T.AdditiveBlending, depthWrite: false, sizeAttenuation: true
    });
    const dots = new T.Points(dotGeo, dotMat);
    scene.add(dots);

    // —— 漂浮线框三角形：空心描边，3D 空间穿梭 ——
    const TRI_N = 70;
    const triGroup = new T.Group();
    const triMat = new T.LineBasicMaterial({
      color: 0xd88bff, transparent: true, opacity: 0.7,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const triShapeGeo = new T.BufferGeometry();
    const s = 0.32;
    triShapeGeo.setAttribute('position', new T.BufferAttribute(new Float32Array([
      0, s, 0, -s * 0.866, -s * 0.5, 0, s * 0.866, -s * 0.5, 0
    ]), 3));
    triShapeGeo.setIndex([0, 1, 1, 2, 2, 0]);
    for (let i = 0; i < TRI_N; i++) {
      const line = new T.LineSegments(triShapeGeo, triMat.clone());
      const pos = new T.Vector3(
        (Math.random() - 0.5) * 9,
        (Math.random() - 0.5) * 5,
        (Math.random() - 0.5) * 10 - 2
      );
      line.position.copy(pos);
      const sz = 0.3 + Math.random() * 1.4;
      line.scale.setScalar(sz);
      line.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
      triGroup.add(line);
      this._triData.push({
        mesh: line,
        vel: new T.Vector3((Math.random() - 0.5) * 0.4, (Math.random() - 0.5) * 0.3, (Math.random() - 0.5) * 1.8),
        rotSpd: new T.Vector3((Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2, (Math.random() - 0.5) * 1.2),
        baseSize: sz
      });
    }
    scene.add(triGroup);

    // —— 水面：带反射贴图 + 波纹扭曲 ——
    const waterY = -2.6;
    const rt = new T.WebGLRenderTarget(w, h, { minFilter: T.LinearFilter, magFilter: T.LinearFilter });
    const mirrorCam = new T.PerspectiveCamera(55, w / h, 0.1, 100);
    const waterGeo = new T.PlaneGeometry(40, 14, 1, 1);
    const waterMat = new T.ShaderMaterial({
      uniforms: {
        tReflect: { value: rt.texture },
        uTime: { value: 0 },
        uRipple: { value: 0.5 },
        uCol: { value: new T.Color(0x2a1050) }
      },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `uniform sampler2D tReflect; uniform float uTime; uniform float uRipple; uniform vec3 uCol; varying vec2 vUv;
        void main(){
          vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
          float d = sin(uv.x*40.0 + uTime*2.2)*0.004*uRipple + sin(uv.y*30.0 - uTime*1.7)*0.003*uRipple;
          uv += vec2(d, d*0.8);
          vec3 refl = texture2D(tReflect, uv).rgb;
          float fade = smoothstep(0.0, 0.35, vUv.y);
          vec3 col = refl * 0.55 * fade + uCol * (1.0 - fade*0.6) * 0.5;
          col += uCol * 0.06 * uRipple;
          gl_FragColor = vec4(col, 1.0);
        }`,
      transparent: false
    });
    const water = new T.Mesh(waterGeo, waterMat);
    water.rotation.x = -Math.PI / 2;
    water.position.y = waterY;
    scene.add(water);

    // —— 中心辉光（随低频脉动的加色光球）——
    const glowGeo = new T.SphereGeometry(0.6, 24, 24);
    const glowMat = new T.MeshBasicMaterial({
      color: 0xff5fd0, transparent: true, opacity: 0.25,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const glow = new T.Mesh(glowGeo, glowMat);
    scene.add(glow);

    this._r3 = {
      renderer, scene, camera, mirrorCam, rt, waterY,
      stars, torus, torusMat, bars, dots, dotMat, triGroup, glow, glowMat, water, waterMat,
      RING_R, BARS, TRI_N, dummy
    };
    this._spectrumArr = new Float32Array(BARS);
  }
  _resize3(w, h) {
    const r3 = this._r3;
    r3.renderer.setSize(w, h, false);
    r3.camera.aspect = w / h;
    r3.camera.updateProjectionMatrix();
    r3.mirrorCam.aspect = w / h;
    r3.mirrorCam.updateProjectionMatrix();
    r3.rt.setSize(w, h);
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.waveCfg || { amp: 1, rip: 1, spd: 1 };
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.04, dt);
    const k = Math.min(1, dt * 8);
    this._bass += ((bands.bass || 0) - this._bass) * k;
    this._mid += ((bands.mid || 0) - this._mid) * k;
    this._tre += ((bands.treble || 0) - this._tre) * k;

    const r3 = this._ensureThree();
    if (!r3) { ctx.fillStyle = '#04030a'; ctx.fillRect(0, 0, w, h); return; }

    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const cA = hslToRgb(hue, 0.9, 0.65);
    const cB = hslToRgb(hue2, 0.85, 0.62);

    // —— 圆环：随节拍旋转 + 呼吸脉动 ——
    const spd = cfg.spd;
    r3.torus.rotation.z += dt * 0.08 * spd;
    const pulse = 1 + this._bass * 0.12 * cfg.amp + this._beat * 0.08;
    r3.torus.scale.setScalar(pulse);
    r3.torusMat.color.setRGB(sLin(cB[0]), sLin(cB[1]), sLin(cB[2]));
    r3.torusMat.opacity = 0.7 + this._beat * 0.3 + this._bass * 0.2;

    // —— 频谱凸起：从 bins 采样，每根条高度 ∝ 对应频段 ——
    const nBins = bins ? bins.length : 0;
    for (let i = 0; i < r3.BARS; i++) {
      const ang = (i / r3.BARS) * TAU;
      const r = r3.RING_R + 0.14;
      r3.dummy.position.set(Math.cos(ang) * r, Math.sin(ang) * r, 0);
      r3.dummy.rotation.z = ang;
      // 取频谱段：低频集中在前半，高频在后
      let v = 0.05;
      if (nBins > 0) {
        const idx = Math.floor((i / r3.BARS) * (nBins * 0.7));
        v = bins[idx] || 0;
      }
      const hgt = 0.05 + Math.pow(v, 0.85) * 1.4 * cfg.amp * (1 + this._beat * 0.4);
      r3.dummy.scale.set(1, hgt, 1);
      r3.dummy.updateMatrix();
      r3.bars.setMatrixAt(i, r3.dummy.matrix);
    }
    r3.bars.instanceMatrix.needsUpdate = true;
    r3.bars.material.color.setRGB(sLin(cA[0]), sLin(cA[1]), sLin(cA[2]));

    // —— 点状灯带：随高频闪烁 ——
    r3.dotMat.opacity = 0.7 + this._tre * 0.3 + this._beat * 0.2;
    r3.dots.rotation.z = r3.torus.rotation.z;
    r3.dotMat.color.setRGB(sLin(cB[0]), sLin(cB[1]), sLin(cB[2]));

    // —— 漂浮三角形：旋转 + 3D 漂移（朝镜头/后退），越界回收 ——
    for (const td of this._triData) {
      const m = td.mesh;
      m.position.addScaledVector(td.vel, dt * spd);
      m.rotation.x += td.rotSpd.x * dt * spd;
      m.rotation.y += td.rotSpd.y * dt * spd;
      m.rotation.z += td.rotSpd.z * dt * spd;
      // 越界回收
      if (m.position.z > 5 || m.position.z < -8 || Math.abs(m.position.x) > 5.5 || Math.abs(m.position.y) > 4) {
        m.position.set(
          (Math.random() - 0.5) * 9,
          (Math.random() - 0.5) * 5,
          -6 + Math.random() * 2
        );
        td.vel.z = 0.5 + Math.random() * 1.6;
      }
      const mat = m.material;
      mat.color.setRGB(sLin(cA[0]), sLin(cA[1]), sLin(cA[2]));
      mat.opacity = (0.4 + this._tre * 0.4) * (m.position.z > 0 ? Math.min(1, 2 - m.position.z * 0.3) : 1);
    }

    // —— 中心辉光 ——
    r3.glow.scale.setScalar(1 + this._bass * 0.6 * cfg.amp + this._beat * 0.3);
    r3.glowMat.opacity = 0.18 + this._bass * 0.3 + this._beat * 0.2;
    r3.glowMat.color.setRGB(sLin(cB[0]), sLin(cB[1]), sLin(cB[2]));

    // —— 水面波纹强度 ——
    r3.waterMat.uniforms.uTime.value = t;
    r3.waterMat.uniforms.uRipple.value = 0.4 + cfg.rip * (0.5 + this._beat * 1.2 + this._bass * 0.5);
    r3.waterMat.uniforms.uCol.value.setRGB(sLin(cA[0]) * 0.3, sLin(cA[1]) * 0.15, sLin(cA[2]) * 0.5);

    // —— 反射渲染：镜像相机，水面以上场景渲染到 RT ——
    r3.water.visible = false;
    r3.mirrorCam.position.copy(r3.camera.position);
    r3.mirrorCam.position.y = 2 * r3.waterY - r3.camera.position.y;
    r3.mirrorCam.up.set(0, -1, 0);
    const tgtY = 2 * r3.waterY;
    r3.mirrorCam.lookAt(0, tgtY, 0);
    r3.renderer.setRenderTarget(r3.rt);
    r3.renderer.render(r3.scene, r3.mirrorCam);
    r3.renderer.setRenderTarget(null);
    r3.water.visible = true;
    r3.camera.up.set(0, 1, 0);

    // —— 主渲染 ——
    r3.renderer.render(r3.scene, r3.camera);
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
  }
}


/* ---------- 场景十：粒子能量场（2D 粒子系统，为高潮段设计：
   低频 → 粒子向心聚拢收缩；高频 → 粒子向外爆发扩散；鼓点 → 粒子数与亮度增加；
   中频旋律持续 → 粒子形成流动线条/螺旋轨迹（拖尾残影）；主色蓝紫，高潮段混入红橙高光；
   深色空间背景 + 雾气光斑 + 体积光束；高潮段镜头震动 + 快速推近；
   配置：粒子数量 / 爆发强度 / 镜头震动） ---------- */
class EnergyFieldScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0; this._bass = 0; this._mid = 0; this._tre = 0;
    this._energy = 0;            // 高潮包络（总能量慢起慢落 → 镜头震动/红橙高光用）
    this._implode = 0;           // 聚拢脉冲（低频快速上升沿触发）
    this._explode = 0;           // 爆发脉冲（高频快速上升沿触发）
    this._prevBass = 0; this._prevTre = 0;
    this._shakeX = 0; this._shakeY = 0; this._zoom = 1;
    this._builtN = 0;
    this.ps = [];                // 主粒子：{ a 极角, r 极径, va 角速度, vr 径向速度, sz, hot }
    // 雾气光斑（背景缓慢漂移的径向渐变团）
    this.fog = Array.from({ length: 7 }, (_, i) => ({
      x: Math.random(), y: Math.random(), r: 0.18 + Math.random() * 0.25,
      ph: Math.random() * TAU, sp: 0.05 + Math.random() * 0.08, hot: i % 3 === 0
    }));
    // 体积光束（从中心射出的旋转光楔）
    this.beams = Array.from({ length: 5 }, (_, i) => ({ a: i * TAU / 5, sp: 0.06 + Math.random() * 0.10, w: 0.10 + Math.random() * 0.10 }));
    this._spawn(900);
  }
  _spawn(n) {
    n = Math.round(clamp(n, 300, 2400));
    this._builtN = n;
    this.ps = Array.from({ length: n }, () => {
      const a = Math.random() * TAU;
      const r = 0.12 + Math.pow(Math.random(), 0.6) * 0.85; // 初始分布略偏外圈
      return {
        a, r,
        r0: 0.15 + Math.pow(Math.random(), 0.7) * 0.9,        // 个体静止半径（全场铺开，避免挤成单环）
        va: (0.10 + Math.random() * 0.45) * (Math.random() < 0.5 ? -1 : 1), // 双向旋涡
        vr: 0,
        sz: 0.6 + Math.random() * 1.8,
        hot: Math.random() < 0.22,   // 部分粒子带红橙高光（高潮段显现）
        ph: Math.random() * TAU
      };
    });
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.fieldCfg || { count: 900, power: 1, shake: 0.7 };
    if ((cfg.count | 0) !== this._builtN) this._spawn(cfg.count);
    // —— 频段包络（攻击快衰减慢） ——
    const kUp = Math.min(1, dt * 12), kDn = Math.min(1, dt * 4);
    const bass = bands.bass || 0, mid = bands.mid || 0, tre = bands.treble || 0;
    this._bass += (bass - this._bass) * (bass > this._bass ? kUp : kDn);
    this._mid += (mid - this._mid) * (mid > this._mid ? kUp : kDn);
    this._tre += (tre - this._tre) * (tre > this._tre ? kUp : kDn);
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.03, dt);
    // —— 聚拢/爆发脉冲：频段快速上升沿触发（有节奏感而非持续作用） ——
    if (bass - this._prevBass > 0.10) this._implode = Math.min(1, this._implode + (bass - this._prevBass) * 3.2);
    if (tre - this._prevTre > 0.08) this._explode = Math.min(1, this._explode + (tre - this._prevTre) * 3.0);
    this._prevBass = bass; this._prevTre = tre;
    this._implode *= Math.pow(0.06, dt);
    this._explode *= Math.pow(0.05, dt);
    // —— 高潮包络：总能量慢起慢落（镜头震动 / 红橙高光 / 快速推近的触发量） ——
    const eTgt = clamp((bass + mid + tre) / 1.6, 0, 1);
    this._energy += (eTgt - this._energy) * Math.min(1, dt * (eTgt > this._energy ? 2.5 : 0.9));
    const climax = clamp((this._energy - 0.45) / 0.4, 0, 1); // 0..1 高潮程度

    /* ---- 背景：拖尾残影（半透明覆盖 → 粒子运动拉线；高潮段覆盖更薄 → 线更长更亮） ---- */
    const fadeA = 0.32 - climax * 0.14 - this._explode * 0.06;
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(6,7,16,${clamp(fadeA, 0.12, 0.4)})`;
    ctx.fillRect(0, 0, w, h);

    /* ---- 镜头：高潮震动 + 鼓点/高潮推近 ---- */
    const cx = w / 2, cy = h / 2;
    const shakeAmp = climax * cfg.shake * Math.min(w, h) * 0.012 + this._explode * cfg.shake * 5;
    this._shakeX += ((Math.random() - 0.5) * 2 * shakeAmp - this._shakeX) * Math.min(1, dt * 30);
    this._shakeY += ((Math.random() - 0.5) * 2 * shakeAmp - this._shakeY) * Math.min(1, dt * 30);
    const zoomTgt = 1 + this._beat * 0.035 + climax * 0.06; // 快速推近：鼓点冲刺 + 高潮持续推进
    this._zoom += (zoomTgt - this._zoom) * Math.min(1, dt * 10);
    const R0 = Math.min(w, h) * 0.46 / this._zoom;          // 极径 r=1 对应像素

    /* ---- 体积光束（中心旋转光楔，加色混合） ---- */
    const hueC = lerp(255, 275, 0.5 + 0.5 * Math.sin(t * 0.10)); // 蓝紫主色缓慢漂移
    const hueHot = 18;                                            // 红橙高光
    ctx.save();
    ctx.translate(cx + this._shakeX, cy + this._shakeY);
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.beams) {
      b.a += b.sp * dt * (1 + this._mid * 1.5);
      const beamA = 0.020 + this._bass * 0.030 + climax * 0.020;
      const g = ctx.createLinearGradient(0, 0, Math.cos(b.a) * R0 * 2.2, Math.sin(b.a) * R0 * 2.2);
      g.addColorStop(0, `hsla(${hueC},90%,65%,${beamA})`);
      g.addColorStop(1, 'hsla(255,90%,65%,0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, R0 * 2.2, b.a - b.w, b.a + b.w);
      ctx.closePath();
      ctx.fill();
    }
    // 雾气光斑（慢漂移径向渐变团；hot 斑高潮段转红橙）
    for (const f of this.fog) {
      f.ph += f.sp * dt;
      const fx = (f.x + Math.sin(f.ph * 0.7) * 0.06) * w - cx - this._shakeX;
      const fy = (f.y + Math.cos(f.ph * 0.5) * 0.05) * h - cy - this._shakeY;
      const fr = f.r * Math.min(w, h);
      const fh = f.hot ? lerp(hueC, hueHot, climax) : hueC;
      const fg = ctx.createRadialGradient(fx, fy, 0, fx, fy, fr);
      fg.addColorStop(0, `hsla(${fh},85%,60%,${(f.hot ? 0.05 + climax * 0.09 : 0.05) + this._bass * 0.03})`);
      fg.addColorStop(1, 'hsla(255,85%,60%,0)');
      ctx.fillStyle = fg;
      ctx.fillRect(fx - fr, fy - fr, fr * 2, fr * 2);
    }

    /* ---- 粒子更新与绘制 ---- */
    const power = cfg.power;
    const swirl = 0.55 + this._mid * 2.4;                       // 旋律持续 → 角速度增大 → 螺旋轨迹
    const gather = (this._implode * 2.6 + this._bass * 0.55) * power;  // 低频 → 向心加速度
    const burst = (this._explode * 3.2 + this._tre * 0.35) * power;    // 高频 → 离心加速度
    const bright = 0.45 + this._beat * 0.5 + climax * 0.35;     // 鼓点/高潮 → 亮度
    const sizeMul = 1 + this._beat * 0.5;
    for (const p of this.ps) {
      p.ph += dt * 3;
      // 径向：聚拢 - 爆发 + 弹簧回个体静止半径 + 阻尼（速度感但不失控）
      p.vr += (-gather + burst) * dt * (0.5 + p.r * 0.8);
      p.vr += (p.r0 - p.r) * dt * 0.9;
      p.vr *= Math.pow(0.35, dt);                                // 强阻尼 → 不混乱
      // 角向：旋律驱动旋涡 + 高频轻微乱流
      p.va += (swirl * (p.va >= 0 ? 1 : -1) * 0.25 - p.va) * Math.min(1, dt * 2.2);
      p.va += (Math.random() - 0.5) * this._tre * dt * 1.2;
      p.a += p.va * dt * (1.1 - p.r * 0.55);                     // 内圈转更快（旋涡感）
      p.r += p.vr * dt;
      if (p.r < 0.03) { p.r = 0.03; p.vr = Math.abs(p.vr) * 0.5; }
      if (p.r > 1.15) { p.r = 1.15; p.vr = -Math.abs(p.vr) * 0.5; }
      const px = Math.cos(p.a) * p.r * R0, py = Math.sin(p.a) * p.r * R0;
      // 颜色：蓝紫主色（深度偏移）→ hot 粒子高潮段转红橙（经品红路径，避免穿过青绿）
      const h = p.hot ? (260 + (18 + 360 - 260) * clamp(climax * 1.3, 0, 1)) % 360 : hueC + (p.r - 0.5) * 24;
      const a = clamp(bright * (0.55 + 0.45 * Math.sin(p.ph)), 0.12, 1);
      ctx.fillStyle = `hsla(${h},92%,${p.hot && climax > 0.3 ? 62 : 68}%,${a})`;
      ctx.beginPath();
      ctx.arc(px, py, p.sz * sizeMul * (0.8 + p.r * 0.4), 0, TAU);
      ctx.fill();
    }
    // 中心能量核（聚拢时收缩变亮，爆发时膨胀；色相经品红路径转红橙，不穿青绿）
    const coreR = R0 * (0.16 + this._explode * 0.10 - this._implode * 0.05);
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, coreR);
    core.addColorStop(0, `hsla(${(260 + (18 + 360 - 260) * climax * 0.6) % 360},95%,${72 + this._beat * 14}%,${0.5 + this._beat * 0.3 + this._implode * 0.2})`);
    core.addColorStop(1, 'hsla(260,95%,70%,0)');
    ctx.fillStyle = core;
    ctx.beginPath(); ctx.arc(0, 0, coreR, 0, TAU); ctx.fill();
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
}


/* ---------- 场景十一：镜像霓虹波形（2D 时域波形：中心水平零线，波形上下完全镜像对称，
   横向全屏延伸；左青蓝 → 右紫粉横向渐变 + 强辉光霓虹描边；音量越大上下拉伸越高，
   鼓点处冲高尖刺；波形边缘飘散发光粒子，鼓点向外喷射；背景暗网格 + 弥散光点 + 淡径向光束；
   数据源为引擎时域采样 engine.wave（1024 点），逐帧插值平滑抗锯齿抖动；
   配置：波形幅度 / 辉光强度 / 粒子数量） ---------- */
class MirrorWaveScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0; this._bass = 0; this._level = 0;
    this._N = 512;                            // 横向采样点数（引擎 wave 1024 抽稀一半）
    this._sw = new Float32Array(this._N);     // 平滑后的振幅（-1..1，抗闪烁核心）
    this._builtN = 0;
    this.ps = [];                             // 波形边缘飘散粒子 {x,y,vx,vy,life,max,hue,sz}
    // 背景弥散光点（缓慢浮动的细碎光斑）
    this.motes = Array.from({ length: 70 }, () => ({
      x: Math.random(), y: Math.random(), sz: 0.5 + Math.random() * 1.4,
      ph: Math.random() * TAU, sp: 0.1 + Math.random() * 0.3, vx: (Math.random() - 0.5) * 0.008
    }));
    // 背景淡径向光束（中心缓转光楔，科技感拖尾）
    this.beams = Array.from({ length: 4 }, (_, i) => ({ a: i * TAU / 4 + 0.4, sp: 0.04 + Math.random() * 0.06, w: 0.14 + Math.random() * 0.08 }));
  }
  /* 粒子池重建（数量设置变化时） */
  _syncPool(n) {
    n = Math.round(clamp(n, 0, 300));
    if (n === this._builtN) return;
    this._builtN = n;
    this.ps = [];
    this._poolMax = n;
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.mirrorCfg || { amp: 1, glow: 1, pcount: 140 };
    this._syncPool(cfg.pcount);
    const k = Math.min(1, dt * 10);
    this._bass += ((bands.bass || 0) - this._bass) * k;
    this._level += ((bands.level || 0) - this._level) * k;
    if (bands.beat) this._beat = 1;
    this._beat *= Math.pow(0.03, dt);

    /* ---- 时域采样 → 平滑振幅表（逐帧指数平滑 + 邻域二次平滑 → 无锯齿抖动） ---- */
    const wave = this.mgr.engine?.wave;
    const N = this._N, sw = this._sw;
    if (wave && wave.length) {
      const step = wave.length / N;
      const sk2 = Math.min(1, dt * 16); // 攻击快
      for (let i = 0; i < N; i++) {
        const v = (wave[Math.floor(i * step)] - 128) / 128;
        sw[i] += (v - sw[i]) * (Math.abs(v) > Math.abs(sw[i]) ? sk2 : Math.min(1, dt * 7)); // 回落慢 → 不闪
      }
      // 邻域平滑一遍（3 点盒式）消除采样毛刺
      for (let i = 1; i < N - 1; i++) sw[i] = (sw[i - 1] + sw[i] * 2 + sw[i + 1]) * 0.25;
    } else {
      for (let i = 0; i < N; i++) sw[i] *= Math.pow(0.1, dt); // 停止时收贴零线
    }

    /* ---- 背景：黑色深空 + 暗网格 + 弥散光点 + 淡径向光束 ---- */
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#05060D';
    ctx.fillRect(0, 0, w, h);
    // 暗网格线
    ctx.strokeStyle = 'rgba(120,150,255,0.045)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 0; gx <= w; gx += 72) { ctx.moveTo(gx + 0.5, 0); ctx.lineTo(gx + 0.5, h); }
    for (let gy = 0; gy <= h; gy += 72) { ctx.moveTo(0, gy + 0.5); ctx.lineTo(w, gy + 0.5); }
    ctx.stroke();
    // 弥散光点（青/紫随机，缓慢浮动）
    for (const m of this.motes) {
      m.ph += m.sp * dt;
      m.x += m.vx * dt * 10;
      if (m.x < 0) m.x = 1; if (m.x > 1) m.x = 0;
      const mh = m.x * 120 + 185; // 横向青→紫与波形同色系
      ctx.fillStyle = `hsla(${mh},85%,72%,${0.06 + 0.09 * Math.abs(Math.sin(m.ph))})`;
      ctx.beginPath(); ctx.arc(m.x * w, m.y * h, m.sz, 0, TAU); ctx.fill();
    }
    // 淡径向光束（中心缓转，增加科技感拖尾）
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cx = w / 2, cy = h / 2;
    for (const b of this.beams) {
      b.a += b.sp * dt * (1 + this._bass);
      const g = ctx.createLinearGradient(cx, cy, cx + Math.cos(b.a) * w * 0.7, cy + Math.sin(b.a) * w * 0.7);
      g.addColorStop(0, `hsla(230,90%,65%,${0.018 + this._level * 0.02})`);
      g.addColorStop(1, 'hsla(230,90%,65%,0)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, w * 0.7, b.a - b.w, b.a + b.w);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();

    /* ---- 波形：中心零线 + 上下镜像；横向青蓝(185)→紫粉(305)渐变；多层辉光描边 ---- */
    const maxH = h * 0.36 * cfg.amp * (1 + this._beat * 0.55); // 鼓点猛地冲高（尖刺长峰）
    const y0 = cy;
    // 路径构建（一次构建，上下复用）
    const xs = new Float32Array(N), ys = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      xs[i] = (i / (N - 1)) * w;
      ys[i] = sw[i] * maxH * (0.25 + this._level * 2.2); // 振幅 → 垂直高度；安静时贴近零线
    }
    const trace = (sign) => {
      ctx.beginPath();
      ctx.moveTo(xs[0], y0);
      for (let i = 1; i < N; i++) ctx.lineTo(xs[i], y0 + ys[i] * sign);
    };
    const grad = ctx.createLinearGradient(0, 0, w, 0);
    grad.addColorStop(0, 'hsl(187,100%,60%)');   // 青蓝
    grad.addColorStop(0.5, 'hsl(230,95%,65%)');
    grad.addColorStop(1, 'hsl(305,95%,68%)');    // 紫粉
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const glow = cfg.glow;
    // 第一层：宽光晕（外发光扩散，像霓虹激光）
    ctx.strokeStyle = grad; ctx.globalAlpha = 0.18 * glow;
    ctx.lineWidth = 10; ctx.shadowColor = 'hsla(260,100%,70%,0.9)'; ctx.shadowBlur = 28 * glow;
    trace(-1); ctx.stroke(); trace(1); ctx.stroke();
    // 第二层：中光晕
    ctx.globalAlpha = 0.4 * glow;
    ctx.lineWidth = 4; ctx.shadowBlur = 16 * glow;
    trace(-1); ctx.stroke(); trace(1); ctx.stroke();
    // 第三层：亮芯（白亮内芯 → 激光感）
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.6; ctx.shadowBlur = 8 * glow; ctx.shadowColor = 'hsla(200,100%,85%,1)';
    trace(-1); ctx.stroke(); trace(1); ctx.stroke();
    ctx.restore();
    // 中心基准零线（微弱）
    ctx.strokeStyle = 'rgba(160,190,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y0 + 0.5); ctx.lineTo(w, y0 + 0.5); ctx.stroke();

    /* ---- 粒子：波形边缘持续飘散 + 鼓点向外喷射 ---- */
    const poolMax = this._poolMax ?? 140;
    // 持续生成：出生点随机取波形上某点，向上/下缘飘离
    const spawnRate = (2 + this._level * 26) * dt;
    let want = Math.floor(spawnRate) + (Math.random() < spawnRate % 1 ? 1 : 0);
    // 鼓点爆发：一次性喷射一簇
    if (bands.beat) want += 6 + Math.round(this._bass * 10);
    while (want-- > 0 && this.ps.length < poolMax + 60) {
      const i = Math.floor(Math.random() * N);
      const amp = ys[i] || 0;
      const side = Math.random() < 0.5 ? -1 : 1;
      const jet = bands.beat ? 1 : 0; // 鼓点喷射速度
      this.ps.push({
        x: xs[i], y: y0 + amp * side,
        vx: (Math.random() - 0.5) * (14 + jet * 120),
        vy: side * (10 + Math.random() * 26 + jet * (60 + this._bass * 160)),
        life: 0, max: 0.8 + Math.random() * 1.2,
        hue: (xs[i] / w) * 120 + 185, // 与出生点横向渐变色一致
        sz: 0.6 + Math.random() * 1.6
      });
    }
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let i = this.ps.length - 1; i >= 0; i--) {
      const p = this.ps[i];
      p.life += dt;
      if (p.life > p.max) { this.ps.splice(i, 1); continue; }
      p.x += p.vx * dt; p.y += p.vy * dt;
      p.vx *= Math.pow(0.5, dt); p.vy *= Math.pow(0.6, dt);
      const a = (1 - p.life / p.max) * 0.75;
      ctx.fillStyle = `hsla(${p.hue},95%,74%,${a})`;
      ctx.shadowColor = `hsla(${p.hue},95%,70%,0.8)`;
      ctx.shadowBlur = 6 * cfg.glow;
      ctx.beginPath(); ctx.arc(p.x, p.y, p.sz, 0, TAU); ctx.fill();
    }
    ctx.restore();
    ctx.globalCompositeOperation = 'source-over';
  }
}


/* ---------- 场景管理器 ---------- */
export class SceneManager {
  constructor(canvas, engine) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.engine = engine;
    this.w = 0; this.h = 0;
    this.pal = { hue: 210, hue2: 268 };
    /* 调色板渐变引擎：所有换色（theme/cover 取色、随机换色）统一走目标色 + 逐帧缓动，
       场景每帧读 mgr.pal.hue/hue2，渐变自动作用于全部视角场景（用户要求 2026-10-15） */
    this._palCur = null;   // 当前缓动色相（浮点，最短路径插值）
    this._palTgt = null;   // 目标色相 { hue, hue2 }
    this.palRandom = false; // 节奏随机换色开关（settings.palRandom）
    this._rndLast = 0;      // 上次随机换色时刻（ms）：限制最小间隔防频闪
    this.trackTitle = '';
    this.playing = false;
    this.coverImg = null;
    this.fade = null;

    this.scenes = {
      cover: new CoverParticles(this),
      ring: new RingSpectrumScene(this),
      reactor: new ReactorScene(this),
      core: new EnergyCoreScene(this),
      aurora: new CDScene(this),
      flow: new ParticleFlowScene(this),
      collide: new CollideScene(this),
      vinyl: new VinylScene(this),
      wave: new WaveScene(this),
      field: new EnergyFieldScene(this),
      mirror: new MirrorWaveScene(this),
      pv: new PvScene(this)
    };
    this.current = 'cover';
    document.body.dataset.scene = this.current; // 供舞台悬浮歌词等 UI 跟随场景切换风格
    this._homeMode = true;    // 主页模式：主页只允许圆环频谱作为背景（用户所选场景离开主页后恢复）
    this._userScene = 'ring'; // 用户最新选择的场景（含主页内选择；离开主页时恢复显示）
    this._syncPalVars();
    this.lyr = { lines: [], idx: -1, time: 0 };
    this.pvCfg = { ...PV_DEF };
    this.reactorCfg = { freq: 3.5, tilt: 4, gain: 1, scale: 1, grid: 96, mtrFreq: 55, spin: true, rnd: 1, metal: 1 };
    this.coverCfg = { scale: 1, count: 1000, spin: true, spd: 0.3 }; // 封面粒子：整体缩放 / 粒子数 / 自转开关 / 速度（设置中心实时写入）
    this.ringCfg = { pulse: 1 }; // 圆环频谱：节拍脉冲强度 0.5-2（设置中心实时写入）
    this.auroraCfg = { spd: 1, den: 1, brt: 1 };   // CD弹出：旋转速度 0.2-2 / 弹出幅度 0.4-1.6 / 整体亮度 0.5-2（设置中心实时写入）
    this.flowCfg = { count: 6000, spd: 1, size: 1 }; // 粒子流场：数量 800-15000 / 流速 0.2-2 / 光点 0.5-2（设置中心实时写入；数量变化场景内重建）
    this.waveCfg = { amp: 1, rip: 1, spd: 1 };     // 声波涟漪：波高 0.3-2 / 涟漪强度 0-2 / 流速 0.3-2（设置中心实时写入）
    this.collideCfg = { count: 500, rest: 0.92, shock: 1, trail: 0.45 }; // 流星碰撞：碎片数量 300-2400 / 飞行阻尼 0.5-1 / 爆炸强度 0-2 / 拖尾亮度 0-0.9（设置中心实时写入）
    this.fieldCfg = { count: 900, power: 1, shake: 0.7 };    // 粒子能量场：数量 300-2400 / 爆发强度 0.5-2 / 镜头震动 0-1（设置中心实时写入）
    this.mirrorCfg = { amp: 1, glow: 1, pcount: 140 };       // 镜像波形：幅度 0.5-2 / 辉光 0.5-2 / 粒子数量 0-300（设置中心实时写入）

    this._resize();
    window.addEventListener('resize', () => this._resize());
    engine.addEventListener('palette', (e) => {
      this.setPaletteHue(e.detail.hue, e.detail.hue2); // 统一走渐变入口（原为直接赋值）
    });
  }

  _resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    for (const s of Object.values(this.scenes)) s.resize();
  }

  setScene(name) {
    if (!this.scenes[name]) return;
    this._userScene = name;                        // 用户最新选择随时记住（主页内选择也生效）
    if (this._homeMode && name !== 'ring') return; // 主页只允许圆环频谱背景：仅记住选择，不切换
    if (name === this.current) return;
    document.body.dataset.scene = name; // 悬浮歌词等 UI 立即跟随（不等 fade 结束）
    this.fade = { t: 0, phase: 'out', next: name };
  }

  /** 启动恢复场景：直接赋值跳过淡入淡出（启动页遮挡期间完成，无可见跳变）；
      主页模式下用户所选场景仅暂存为 _userScene，实际显示圆环频谱 */
  applyStartupScene(key, homeActive) {
    this._homeMode = !!homeActive;
    this._userScene = key;
    const show = (homeActive && key !== 'ring') ? 'ring' : key;
    this.current = show;
    document.body.dataset.scene = show;
  }

  /** 主页模式开关（body.home-active 变化驱动，app.js MutationObserver 统一调用）：
      进主页 → 淡切回圆环频谱；离主页 → 恢复用户所选场景 */
  setHomeMode(on) {
    if (on === this._homeMode) return;
    this._homeMode = on;
    if (on) {
      if (this.current !== 'ring') {
        document.body.dataset.scene = 'ring';
        this.fade = { t: 0, phase: 'out', next: 'ring' };
      }
    } else {
      const k = this._userScene;
      if (k && this.scenes[k] && k !== 'ring' && k !== this.current) {
        document.body.dataset.scene = k;
        this.fade = { t: 0, phase: 'out', next: k };
      }
    }
  }

  /** 调色板色相 → CSS 变量（悬浮歌词/辉光等 UI 元素与画面同色系）；
      --amb* 为画面氛围色：首页问候渐变/封面光晕/歌词辉光等大面积氛围一律用它，
      换 UI 主题色（--accent）时背景与氛围不变（用户要求 2026-10-14） */
  _syncPalVars() {
    const st = document.documentElement.style;
    st.setProperty('--pal-hue', this.pal.hue);
    st.setProperty('--pal-hue2', this.pal.hue2);
    const [r1, g1, b1] = hslToRgb(this.pal.hue, 0.72, 0.6);
    const [r2, g2, b2] = hslToRgb(this.pal.hue2, 0.68, 0.64);
    st.setProperty('--amb', `hsl(${this.pal.hue} 72% 60%)`);
    st.setProperty('--amb2', `hsl(${this.pal.hue2} 68% 64%)`);
    st.setProperty('--amb-rgb', `${r1}, ${g1}, ${b1}`);
    st.setProperty('--amb2-rgb', `${r2}, ${g2}, ${b2}`);
  }

  /** PV 字幕场景数据源：ui 每帧同步歌词行/活动行/播放时间 */
  setLyricState(lines, idx, time) {
    this.lyr = { lines, idx, time };
  }

  /** 歌词动画场景配置：动画预设 / 视觉背景 / 字号 / 垂直位置 / 背景暗度（设置中心持久化） */
  setPvConfig(patch) {
    Object.assign(this.pvCfg, patch || {});
  }

  /** 反应堆场景配置：滴水间隔 / 透视倾角 / 高度增益 / 整体大小 / 网格密度 / 流星频率 / 自转 / 随机跳动 / 金属光泽（设置中心持久化，场景每帧读取实时生效；密度变化由场景内部比对重建网格） */
  setReactorConfig(patch) {
    if (!patch) return;
    const c = this.reactorCfg;
    if (patch.freq != null) c.freq = clamp(+patch.freq, 1, 8);
    if (patch.tilt != null) c.tilt = clamp(+patch.tilt, 0, 10);
    if (patch.gain != null) c.gain = clamp(+patch.gain, 0.5, 2);
    if (patch.scale != null) c.scale = clamp(+patch.scale, 0.5, 2);
    if (patch.grid != null) c.grid = Math.round(clamp(+patch.grid, 32, 72));
    if (patch.mtrFreq != null) c.mtrFreq = clamp(+patch.mtrFreq, 0, 100);
    if (patch.spin != null) c.spin = !!patch.spin;
    if (patch.rnd != null) c.rnd = clamp(+patch.rnd, 0, 2);
    if (patch.metal != null) c.metal = clamp(+patch.metal, 0.3, 2);
  }

  /** 封面粒子场景配置：整体缩放 0.5-2 / 粒子数量 300-99999 / 自动旋转 + 速度 0-1（设置中心持久化，场景每帧读取实时生效） */
  setCoverConfig(patch) {
    if (!patch) return;
    const c = this.coverCfg;
    if (patch.scale != null) c.scale = clamp(+patch.scale, 0.5, 2);
    if (patch.count != null) c.count = Math.round(clamp(+patch.count, 300, 99999));
    if (patch.spin != null) c.spin = !!patch.spin;
    if (patch.spd != null) c.spd = clamp(+patch.spd, 0, 1);
  }

  /** 圆环频谱配置：节拍脉冲强度 0.5-2（设置中心持久化，场景每帧读取实时生效） */
  setRingConfig(patch) {
    if (!patch) return;
    if (patch.pulse != null) this.ringCfg.pulse = clamp(+patch.pulse, 0.5, 2);
  }

  /** CD弹出配置：旋转速度 0.2-2 / 弹出幅度 0.4-1.6 / 整体亮度 0.5-2（设置中心持久化，场景每帧读取实时生效） */
  setAuroraConfig(patch) {
    if (!patch) return;
    const c = this.auroraCfg;
    if (patch.spd != null) c.spd = clamp(+patch.spd, 0.2, 2);
    if (patch.den != null) c.den = clamp(+patch.den, 0.4, 1.6);
    if (patch.brt != null) c.brt = clamp(+patch.brt, 0.5, 2);
  }

  /** 粒子流场配置：数量 800-15000 / 流速 0.2-2 / 光点 0.5-2（设置中心持久化；数量变化由场景内部比对重建 geometry） */
  setFlowConfig(patch) {
    if (!patch) return;
    const c = this.flowCfg;
    if (patch.count != null) c.count = Math.round(clamp(+patch.count, 800, 15000));
    if (patch.spd != null) c.spd = clamp(+patch.spd, 0.2, 2);
    if (patch.size != null) c.size = clamp(+patch.size, 0.5, 2);
  }

  /** 声波涟漪配置：波高 0.3-2 / 涟漪强度 0-2 / 流速 0.3-2（设置中心持久化，场景每帧读取实时生效） */
  setWaveConfig(patch) {
    if (!patch) return;
    const c = this.waveCfg;
    if (patch.amp != null) c.amp = clamp(+patch.amp, 0.3, 2);
    if (patch.rip != null) c.rip = clamp(+patch.rip, 0, 2);
    if (patch.spd != null) c.spd = clamp(+patch.spd, 0.3, 2);
  }

  /** 粒子能量场配置：数量 300-2400 / 爆发强度 0.5-2 / 镜头震动 0-1（设置中心持久化，场景每帧读取实时生效） */
  setFieldConfig(patch) {
    if (!patch) return;
    const c = this.fieldCfg;
    if (patch.count != null) c.count = Math.round(clamp(+patch.count, 300, 2400));
    if (patch.power != null) c.power = clamp(+patch.power, 0.5, 2);
    if (patch.shake != null) c.shake = clamp(+patch.shake, 0, 1);
  }

  /** 镜像波形配置：幅度 0.5-2 / 辉光 0.5-2 / 粒子数量 0-300（设置中心持久化，场景每帧读取实时生效） */
  setMirrorConfig(patch) {
    if (!patch) return;
    const c = this.mirrorCfg;
    if (patch.amp != null) c.amp = clamp(+patch.amp, 0.5, 2);
    if (patch.glow != null) c.glow = clamp(+patch.glow, 0.5, 2);
    if (patch.pcount != null) c.pcount = Math.round(clamp(+patch.pcount, 0, 300));
  }

  /** 流星碰撞配置：碎片数量 300-2400 / 飞行阻尼 0.5-1 / 爆炸强度 0-2 / 拖尾亮度 0-0.9（设置中心持久化） */
  setCollideConfig(patch) {
    if (!patch) return;
    const c = this.collideCfg;
    if (patch.count != null) c.count = Math.round(clamp(+patch.count, 300, 2400));
    if (patch.rest != null) c.rest = clamp(+patch.rest, 0.5, 1);
    if (patch.shock != null) c.shock = clamp(+patch.shock, 0, 2);
    if (patch.trail != null) c.trail = clamp(+patch.trail, 0, 0.9);
  }

  /** 歌词字体（设置中心）：歌词动画场景 canvas 跟随 */
  setLyricFont(family) {
    this.lyricFont = family || '';
  }

  /** 调色板目标色（渐变入口）：theme/封面取色、engine palette、节奏随机换色统一走这里。
      首次调用直接落色（启动不扫色），之后逐帧缓动过渡（_palTick）；
      封面粒子云的采样在过渡结束时重建一次（粒子颜色来自采样而非逐帧 hue） */
  setPaletteHue(hue, hue2) {
    const t = { hue: Math.round(hue), hue2: Math.round(hue2) };
    if (!this._palCur) { // 首次：直接落色
      this._palCur = { ...t };
      this._palTgt = { ...t };
      this.pal = { ...t };
      this._syncPalVars();
      this.scenes.cover.setCover(this.coverImg, this.pal);
      return;
    }
    this._palTgt = t;
  }

  /** 节奏随机换色开关（视觉控制台 COLOR 分区「随机颜色」）：开 → 每个节奏点（限最小间隔）
      随机跳一个新目标色相，经渐变过渡；关 → 恢复当前配色来源（由 ui.js 调 theme.applyFromTrack） */
  setPaletteRandom(on) {
    this.palRandom = !!on;
    if (on) this._rndLast = 0; // 开启后下一个节奏点立即换一次
  }

  /** 节奏点随机挑新目标色：与当前目标至少相差 60°（保证肉眼可辨），hue2 = hue + 30~70° 邻近色 */
  _randomizePal() {
    const cur = this._palTgt ? this._palTgt.hue : this.pal.hue;
    const hue = Math.round((cur + 60 + Math.random() * 240) % 360);
    const hue2 = Math.round((hue + 30 + Math.random() * 40) % 360);
    this._palTgt = { hue, hue2 };
  }

  /** 当前色相是否已到目标（供节奏换色判定：过渡中不叠新目标） */
  _palAtTarget() {
    const cur = this._palCur, tgt = this._palTgt;
    if (!cur || !tgt) return false;
    return Math.abs(((tgt.hue - cur.hue + 540) % 360) - 180) < 2
      && Math.abs(((tgt.hue2 - cur.hue2 + 540) % 360) - 180) < 2;
  }

  /** 逐帧缓动：当前色相以最短 hue 路径逼近目标（约 1.4s 到 95%）；量化到整度（逐柱色相缓存按度重烘焙）。
      过渡结束帧重建封面粒子采样（兜底色相跟随新色） */
  _palTick(dt) {
    const cur = this._palCur, tgt = this._palTgt;
    if (!cur || !tgt) return;
    const dh = ((tgt.hue - cur.hue + 540) % 360) - 180;
    const dh2 = ((tgt.hue2 - cur.hue2 + 540) % 360) - 180;
    if (Math.abs(dh) < 0.5 && Math.abs(dh2) < 0.5) { // 已到位
      if (this.pal.hue !== tgt.hue || this.pal.hue2 !== tgt.hue2) {
        this._palCur = { ...tgt };
        this.pal = { ...tgt };
        this._syncPalVars();
        this.scenes.cover.setCover(this.coverImg, this.pal); // 收尾重建一次粒子采样
      }
      return;
    }
    const k = 1 - Math.pow(0.003, dt); // 帧率无关指数缓动
    const q1 = Math.round(cur.hue + dh * k), q2 = Math.round(cur.hue2 + dh2 * k);
    this._palCur = { hue: cur.hue + dh * k, hue2: cur.hue2 + dh2 * k };
    if (q1 !== this.pal.hue || q2 !== this.pal.hue2) {
      this.pal = { hue: q1, hue2: q2 };
      this._syncPalVars(); // 场景每帧读 pal.hue → 渐变自动作用于全部场景；CSS 氛围色同步
    }
  }

  /** 暂停/恢复渲染循环（窗口最小化省电） */
  setPaused(p) {
    this._paused = p;
  }

  async setCoverFromTrack(track) {
    const url = track?.coverBlob || track?.coverUrl;
    this.coverImg = null;
    // 清空所有场景封面
    this.scenes.cover.setCover(null, this.pal);
    this.scenes.ring.setCover(null);
    this.scenes.reactor.setCover(null);
    this.scenes.core.setCover(null);
    this.scenes.aurora.setCover(null);
    this.scenes.flow.setCover(null);
    this.scenes.collide.setCover(null);
    this.scenes.vinyl.setCover(null);
    this.scenes.wave.setCover(null);
    this.scenes.pv.setCover(null);
    if (!url) return;
    try {
      const img = await new Promise((res, rej) => {
        const im = new Image();
        im.crossOrigin = 'anonymous';
        im.onload = () => res(im);
        im.onerror = rej;
        im.src = url;
      });
      this.coverImg = img;
      // 为所有场景设置封面
      this.scenes.cover.setCover(img, this.pal);
      this.scenes.ring.setCover(img);
      this.scenes.reactor.setCover(img);
      this.scenes.core.setCover(img);
      this.scenes.aurora.setCover(img);
      this.scenes.flow.setCover(img);
      this.scenes.collide.setCover(img);
      this.scenes.vinyl.setCover(img);
      this.scenes.wave.setCover(img);
      this.scenes.pv.setCover(img);
    } catch { /* 封面加载失败，使用默认 */ }
  }

  start(onFrame) {
    let last = performance.now();
    const loop = (now) => {
      try {
        const dt = clamp((now - last) / 1000, 0.001, 0.05);
        last = now;
        if (this._paused) { requestAnimationFrame(loop); return; } // 最小化暂停渲染省电
        const t = now / 1000;
        const bands = this.engine.update(now);
        this.playing = this.engine.playing;

        // 节奏随机换色：真实节奏点 + 距上次 ≥5s（防频闪）+ 上次过渡已到位 → 随机跳新目标色（渐变过渡）
        if (this.palRandom && bands.beat && t - this._rndLast > 5 && this._palAtTarget()) {
          this._rndLast = t;
          this._randomizePal();
        }
        this._palTick(dt); // 调色板缓动：所有场景颜色渐变逼近目标

        this.ctx.globalCompositeOperation = 'source-over'; // 防场景异常残留混合模式
        // 渐变背景预设模式：每帧清空画布让背景渐变透出来（无拖尾，画面更通透）
        if (document.body.classList.contains('bg-grad')) {
          this.ctx.clearRect(0, 0, this.w, this.h);
        }
        const scene = this.scenes[this.current];
        // 全局裁剪：大音量时立柱/粒子/波形等效果可能跳出画布边界，统一 clip 限制在画布内
        this.ctx.save();
        this.ctx.beginPath();
        this.ctx.rect(0, 0, this.w, this.h);
        this.ctx.clip();
        scene.frame(this.ctx, this.w, this.h, dt, t, bands, this.engine.bins);
        this.ctx.restore();

        // 切场淡入淡出
        if (this.fade) {
          const f = this.fade;
          f.t += dt * 3.4;
          if (f.phase === 'out') {
            this.ctx.fillStyle = `rgba(7,7,13,${clamp(f.t, 0, 1)})`;
            this.ctx.fillRect(0, 0, this.w, this.h);
            if (f.t >= 1) { this.current = f.next; f.phase = 'in'; f.t = 0; }
          } else {
            this.ctx.fillStyle = `rgba(7,7,13,${clamp(1 - f.t, 0, 1)})`;
            this.ctx.fillRect(0, 0, this.w, this.h);
            if (f.t >= 1) this.fade = null;
          }
        }

        this.trackTitle = this.engine.current?.title || '';
        if (onFrame) onFrame(bands, dt);
      } catch (e) {
        console.error('LOOP_ERR', e && (e.stack || e.message));
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
}

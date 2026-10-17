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
   CD弹出 / 迪斯科球 / 粒子碰撞 / 黑胶唱片 / 声波涟漪 / 粒子能量场 / 镜像波形（另有歌词动画特殊场景）
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
    const G = Math.round(clamp(cfg.grid == null ? 96 : +cfg.grid, 32, 512)); // 上限 512²=262144 格（圆盘遮罩后约 20 万实例）；默认 96×96
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
    // 逐柱色相缓存重烘焙：hue/hue2 变化（换歌/封面取色/渐变过渡）→ 每柱按 hueOff 展开出自己的冷/暖/高亮色。
    // 渐变过渡期间 hue 每帧都变 → 90ms 节流（网格重建 _hueKey='' 强制烘焙不节流），过渡 1.4s 内从每帧全量烘降到 ~15 次
    const hk = hue + '|' + hue2;
    if (hk !== this._hueKey) {
      const nowMs = performance.now();
      if (!this._hueKey || nowMs - (this._palBakeMs || 0) > 90) {
        this._palBakeMs = nowMs;
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
    // 卡拉OK进度（音频时间驱动）：字级按已唱字符数（浮点，含末字进行中）；
    // 行级 LRC（无逐字时间戳）按整行窗口比例推进，严禁均分造假字级时间。
    // 旧版只按字「起点」计数 → 行级数据全字同起点导致扫光瞬间满格，观感即「高亮提前结束」
    let prog = 1;
    if (cur && cur.chars && cur.chars.length) {
      if (cur.words) {
        let lit = 0;
        for (let ci = 0; ci < cur.chars.length; ci++) {
          const c = cur.chars[ci];
          if (lt >= c.end) lit = ci + 1;
          else if (lt >= c.t) { lit = ci + (lt - c.t) / Math.max(0.05, c.end - c.t); break; }
          else break;
        }
        prog = lit / cur.chars.length;
      } else {
        const T = cur.time, E = Math.max(cur.time + 0.3, cur.end || cur.time + 0.3);
        prog = E > T ? clamp((lt - T) / (E - T), 0, 1) : 1;
      }
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
      dp.rad = dp.age * 0.20;                          // 慢速扩散（约 5s 荡到盘缘，滴水间隔差异肉眼可辨）
      dp.env = Math.exp(-dp.age * 0.55) * dp.str;      // 衰减放缓（可见寿命 ~5.5s，原 1.0 时 2s 就淡没，被鼓点波淹没）
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
      // —— 滴水染白：白色波纹由「滴水间隔」控制（用户指定：滴水落点泛起白色波环）——
      for (let k = 0; k < drops.length; k++) {
        const dp = drops[k];
        if (dp.env <= 0) continue;
        const dx = c.wx - dp.wx, dz = c.wz - dp.wz;
        const d = Math.sqrt(dx * dx + dz * dz);
        const q = (d - dp.rad) / 0.15;
        if (q > 3 || q < -3) continue;
        const e = Math.exp(-q * q) * dp.env;
        wH += Math.cos((d - dp.rad) * 14) * e * 1.15; // 水滴波包略强于鼓点环（可辨识，不被淹没）
        wA += e * 0.9;
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

/* ---------- 场景六：迪斯科球（2026-10-15 替换粒子流场）：
   镜面瓦片球（数量 800-15000 → 自动分行分列等宽铺球、错缝排布），双虚拟射灯绕球扫光，
   瓦片按纬度映射 24 段对数频谱（低频在下半球、高频在上半球）——频段能量高且扫灯命中 → 镜面亮起，
   超亮瓦片白炽爆闪；顶层闪光点层（Points）在对应频段有能量时闪烁；球体慢速自转 + 倾角摇摆 + 低频呼吸；
   2D 背景层：旋转彩色光束从球背后扫过 + 地台光晕；
   配置：镜面数量（重建 geometry）/ 旋转速度 / 光点大小（实时写入） ---------- */
class DiscoBallScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._r3 = null; this._r3Dead = false; this._r3Loading = null; this._THREE = null;
    this._beat = 0; this._bass = 0;
    this._spec = new Float32Array(24);   // 连续频谱（对数分布 + 攻击快衰减慢）
    this._builtN = 0;                    // 当前镜面数量预算（数量设置变化 → 重建）
    this._spin = 0;                      // 累计自转角（含鼓点加速冲量）
  }
  resize() { if (this._r3) this._fit3(); }
  _ensureThree() {
    if (this._r3 || this._r3Dead) return this._r3;
    if (!this._r3Loading) {
      this._r3Loading = import('../vendor/three/three.module.js').then((mod) => {
        this._THREE = mod;
        this._init3();
      }).catch((e) => {
        console.warn('DiscoBallScene: three 加载失败，降级为深色底。', e);
        this._r3Dead = true;
      });
    }
    return this._r3;
  }
  _init3() {
    const T = this._THREE;
    const w = this.mgr.w || 640, h = this.mgr.h || 360;
    const canvas = document.createElement('canvas');
    const renderer = new T.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    renderer.setSize(w, h, false);
    renderer.setClearColor(0x000000, 0);
    const scene = new T.Scene();
    const camera = new T.PerspectiveCamera(50, w / h, 0.1, 20);
    camera.position.set(0, 0, 4.1);
    const uniforms = {
      uTime: { value: 0 }, uBeat: { value: 0 }, uLevel: { value: 0 },
      uSpec: { value: new Float32Array(24) },
      uCfg: { value: new T.Vector2(1, 1) },        // x 速度倍率 / y 光点大小
      uColA: { value: new T.Color(0.2, 0.9, 0.8) },
      uColB: { value: new T.Color(0.6, 0.4, 0.9) }
    };
    this._r3 = { renderer, scene, camera, uniforms, group: new T.Group(), ball: null, spark: null };
    scene.add(this._r3.group);
    this._buildBall();
    this._buildSpark();
  }
  /* 构建/重建镜面瓦片球：纬度分行、每行等宽分列、上下行错缝；aAux = seed/频段0..1/亮度抖动/尺寸随机 */
  _buildBall() {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    if (r3.ball) { r3.group.remove(r3.ball); r3.ball.geometry.dispose(); r3.ball.material.dispose(); r3.ball = null; }
    const budget = this._builtN = Math.round(clamp(this.mgr.flowCfg?.count ?? 6000, 800, 15000));
    const R = Math.max(14, Math.min(110, Math.round(Math.sqrt(budget / 1.27)))); // 总瓦片数 ≈ 1.27·R²（Σ 2R·cos 纬度平均 2/π）
    const RADIUS = 1.32;
    const HS = (Math.PI / R) * 0.5 * 0.92;               // 瓦片半边长（92% 覆盖 → 留出格缝）
    const centers = [];                                   // 瓦片中心（闪光点层采样用）
    const pos = [], aux = [], idx = [];
    let vi = 0;
    for (let r = 0; r < R; r++) {
      const lat = -Math.PI / 2 + Math.PI * (r + 0.5) / R;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const cols = Math.max(3, Math.round(R * 2 * cl));
      const band = 1 - (r + 0.5) / R;                    // 频段：顶部 1（高频）→ 底部 0（低频）
      for (let c = 0; c < cols; c++) {
        const lon = (c + 0.5) / cols * Math.PI * 2 + (r % 2) * (Math.PI / cols); // 行间错缝
        const dx = cl * Math.cos(lon), dy = sl, dz = cl * Math.sin(lon);
        // 切平面基：t1 水平切向，t2 = d × t1
        const t1x = -Math.sin(lon), t1y = 0, t1z = Math.cos(lon);
        const t2x = dy * t1z - dz * t1y, t2y = dz * t1x - dx * t1z, t2z = dx * t1y - dy * t1x;
        const seed = Math.random(), jit = Math.random(), rnd = Math.random();
        for (const [su, sv] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
          pos.push(
            (dx + (t1x * su + t2x * sv) * HS) * RADIUS,
            (dy + (t1y * su + t2y * sv) * HS) * RADIUS,
            (dz + (t1z * su + t2z * sv) * HS) * RADIUS
          );
          aux.push(seed, band, jit, rnd);
        }
        idx.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3);
        vi += 4;
        if (centers.length < 1400) centers.push([dx * RADIUS, dy * RADIUS, dz * RADIUS, seed, band, rnd]);
      }
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aAux', new T.BufferAttribute(new Float32Array(aux), 4));
    geo.setIndex(new T.BufferAttribute(new Uint32Array(idx), 1));
    // 频谱采样放顶点着色器（GLSL ES1 片元动态索引 uniform 数组不可靠）；法线经 normalMatrix 随 group 旋转进世界空间
    const mat = new T.ShaderMaterial({
      uniforms: r3.uniforms,
      vertexShader: `
        attribute vec4 aAux;
        uniform float uSpec[24];
        varying vec3 vN; varying vec4 vAux; varying float vSpec;
        void main(){
          vAux = aAux;
          float fx = clamp(aAux.y,0.0,1.0)*23.0;
          int fi = int(fx);
          vSpec = mix(uSpec[fi], uSpec[min(fi+1,23)], fract(fx));
          vN = normalize(normalMatrix * normalize(position));
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform float uTime,uBeat,uLevel;
        uniform vec2 uCfg;
        uniform vec3 uColA,uColB;
        varying vec3 vN; varying vec4 vAux; varying float vSpec;
        void main(){
          vec3 N = normalize(vN);
          float band = vAux.y, seed = vAux.x, jit = vAux.z;
          // 双虚拟射灯绕球扫动（world 空间；球体同时自转 → 相对扫掠）
          float a1 = uTime * (0.55 + uCfg.x * 0.55);
          float a2 = uTime * (0.38 + uCfg.x * 0.42) + 2.6;
          vec3 L1 = normalize(vec3(cos(a1), 0.55*sin(a1*0.63), sin(a1)));
          vec3 L2 = normalize(vec3(-cos(a2), 0.42*cos(a2*0.5), sin(a2)));
          float d1 = pow(max(dot(N,L1),0.0), 42.0);
          float d2 = pow(max(dot(N,L2),0.0), 30.0);
          float rim = pow(1.0 - max(dot(N, vec3(0.0,0.0,1.0)), 0.0), 3.0);
          float sp = max(0.0, vSpec + (jit - 0.5) * 0.05);
          float lit = sp * (0.10 + 1.00*d1 + 0.30*d2) * (0.75 + uBeat*0.9) + uLevel*0.05 + rim*0.03;
          float hot = smoothstep(0.62, 0.98, lit);
          vec3 col = mix(uColA, uColB, clamp(band + (seed-0.5)*0.18, 0.0, 1.0));
          vec3 base = vec3(0.050, 0.055, 0.065) * (0.8 + 0.4*jit);   // 暗镜面底色
          vec3 c = base + col * lit * 1.35 + vec3(0.85,0.92,1.0) * hot * (0.9 + uBeat*0.8);
          gl_FragColor = vec4(c, 1.0);
        }`,
      side: T.DoubleSide
    });
    const ball = new T.Mesh(geo, mat);
    ball.frustumCulled = false;
    r3.group.add(ball);
    r3.ball = ball;
  }
  /* 闪光点层：采样瓦片中心，对应频段有能量时闪烁（加色） */
  _buildSpark() {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    if (r3.spark) { r3.group.remove(r3.spark); r3.spark.geometry.dispose(); r3.spark.material.dispose(); r3.spark = null; }
    const ball = r3.ball;
    if (!ball) return;
    // 从瓦片构建时的中心缓存取（ball geometry 顶点顺序 4/瓦片 → 每 4 顶点取第 0 个）
    const p = ball.geometry.attributes.position, a = ball.geometry.attributes.aAux;
    const tileN = p.count / 4;
    const stride = Math.max(1, Math.ceil(tileN / 1200));
    const sPos = [], sAux = [];
    let n = 0;
    for (let i = 0; i < tileN; i += stride) {
      const v = i * 4;
      sPos.push(p.getX(v) * 1.012, p.getY(v) * 1.012, p.getZ(v) * 1.012);
      sAux.push(a.getX(v), a.getY(v), Math.random(), Math.random());
      n++;
    }
    const geo = new T.BufferGeometry();
    geo.setAttribute('position', new T.BufferAttribute(new Float32Array(sPos), 3));
    geo.setAttribute('aAux', new T.BufferAttribute(new Float32Array(sAux), 4));
    const mat = new T.ShaderMaterial({
      uniforms: r3.uniforms,
      vertexShader: `
        attribute vec4 aAux;
        uniform float uTime,uBeat,uLevel;
        uniform vec2 uCfg;
        uniform float uSpec[24];
        varying float vA; varying float vMix;
        void main(){
          float fx = clamp(aAux.y,0.0,1.0)*23.0;
          int fi = int(fx);
          float sp = max(0.0, mix(uSpec[fi], uSpec[min(fi+1,23)], fract(fx)) + (aAux.z-0.5)*0.06);
          float tw = 0.5 + 0.5*sin(uTime*(2.5+aAux.x*6.0)+aAux.z*6.283);   // 逐点快闪
          float gate = smoothstep(0.10, 0.55, sp + uBeat*0.35);            // 频段没能量就不闪
          vA = tw * gate * (0.30 + uLevel*0.50);
          vMix = aAux.y;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = (1.4+aAux.w*2.4)*uCfg.y*(0.6+sp*1.3)*(0.7+0.6*tw)*(24.0/max(1.0,-mv.z));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColA,uColB;
        varying float vA; varying float vMix;
        void main(){
          vec2 q = gl_PointCoord - 0.5;
          float d = length(q);
          float a = smoothstep(0.5, 0.04, d) * vA;
          float core = smoothstep(0.14, 0.0, d);
          vec3 c = mix(uColA, uColB, vMix) + vec3(1.0) * core;
          gl_FragColor = vec4(c, a);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const spark = new T.Points(geo, mat);
    spark.frustumCulled = false;
    r3.group.add(spark);
    r3.spark = spark;
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
    const cfg = this.mgr.flowCfg || { count: 6000, spd: 1, size: 1 };
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    // 背景：深色径向渐变 + 地台光晕 + 旋转彩色扫光光束（从球背后扫过）
    const bg = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
    bg.addColorStop(0, `hsla(${hue},45%,7%,1)`);
    bg.addColorStop(1, 'hsla(0,0%,2%,1)');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    const fy = h * 0.865;
    const floor = ctx.createRadialGradient(w / 2, fy, 0, w / 2, fy, Math.max(w * 0.42, 80));
    floor.addColorStop(0, `hsla(${hue},85%,55%,${0.10 + (bands.level || 0) * 0.12 + this._beat * 0.10})`);
    floor.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.save();
    ctx.translate(w / 2, fy); ctx.scale(1, 0.32); ctx.translate(-w / 2, -fy);
    ctx.fillStyle = floor; ctx.fillRect(-w * 0.1, fy - w * 0.5, w * 1.2, w);
    ctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const bcy = h * 0.47;
    ctx.translate(w / 2, bcy);
    const rot = t * (0.25 + cfg.spd * 0.35);
    const bl = Math.max(w, h) * 0.92;
    for (let i = 0; i < 8; i++) {
      const a = rot + i * (Math.PI * 2 / 8);
      const hu = i % 2 ? hue : hue2;
      const alpha = 0.028 + (bands.level || 0) * 0.05 + this._beat * 0.055;
      const half = 0.05 + (i % 3) * 0.013;
      const gr = ctx.createLinearGradient(0, 0, Math.cos(a) * bl, Math.sin(a) * bl);
      gr.addColorStop(0, `hsla(${hu},90%,62%,${alpha})`);
      gr.addColorStop(1, 'hsla(0,0%,0%,0)');
      ctx.fillStyle = gr;
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, bl, a - half, a + half); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
    const r3 = this._ensureThree();
    if (!r3) return;
    if ((this.mgr.flowCfg?.count | 0) !== this._builtN) { this._buildBall(); this._buildSpark(); } // 数量设置变化 → 重建
    const u = r3.uniforms;
    u.uTime.value = t;
    u.uBeat.value = this._beat; u.uLevel.value = bands.level || 0;
    u.uSpec.value.set(this._spec);
    u.uCfg.value.set(cfg.spd, cfg.size);
    const c1 = hslToRgb(hue, 0.85, 0.60);
    const c2 = hslToRgb(hue2, 0.80, 0.62);
    u.uColA.value.setRGB(sLin(c1[0]), sLin(c1[1]), sLin(c1[2]));
    u.uColB.value.setRGB(sLin(c2[0]), sLin(c2[1]), sLin(c2[2]));
    // 球体运动：自转（鼓点瞬时加速）+ 倾角摇摆 + 悬浮起伏 + 低频呼吸缩放
    this._spin += dt * (0.18 + cfg.spd * 0.40) * (1 + this._beat * 0.8);
    r3.group.rotation.y = this._spin;
    r3.group.rotation.x = Math.sin(t * 0.22) * 0.16;
    r3.group.position.y = Math.sin(t * 0.7) * 0.05;
    r3.group.scale.setScalar(1 + this._bass * 0.05);
    r3.renderer.render(r3.scene, r3.camera);
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
  }
}

/* ---------- 场景七：流星碰撞（2026-10-15 重做 v2：Three.js 真 3D 不规则陨石——
   本体 = 预生成缓存的低多边形噪声岩块（4 个固定 seed 变体，撞击崩壳时随机换形），
   本地 +Z 对齐飞行方向 → 迎风炽面恒定朝前；热壳按 aHot 顶点属性自发光（前缘烧红、背面暗岩），
   前缘只挂一枚小型热辉光（不是整圈大光晕/光球）；拖尾三段式：短亮核心光条（ribbon）
   + 火花层（加色·白炽→橙→暗红→深灰冷却色序）+ 烟雾层（暖灰羽状、随寿命膨胀），
   粒子走单 Points + 自定义 ShaderMaterial + 类型化数组对象池（dt 累加器发射、路径历史取点、零分配）；
   每个节拍在陨石当前位置触发撞击爆炸，碎片为 3D 岩块（InstancedMesh 实例化，随机翻滚/非均匀缩放/
   灼热→冷却实例色渐变），大节奏扩散大、小节奏扩散小（能量 = bass + beat），并复用火花层做火花爆发；
   飞行中陨石表面持续剥落小碎屑（高频驱动）；点光源随陨石移动照亮碎块产生动态反射；
   相机在陨石周围缓慢独立环绕穿越宇宙；
   配置：碎片数量 / 飞行阻尼 / 爆炸强度 / 拖尾亮度） ---------- */
class CollideScene extends Scene {
  constructor(mgr) {
    super(mgr);
    this._beat = 0; this._bass = 0; this._mid = 0; this._tre = 0;
    this._beatE = 0;             // 节拍能量（大节奏扩散大，小节奏扩散小）
    // 流星本体
    this._mPos = null;           // THREE.Vector3 流星位置
    this._mVel = null;           // THREE.Vector3 流星速度
    this._mTrail = [];           // 拖尾位置历史（同时作为拖尾粒子发射的路径采样）
    this._TRAIL_MAX = 44;        // 采样点上限
    this._TRAIL_STEP = 0.15;     // 相邻采样的世界距离 → 拖尾世界长度 ≈ (MAX-1)*STEP，与帧率无关
    this._trailIdle = 0;         // 未推进时长（原地悬停时让尾迹消散）
    this._rollAng = 0;           // 陨石绕飞行轴的翻滚角
    // 爆炸碎片
    this._frags = [];            // {pos:Vector3, vel:Vector3, life, max, col:Array3, metal?:Mesh}
    // 撞击节奏联动（2026-10-15）：撞击严格落在音乐重拍上，并带独立的冲击波与镜头震动
    this._impactCd = 0;          // 撞击节流倒计时（秒）：让「一次撞击」= 听觉上的一拍
    this._shake = 0;             // 撞击镜头震动强度（上限 0.7，快速衰减）
    this._camBase = null;        // 相机平滑基准位（震动只叠加在显示位 → 基准不被抖动污染、不留漂移）
    this._bassQ = [];            // 近 1s 的 bass 采样（本地鼓点检测的滑窗）
    // 靶陨石（被撞爆的那颗）：只在节拍到来时出现在撞击路径上（按节奏出现，不是定时补），
    // 尺寸由碎片数量决定（上限 = 流星一半），真实贴上流星的那一帧它就是爆炸源
    this._tgt = { life: 0, arrive: 0.5, gap0: 5.2, contact: 0.9, scl: 1, dist: Infinity };
    this._lastImpactT = 0;       // 上次节拍时刻（估算接近用时，让接触落在拍上）
    this._lastGap = 0.55;        // 最近一次撞击间隔（秒）
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
        // 首帧就把靶陨石放到撞击路径上：用户看到的是「一颗流星朝一颗等在那儿的陨石飞去」，
        // 而不是空等第一次节拍到才凭空出现一颗
        this._spawnTarget();
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
  /* 烘焙「迎风面」热度属性 aHot：本地 +Z 为飞行前向，z 越大越热（1=炽热迎风壳，0=背面暗岩），
     叠加一层噪声让炽热带边界不规则；供加色热辉光壳按顶点发光 */
  _bakeHot(T, geo, seed) {
    const pos = geo.getAttribute('position');
    const v = new T.Vector3();
    const hot = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).normalize();
      const nz = Math.max(0, v.z);
      const nz2 = 0.72 + 0.28 * Math.sin(v.x * 5.1 + seed) * Math.cos(v.y * 4.3 + seed * 1.7);
      hot[i] = clamp(Math.pow(nz, 3.0) * nz2, 0, 1);
    }
    geo.setAttribute('aHot', new T.BufferAttribute(hot, 1));
  }
  /* 切换陨石外形：撞击崩壳时随机换一个缓存变体（岩块与热壳共用同一份几何，换形同步） */
  _setMeteorShape(idx) {
    const r3 = this._r3;
    if (!r3 || idx === r3.meteorGeoIdx) return;
    r3.meteorGeoIdx = idx;
    r3.rock.geometry = r3.meteorGeos[idx];
    r3.hotShell.geometry = r3.meteorGeos[idx];
  }
  /* 向拖尾粒子池写一枚粒子（写入第 n 槽；池满则丢弃，绝不扩容/分配） */
  _emitTrail(P, x, y, z, vx, vy, vz, lf, sz) {
    if (P.n >= P.max) return;
    const i = P.n++, i3 = i * 3;
    P.pos[i3] = x; P.pos[i3 + 1] = y; P.pos[i3 + 2] = z;
    P.vel[i3] = vx; P.vel[i3 + 1] = vy; P.vel[i3 + 2] = vz;
    P.life[i] = lf; P.lifeMax[i] = lf; P.size0[i] = sz;
    P.aSeed[i] = Math.random();
  }
  /* 拖尾粒子池步进：寿命递减 + 阻尼漂移 + 老化（尺寸膨胀/亮度衰减）写回渲染属性；
     死亡粒子用末位 swap 覆盖移除 → 无空洞、每帧零分配 */
  _stepTrailPool(P, dt, grow, driftY, damp) {
    const pos = P.pos, vel = P.vel, life = P.life, lifeMax = P.lifeMax, size0 = P.size0;
    const aSize = P.aSize, aAge = P.aAge, aSeed = P.aSeed;
    const dmp = Math.pow(damp, dt);
    let n = P.n;
    for (let i = 0; i < n; i++) {
      life[i] -= dt;
      if (life[i] <= 0) {
        n--;
        if (i !== n) {
          const a = i * 3, b = n * 3;
          pos[a] = pos[b]; pos[a + 1] = pos[b + 1]; pos[a + 2] = pos[b + 2];
          vel[a] = vel[b]; vel[a + 1] = vel[b + 1]; vel[a + 2] = vel[b + 2];
          life[i] = life[n]; lifeMax[i] = lifeMax[n]; size0[i] = size0[n]; aSeed[i] = aSeed[n];
        }
        i--; continue;
      }
      const i3 = i * 3;
      vel[i3] *= dmp; vel[i3 + 2] *= dmp;
      vel[i3 + 1] = vel[i3 + 1] * dmp + driftY * dt;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const age = 1 - life[i] / lifeMax[i];
      aAge[i] = age;
      aSize[i] = size0[i] * (1 + grow * age);
    }
    P.n = n;
    const g = P.geo;
    g.setDrawRange(0, n);
    g.getAttribute('position').needsUpdate = n > 0;
    g.getAttribute('aSize').needsUpdate = n > 0;
    g.getAttribute('aAge').needsUpdate = n > 0;
    g.getAttribute('aSeed').needsUpdate = n > 0;
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
    // 陨石本体：预生成并缓存的低多边形噪声岩块（4 个固定 seed 变体，撞击崩壳时随机换形，
    // 绝不在每帧/每次生成时重建几何）；本地 +Z 定为飞行前向 → 迎风炽面恒定朝前
    const meteorGeos = [3.1, 7.7, 12.3, 18.9].map((sd) => {
      const g = this._rockGeo(T, 0.40, 2, sd, true);
      this._bakeHot(T, g, sd);
      return g;
    });
    const meteorGeoIdx = Math.floor(Math.random() * meteorGeos.length);
    const meteor = new T.Group();           // 组：承接位置 / 姿态 / 缩放脉冲
    // 岩石 PBR 材质 + 环境反射；flatShading 保留低模棱面，emissive 暗红托底让暗场里仍有轮廓
    const meteorRockMat = new T.MeshStandardMaterial({
      color: 0x6e5c4b, metalness: 0.12, roughness: 0.86, flatShading: true,
      emissive: 0x3a1408, emissiveIntensity: 0.40,
      envMap: env, envMapIntensity: 0.8
    });
    const rock = new T.Mesh(meteorGeos[meteorGeoIdx], meteorRockMat);
    meteor.add(rock);
    scene.add(meteor);
    // 迎风面热辉光壳：同一岩块几何微放大 2%，按 aHot 顶点属性自发光（前缘炽热、背面熄灭），
    // 加色混合 → 烧红的陨石迎风壳，而不是套在球体外的整圈光环（那正是「光球」观感来源）
    const hotMat = new T.ShaderMaterial({
      uniforms: { uCol: { value: new T.Color(1.0, 0.42, 0.10) }, uAmp: { value: 1.0 } },
      vertexShader: `attribute float aHot; varying float vHot; varying vec3 vN; varying vec3 vV;
        void main(){ vHot = aHot; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `uniform vec3 uCol; uniform float uAmp; varying float vHot; varying vec3 vN; varying vec3 vV;
        void main(){ float rim = pow(1.0 - max(dot(normalize(vN), normalize(vV)), 0.0), 1.5); float g = vHot * (0.60 + 0.40 * rim); gl_FragColor = vec4(uCol, clamp(g * uAmp, 0.0, 0.58)); }`,
      transparent: true, blending: T.AdditiveBlending, depthWrite: false, side: T.FrontSide
    });
    const hotShell = new T.Mesh(meteorGeos[meteorGeoIdx], hotMat);
    hotShell.scale.setScalar(1.02);
    meteor.add(hotShell);
    // 前缘热辉光精灵：小型软光斑挂在本地 +Z（飞行前向）前缘，随节拍/低频呼吸；
    // 尺寸远小于上一轮的整圈大光晕，只当陨石迎风端的灼热气帽
    const heatMat = new T.SpriteMaterial({
      map: glowTex, color: 0xff6a1e, transparent: true, opacity: 0.45,
      blending: T.AdditiveBlending, depthWrite: false
    });
    const heatGlow = new T.Sprite(heatMat);
    heatGlow.scale.setScalar(1.05);
    heatGlow.position.set(0, 0, 0.33);
    meteor.add(heatGlow);

    // ===== 拖尾：纯粒子系统（扁平 ribbon mesh 已删除，它导致"从内部出来的一根带子"假象）=====
    // 三层粒子池：
    //   corePool — 核心光条：头部白炽 → 尾部暗红，密集小粒子沿路径发射，制造"炽热轨迹"
    //   sparkPool — 火花爆发：短命亮色小火花，带随机方向 + 冷却色序
    //   smokePool — 烟雾层：大号柔边粒子，暖灰长命，膨胀消散
    const TRAIL_N = this._TRAIL_MAX;
    const mkTrailPool = (max, mat) => {
      const pos = new Float32Array(max * 3);
      const vel = new Float32Array(max * 3);
      const life = new Float32Array(max);
      const lifeMax = new Float32Array(max);
      const size0 = new Float32Array(max);
      const aSize = new Float32Array(max);
      const aAge = new Float32Array(max);
      const aSeed = new Float32Array(max);
      const geo = new T.BufferGeometry();
      geo.setAttribute('position', new T.BufferAttribute(pos, 3));
      geo.setAttribute('aSize', new T.BufferAttribute(aSize, 1));
      geo.setAttribute('aAge', new T.BufferAttribute(aAge, 1));
      geo.setAttribute('aSeed', new T.BufferAttribute(aSeed, 1));
      geo.setDrawRange(0, 0);
      const points = new T.Points(geo, mat);
      points.frustumCulled = false;
      scene.add(points);
      return { max, n: 0, pos, vel, life, lifeMax, size0, aSize, aAge, aSeed, geo, points };
    };
    const trailVert = `
      attribute float aSize; attribute float aAge; attribute float aSeed;
      varying float vAge; varying float vSeed;
      void main(){
        vAge = aAge; vSeed = aSeed;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        float tw = 0.78 + 0.22 * sin(aSeed * 40.0 + aAge * 24.0);
        gl_PointSize = aSize * (300.0 / max(-mv.z, 1.0)) * tw;
        gl_Position = projectionMatrix * mv;
      }`;
    // 火花：真实冷却色序 白炽 → 橙 → 暗红 → 深灰，短命高亮，是拖尾的「火」
    const sparkMat = new T.ShaderMaterial({
      uniforms: { uAmp: { value: 1.0 } },
      vertexShader: trailVert,
      fragmentShader: `uniform float uAmp; varying float vAge; varying float vSeed;
        void main(){
          float a = smoothstep(0.5, 0.0, length(gl_PointCoord - 0.5));
          vec3 col = mix(vec3(1.0,0.96,0.85), vec3(1.0,0.52,0.14), smoothstep(0.0,0.22,vAge));
          col = mix(col, vec3(0.82,0.16,0.05), smoothstep(0.22,0.62,vAge));
          col = mix(col, vec3(0.20,0.17,0.16), smoothstep(0.62,1.0,vAge));
          float fade = pow(1.0 - vAge, 1.5) * uAmp;
          gl_FragColor = vec4(col, a * fade);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    // 烟雾：被炽热头焰照亮的暖灰羽状烟尘（本层最终以「加色」合成到 2D 背景上，纯黑不可见，
    // 故走暖灰而非纯黑），尺寸随寿命膨胀、亮度衰减 → 拖尾后段的体积感
    const smokeMat = new T.ShaderMaterial({
      uniforms: { uAmp: { value: 1.0 } },
      vertexShader: trailVert,
      fragmentShader: `uniform float uAmp; varying float vAge; varying float vSeed;
        void main(){
          float a = smoothstep(0.5, 0.08, length(gl_PointCoord - 0.5));
          vec3 col = mix(vec3(0.62,0.40,0.28), vec3(0.18,0.17,0.18), smoothstep(0.0,0.75,vAge));
          float fade = pow(1.0 - vAge, 1.8) * 0.55 * uAmp;
          gl_FragColor = vec4(col, a * fade);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    // 核心光条：高密度路径粒子，颜色沿 age 从白炽头部渐变到暗红尾部，制造"炽热轨迹"
    // 比 spark 更短命（0.18~0.5s）、更小（0.06~0.12）、更密集（头部优先发射）
    const coreMat = new T.ShaderMaterial({
      uniforms: { uAmp: { value: 1.0 } },
      vertexShader: trailVert,
      fragmentShader: `uniform float uAmp; varying float vAge; varying float vSeed;
        void main(){
          float d = length(gl_PointCoord - 0.5);
          float a = smoothstep(0.5, 0.0, d);
          vec3 col = mix(vec3(1.0,0.98,0.86), vec3(1.0,0.55,0.12), smoothstep(0.0,0.25,vAge));
          col = mix(col, vec3(0.55,0.10,0.02), smoothstep(0.25,0.70,vAge));
          float fade = pow(1.0 - vAge, 2.2) * uAmp;
          gl_FragColor = vec4(col, a * fade);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
    });
    const corePool = mkTrailPool(800, coreMat);
    const sparkPool = mkTrailPool(1400, sparkMat);   // 原 1100 → 1400 多 300 给更密集爆发
    const smokePool = mkTrailPool(420, smokeMat);
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
    // —— 靶陨石（被撞爆的那颗，2026-10-15）：与流星本体分开的一颗岩块，提前出现在撞击路径上，
    //    撞击瞬间它就是爆炸源；尺寸由「碎片数量」设置决定（见 _spawnTarget/_updateTarget）——
    //    单独材质 + 略亮自发光：暗场里能看清「等在那儿要被撞的那颗」，且与流星本体一眼区分开
    const tgtMat = new T.MeshStandardMaterial({
      color: 0x8a7a66, metalness: 0.16, roughness: 0.80, flatShading: true,
      emissive: 0x2a1608, emissiveIntensity: 0.5,
      envMap: env, envMapIntensity: 0.9
    });
    const tgt = new T.Mesh(this._rockGeo(T, 0.52, 2, 26.4, false), tgtMat);
    tgt.visible = false;
    scene.add(tgt);
    // —— 碰撞冲击环池（3D）：RingGeometry 圆环，撞击瞬间法线对齐流星速度方向 →
    //    环面严格垂直于运动方向（屏幕空间的 2D 圆环永远正对相机、没有方向性，故废弃），
    //    相机环绕时能清楚看到环面与飞行方向的垂直关系；碎片也沿这个环面飞散（见 _explode）——
    const rings = [];
    for (let i = 0; i < 6; i++) {
      const rm = new T.Mesh(
        new T.RingGeometry(0.86, 1, 64),
        new T.MeshBasicMaterial({
          color: 0xffffff, transparent: true, opacity: 0, side: T.DoubleSide,
          blending: T.AdditiveBlending, depthWrite: false
        })
      );
      rm.visible = false;
      scene.add(rm);
      rings.push({ mesh: rm, life: 0, max: 1, e: 1, on: false });
    }
    // 矩阵/颜色合成暂存（每帧复用，避免 GC）
    const scratch = {
      m4: new T.Matrix4(), q4: new T.Quaternion(),
      s3: new T.Vector3(), c3: new T.Color()
    };

    // ========== 宇宙背景：星空 / 银河 / 星云 / 行星（营造在宇宙中飞行的穿越感） ==========
    // 星空：环绕流星的可回收星点盒（流星飞行时星点从身边掠过，出盒则回收到前方）
    const STAR_N = 4800, STAR_BOX = 42;   // 4200 → 4800 更密集
    const starGeo = new T.BufferGeometry();
    const sPos = new Float32Array(STAR_N * 3);
    const sCol = new Float32Array(STAR_N * 3);
    const sSize = new Float32Array(STAR_N);
    const sSpec = new Float32Array(STAR_N);
    for (let i = 0; i < STAR_N; i++) {
      sPos[i * 3] = (Math.random() - 0.5) * STAR_BOX * 2;
      sPos[i * 3 + 1] = (Math.random() - 0.5) * STAR_BOX * 2;
      sPos[i * 3 + 2] = (Math.random() - 0.5) * STAR_BOX * 2;
      const c = Math.random();
      let r = 1, g = 1, b = 1;
      if (c < 0.18) { r = 0.7; g = 0.82; b = 1.0; }          // 蓝白（热星）
      else if (c < 0.30) { r = 1.0; g = 0.93; b = 0.7; }      // 暖黄（类日）
      else if (c < 0.36) { r = 1.0; g = 0.75; b = 0.7; }      // 淡红（红矮星）
      else if (c < 0.42) { r = 0.9; g = 0.9; b = 1.0; }       // 纯白
      sCol[i * 3] = r; sCol[i * 3 + 1] = g; sCol[i * 3 + 2] = b;
      sSize[i] = 0.4 + Math.random() * 2.2;
      sSpec[i] = Math.random() < 0.35 ? 1.0 : 0.0;            // 35% 的星有清晰高光（specular）
    }
    starGeo.setAttribute('position', new T.BufferAttribute(sPos, 3));
    starGeo.setAttribute('color', new T.BufferAttribute(sCol, 3));
    starGeo.setAttribute('size', new T.BufferAttribute(sSize, 1));
    starGeo.setAttribute('aSpec', new T.BufferAttribute(sSpec, 1));
    // 双层星星 shader：中心高对比亮核 + 外层大柔光 → 比单层模糊更像真实恒星
    const starMat = new T.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: `attribute float size; attribute vec3 color; attribute float aSpec; varying vec3 vCol; varying float vTw; varying float vSpec; uniform float uTime;
        void main(){
          vCol = color; vSpec = aSpec;
          vec4 mv = modelViewMatrix * vec4(position,1.0);
          float tw = 0.72 + 0.28 * sin(uTime * 1.6 + position.x * 13.0 + position.y * 7.0);
          vTw = tw;
          gl_PointSize = size * (280.0 / max(-mv.z, 1.0)) * tw;
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `varying vec3 vCol; varying float vTw; varying float vSpec;
        void main(){
          vec2 c = gl_PointCoord - 0.5;
          float d = length(c);
          // 外层柔光（大）：缓慢衰减
          float outer = smoothstep(0.5, 0.0, d);
          outer = pow(outer, 2.2);
          // 内层亮核（小）：高对比
          float core = smoothstep(0.16, 0.0, d);
          core = pow(core, 0.8);
          vec3 col = vCol * (outer * 0.55 + core * 1.8);
          float a = max(outer, core);
          gl_FragColor = vec4(col * (0.3 + vTw * 0.35), a);
        }`,
      transparent: true, depthWrite: false, blending: T.AdditiveBlending
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

    // 星云：程序化噪声云团（多层分形噪声 + 色彩渐变 + 边缘羽化）
    // 比纯径向渐变更像真实宇宙云团（有内部絮状结构、多团叠在一起）
    const hue0 = this.mgr.pal.hue;
    // 简化 2D value noise（无需库，自实现）
    const _hash = (x, y, s) => {
      let n = x * 374761393 + y * 668265263 + s * 2147483647;
      n = (n ^ (n >> 13)) * 1274126177;
      return ((n ^ (n >> 16)) >>> 0) / 4294967295;
    };
    const _vNoise = (x, y, s) => {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const a = _hash(xi, yi, s), b = _hash(xi + 1, yi, s), c = _hash(xi, yi + 1, s), d = _hash(xi + 1, yi + 1, s);
      const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
      return a * (1 - u) * (1 - v) + b * u * (1 - v) + c * (1 - u) * v + d * u * v;
    };
    const _fbm = (x, y, s, oct) => {
      let f = 0, amp = 0.5, freq = 1;
      for (let i = 0; i < oct; i++) { f += _vNoise(x * freq, y * freq, s) * amp; freq *= 2.0; amp *= 0.5; }
      return f;
    };
    const makeNebTex = (h) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = 256;
      const g = cv.getContext('2d');
      const s = g.createImageData(256, 256);
      for (let y = 0; y < 256; y++) {
        for (let x = 0; x < 256; x++) {
          const nx = (x / 256) * 5.0, ny = (y / 256) * 5.0;
          const n1 = _fbm(nx, ny, h % 256, 5);
          const n2 = _fbm(nx * 2.1 + 3.7, ny * 1.8 + 1.9, (h + 73) % 256, 4);
          const v = n1 * 0.7 + n2 * 0.35;
          // 径向遮罩：中心最强、边缘渐隐
          const dx = x - 128, dy = y - 128;
          const radial = 1 - Math.min(1, Math.sqrt(dx * dx + dy * dy) / 128);
          const a = Math.pow(v, 2.4) * Math.pow(radial, 1.5);
          const i = (y * 256 + x) * 4;
          const col = hslToRgb(h, 0.70, 0.55);
          s.data[i] = col[0] * 255 * (0.45 + a * 0.55);
          s.data[i + 1] = col[1] * 255 * (0.38 + a * 0.62);
          s.data[i + 2] = col[2] * 255 * (0.40 + a * 0.60);
          s.data[i + 3] = a * 255;
        }
      }
      g.putImageData(s, 0, 0);
      return new T.CanvasTexture(cv);
    };
    const nebGroup = new T.Group();
    const nebulae = [];
    for (let i = 0; i < 5; i++) {   // 8 → 5 个更大的云团（每个有更丰富内部结构）
      const h = (hue0 + (i * 72 + Math.random() * 40)) % 360;
      const tex = makeNebTex(h);
      const mat = new T.SpriteMaterial({ map: tex, transparent: true, opacity: 0.38, blending: T.AdditiveBlending, depthWrite: false });
      const sp = new T.Sprite(mat);
      const s = 85 + Math.random() * 95;   // 更大（50-120 → 85-180）
      sp.scale.set(s, s, 1);
      sp.position.set((Math.random() - 0.5) * STAR_BOX * 1.6, (Math.random() - 0.5) * 28, (Math.random() - 0.5) * STAR_BOX * 1.6);
      nebGroup.add(sp);
      nebulae.push({ sprite: sp, base: sp.position.clone() });
    }
    scene.add(nebGroup);

    // —— 行星：2 颗程序化星球 + 1 颗环带行星 ——
    const makePlanetTex = ({ size = 256, baseHue = 20, bandNum = 7, noiseAmp = 0.45, spot = false }) => {
      const cv = document.createElement('canvas'); cv.width = cv.height = size;
      const g = cv.getContext('2d');
      const data = g.createImageData(size, size);
      for (let y = 0; y < size; y++) {
        const lat = (y / size - 0.5) * Math.PI;    // -π/2 ~ π/2
        const band = Math.sin(lat * bandNum);
        for (let x = 0; x < size; x++) {
          const lon = (x / size) * TAU;
          const noise = _fbm(lon * 1.5 + baseHue * 0.01, lat * 2.0, baseHue, 4);
          const bandV = (band * 0.5 + 0.5) * (1 - noiseAmp) + noise * noiseAmp;
          const h = (baseHue + bandV * 30) % 360;
          const l = 0.18 + bandV * 0.35 + (noise - 0.5) * 0.12;
          const col = hslToRgb(h, 0.65, l);
          // 球面明暗：中心亮、边缘暗（法线 lighting 近似）
          const nx = (x / size - 0.5) * 2, ny = (y / size - 0.5) * 2;
          const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
          const light = Math.max(0.15, 0.55 + nz * 0.5);
          const i = (y * size + x) * 4;
          data.data[i] = clamp(col[0] * light, 0, 1) * 255;
          data.data[i + 1] = clamp(col[1] * light, 0, 1) * 255;
          data.data[i + 2] = clamp(col[2] * light, 0, 1) * 255;
          data.data[i + 3] = nz > 0 ? 255 : 0;
        }
      }
      g.putImageData(data, 0, 0);
      return new T.CanvasTexture(cv);
    };
    const planetGroup = new T.Group();
    const planets = [];
    // 行星 1：气态巨行星（条纹 + 红斑风格）
    {
      const tex = makePlanetTex({ baseHue: 18, bandNum: 9, noiseAmp: 0.38 });
      const geo = new T.SphereGeometry(1.0, 48, 32);
      const mat = new T.MeshStandardMaterial({ map: tex, metalness: 0.05, roughness: 0.85 });
      const p = new T.Mesh(geo, mat);
      p.scale.setScalar(14);
      p.position.set(-28, 6, -38);
      planetGroup.add(p);
      planets.push({ mesh: p, spin: 0.03 });
    }
    // 行星 2：岩石行星（多斑点 + 海洋感）
    {
      const tex = makePlanetTex({ baseHue: 200, bandNum: 3, noiseAmp: 0.62 });
      const geo = new T.SphereGeometry(1.0, 48, 32);
      const mat = new T.MeshStandardMaterial({ map: tex, metalness: 0.08, roughness: 0.80 });
      const p = new T.Mesh(geo, mat);
      p.scale.setScalar(7.5);
      p.position.set(22, -10, -52);
      planetGroup.add(p);
      planets.push({ mesh: p, spin: -0.04 });
    }
    scene.add(planetGroup);

    this._r3 = {
      renderer, scene, camera, env, amb, dir, meteorLight,
      meteor, rock, meteorRockMat, hotShell, hotMat, heatGlow, heatMat,
      meteorGeos, meteorGeoIdx,
      corePool, sparkPool, smokePool,
      fragPoints, fragMat, fragGeo, fragPos, fragCol, MAX_FRAG,
      rockPools, scratch,
      tgt, tgtMat, rings,
      // 宇宙背景
      stars, starMat, starGeo, sPos, STAR_N, STAR_BOX,
      galaxy, galMat,
      nebGroup, nebulae,
      planetGroup, planets
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
  /* 节拍爆炸：在撞击点（默认流星当前位置）生成碎片，扩散半径 ∝ 节拍能量。
     撞击点由调用方传入（= 靶陨石位置）→ 碎片从「被撞爆的那颗」迸出，而不是从流星身上冒出，
     视觉因果才对：流星飞过去撞上靶陨石，靶陨石炸开 */
  _explode(intensity, origin) {
    const T = this._THREE, r3 = this._r3;
    if (!T || !r3) return;
    const oc = origin || this._mPos;
    const cfg = this.mgr.collideCfg || { count: 1300, rest: 0.92, shock: 1, trail: 0.45 };
    const want = Math.round(cfg.count);
    // 池满时先淘汰最老的一批碎片再生成新爆发：旧逻辑池满后 n=0 直接 return，
    // 后面的撞击就变成「撞了但画面没有任何变化」——观感上完全跟不上节奏。
    // 被淘汰的都是最老的碎片（此时多半已缩小/淡出），换成新爆发的可见性，观感上不会被看出是「删掉」。
    const free = r3.MAX_FRAG - this._frags.length;
    if (free < want) this._frags.splice(0, want - free);
    const n = Math.min(r3.MAX_FRAG - this._frags.length, want);
    if (n <= 0) return;
    const hue = this.mgr.pal.hue, hue2 = this.mgr.pal.hue2;
    const baseSpeed = intensity * (2.2 + this._bass * 3.5) * (cfg.shock ?? 1);
    const spread = 0.6 + intensity * 1.4;             // 大节奏扩散大
    // 碎片沿「碰撞环面」飞散：环面 = 垂直于流星运动方向的平面（与 3D 冲击环同面）。
    // 做法：球均匀随机方向 → 减去沿飞行方向的分量（落到环面上）→ 再加少量离面抖动，
    // 爆出来的碎块呈片状圆盘向外扩，而不是球状均喷
    const vd = this._explV || (this._explV = new T.Vector3());
    vd.copy(this._mVel);
    if (vd.lengthSq() < 1e-6) vd.set(0, 0, 1); else vd.normalize();
    const planeDir = () => {
      let dx, dy, dz, d2;
      do { dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1; d2 = dx * dx + dy * dy + dz * dz; } while (d2 > 1 || d2 < 1e-6);
      const inv = 1 / Math.sqrt(d2);
      dx *= inv; dy *= inv; dz *= inv;
      const along = dx * vd.x + dy * vd.y + dz * vd.z;
      dx -= vd.x * along; dy -= vd.y * along; dz -= vd.z * along;   // 环面分量
      const pl = Math.hypot(dx, dy, dz) || 1;
      const tilt = (Math.random() - 0.5) * 0.6;                     // 少量离面抖动（约 ±17°）
      dx = dx / pl + vd.x * tilt; dy = dy / pl + vd.y * tilt; dz = dz / pl + vd.z * tilt;
      const il = 1 / (Math.hypot(dx, dy, dz) || 1);
      return [dx * il, dy * il, dz * il];
    };
    for (let i = 0; i < n; i++) {
      const [dx, dy, dz] = planeDir();
      const sp = baseSpeed * (0.25 + Math.random() * 0.95) * spread;
      const col = Math.random() < 0.5 ? hslToRgb(hue, 0.9, 0.7) : hslToRgb(hue2, 0.9, 0.72);
      // 全部碎片为 3D 岩块（InstancedMesh 实例），30% 附带辉光火花点
      this._frags.push(this._mkFrag(
        oc.x, oc.y, oc.z,
        dx * sp, dy * sp, dz * sp,
        {
          max: 0.7 + Math.random() * 0.9, scl: 0.28 + Math.random() * 0.62,   // 碎块偏小（旧版 0.5~1.6 显笨重）
          hotHue: Math.random() < 0.5 ? hue : hue2, glow: Math.random() < 0.3,
          col: [sLin(col[0]), sLin(col[1]), sLin(col[2])]
        }
      ));
    }
    // 撞击瞬间火花爆发：同样沿环面喷射（向外喷射 + 快速冷却）
    const spk = r3.sparkPool;
    if (spk) {
      const burst = Math.round(80 + intensity * 130);
      for (let i = 0; i < burst; i++) {
        const [dx, dy, dz] = planeDir();
        const sp = (2.5 + intensity * 3.5) * (0.3 + Math.random() * 0.9);
        this._emitTrail(spk,
          oc.x, oc.y, oc.z,
          dx * sp, dy * sp, dz * sp,
          0.30 + Math.random() * 0.6, 0.07 + Math.random() * 0.14);
      }
    }
    // 强撞击时陨石崩掉一层外壳、随机换一个缓存变体（爆炸闪光正好遮住切换瞬间）
    if (intensity > 1.15 && Math.random() < 0.6) {
      let gi = Math.floor(Math.random() * r3.meteorGeos.length);
      if (gi === r3.meteorGeoIdx) gi = (gi + 1) % r3.meteorGeos.length;
      this._setMeteorShape(gi);
    }
  }
  /* 碰撞冲击环：3D 圆环，法线对齐流星速度方向 → 环面严格垂直于运动方向；
     在撞击点生成，之后由帧更新扩张 + 淡出（碎片也沿同一环面飞散，见 _explode） */
  _spawnRing(pos, e) {
    const r3 = this._r3;
    if (!r3 || !r3.rings) return;
    const T = this._THREE;
    const rg = r3.rings.find(r => !r.on) || r3.rings[0];
    rg.on = true; rg.life = 0; rg.max = 0.34 + e * 0.14; rg.e = e;
    const m = rg.mesh;
    m.visible = true;
    m.position.copy(pos);
    const vd = this._ringV || (this._ringV = new T.Vector3());
    vd.copy(this._mVel);
    if (vd.lengthSq() < 1e-6) vd.set(0, 0, 1); else vd.normalize();
    // RingGeometry 在 XY 平面、法线为 +Z → 把 +Z 旋到速度方向，环面即 ⊥ 运动方向
    m.quaternion.setFromUnitVectors(this._ringZ || (this._ringZ = new T.Vector3(0, 0, 1)), vd);
    m.material.color.setHSL((((this.mgr.pal.hue % 360) + 360) % 360) / 360, 0.95, 0.78);
  }
  /* 放置／补一颗靶陨石（被撞爆的那颗）：只在节拍到来时被调用（节拍块），按节奏出现而不是定时出现。
     尺寸上限 = 流星本体的一半：流星几何半径 0.40，靶几何基准半径 0.52 → scl ≤ 0.38（0.52×0.38≈0.198）。
     尺寸随「碎片数量」按立方根换算（碎片数 ≈ 爆炸体积 → cbrt 才是线性观感），
     300~2400 片 → scl ≈ 0.18~0.37，始终是「比流星小一截、等着被撞碎的小陨石」。
     接近用时：接触发生在 dist 从 gap0 收到 contact 的时刻 = arrive × (1 - contact/gap0)，
     令它 ≈ 最近节拍间隔 → 每次「碰到就炸」仍然落在拍上。 */
  _spawnTarget() {
    const r3 = this._r3, tg = this._tgt;
    if (!r3 || !r3.tgt) return;
    const cfg = this.mgr.collideCfg || { count: 1300 };
    // 基准尺寸仍由碎片数量决定，但每颗乘以 0.72~1.28 的随机系数 → 大的大小的小，不再颗颗一样；
    // 无论如何不超过流星本体的一半（0.52×0.38≈0.198 对流星半径 0.40）
    const base = 0.30 * Math.cbrt((cfg.count || 1300) / 1300);
    tg.scl = Math.min(0.38, Math.max(0.14, base * (0.72 + Math.random() * 0.56)));
    tg.contact = (0.40 + 0.52 * tg.scl) * 0.92;   // 视觉接触距离（两者半径之和的 92%，略重叠 = 撞上了）
    tg.gap0 = 3.3 + 1.9 * tg.scl;                 // 出场距离：越大的靶越靠外，避免出场就贴脸
    tg.arrive = clamp(this._lastGap / (1 - tg.contact / tg.gap0), 0.26, 1.2);
    tg.life = 0;
    tg.dist = tg.gap0;
    const m = r3.tgt;
    m.visible = true;
    m.scale.setScalar(0.001);
    m.rotation.set(Math.random() * TAU, Math.random() * TAU, Math.random() * TAU);
  }
  /* 每帧摆放靶陨石：钉在「流星前方」并被投影到垂直于视线的平面上，再按剩余时间向流星逼近。
     投影这一步不可省 —— 相机绕流星缓慢 360° 环绕，若把靶直接放在飞行方向上，
     相机转到两者连线上时靶会被流星完全挡住、转到侧面时又被透视压扁成长条；
     投影到垂直视线的平面后，靶始终与流星并排出现在画面里、大小稳定。
     终点是流星本体（距离 0），不是停在接触点上干等 —— tg.dist 恒为与流星的真实距离，
     帧末接触判定在 dist ≤ contact 的同一帧引爆：「碰到就炸」，既不提前也不拖后。 */
  _updateTarget(r3, dt) {
    const tg = this._tgt, m = r3.tgt;
    if (!m || !m.visible) { tg.dist = Infinity; return; }
    tg.life += dt;
    const T = this._THREE;
    const view = this._tgtView || (this._tgtView = new T.Vector3());
    const dir = this._tgtDir || (this._tgtDir = new T.Vector3());
    view.copy(this._mPos).sub(r3.camera.position);
    if (view.lengthSq() < 1e-6) view.set(0, 0, -1); else view.normalize();
    dir.copy(this._mVel);
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1); else dir.normalize();
    dir.addScaledVector(view, -dir.dot(view));          // 去掉视线方向分量
    if (dir.lengthSq() < 0.04) dir.crossVectors(view, r3.camera.up);   // 视线与飞行方向近乎平行 → 换垂直轴
    if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
    dir.normalize();
    // 从出场距离匀速收向流星本体（arrive 秒）：dist 一路减到 0，途中越过 contact 的瞬间即被引爆
    const p = clamp(tg.life / tg.arrive, 0, 1);
    tg.dist = tg.gap0 * (1 - p);
    m.position.copy(this._mPos).addScaledVector(dir, tg.dist);
    // 0.25s 缩放入场（避免在上一场爆炸的碎块里突然弹出一颗），随后缓慢翻滚
    m.scale.setScalar(Math.max(0.001, tg.scl * Math.min(1, tg.life / 0.25)));
    m.rotation.x += dt * 0.22;
    m.rotation.y += dt * 0.34;
  }
  frame(ctx, w, h, dt, t, bands, bins) {
    const cfg = this.mgr.collideCfg || { count: 1300, rest: 0.92, shock: 1, trail: 0.45 };
    // —— 撞击：严格跟着音乐节拍走 ——
    // ① 触发信号：音频层的 bands.beat 用的是「bass > 近 46 帧均值 × 1.36」的保守阈值，
    //    低音持续稳定/压缩过的曲子永远够不到（实测某曲 12s 内 0 次触发）→ 流星根本撞不起来；
    //    这里在场景内补一个更灵敏的自适应鼓点检测：bass 高于「近 1s 均值 × 1.05」即判定一次撞击。
    //    1s 滑窗让阈值跟着段落响度走（安静段不会漏、持续强低音段也不会一直误触），
    //    实测同一首曲子从 0 次/12s 变成 ~1.5 次/秒的稳定脉冲（≈ 每拍一次）。
    // ② 节流：音频层的 beat 最密可到 ~4 次/秒，连着撞会糊成一片、看不出跟拍；
    //    再加一道 0.36s 本地节流（≈167BPM 以下 = 每个重拍撞一次）→ 撞点分明、一眼看得出节奏。
    // ③ 强度：仍由这一拍的 bass 与超出均值的幅度决定 —— 重拍撞得大、轻拍撞得小。
    // ④ 爆炸时机（2026-10-15 改）：节拍【不直接引爆】—— 只更新能量/间隔估计、靶缺位时补靶；
    //    引爆严格等「靶陨石真实贴上流星」的那一帧（见 _updateTarget 后的接触判定），
    //    既不会没碰到就炸、也不会贴上很久才炸；接近用时按节拍间隔对齐（_spawnTarget），
    //    所以每次接触仍大致落在拍上。
    this._impactCd -= dt;
    const bassNow = bands.bass || 0;
    const q = this._bassQ;
    q.push(bassNow);
    const win = Math.max(8, Math.round(1 / Math.max(dt, 1 / 240)));   // ≈1s 的采样数（与帧率无关）
    while (q.length > win) q.shift();
    let bsum = 0; for (let i = 0; i < q.length; i++) bsum += q[i];
    const bassAvg = bsum / q.length;
    const ex = bassAvg > 0.001 ? Math.max(0, bassNow / bassAvg - 1) : 0;   // 超出均值的相对幅度
    const onset = bands.beat || (bassNow > 0.10 && bassNow > bassAvg * 1.05);
    if (onset && this._impactCd <= 0) {
      if (this._lastImpactT > 0) this._lastGap = clamp(t - this._lastImpactT, 0.24, 1.6);
      this._lastImpactT = t;
      this._impactCd = 0.36;
      this._beatE = clamp(0.4 + bassNow * 1.2 + (bands.beat ? 0.6 : 0) + ex * 1.2, 0.15, 2.5);
      // 靶缺位（上一次刚炸完还没补/首拍前）时立刻补一颗上前；引爆交给接触判定
      const tm = this._r3 && this._r3.tgt;
      if (tm && !tm.visible) this._spawnTarget();
    }
    this._beat *= Math.pow(0.03, dt);
    this._shake *= Math.pow(0.012, dt);
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
    // 节拍全屏微闪（亮度随这一拍的撞击能量走 → 重拍闪得更亮，节奏感更强）
    if (this._beat > 0.02) {
      ctx.fillStyle = `hsla(${hue}, 80%, 60%, ${this._beat * (0.06 + this._beatE * 0.035)})`;
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
    // 陨石姿态：本地 +Z 对齐飞行方向（迎风炽面恒定朝前），再绕飞行轴缓慢翻滚 →
    // 有不规则岩体的翻滚自转感，但不会把炽热面转到背面去
    if (!this._mqTmp) {
      this._mqTmp = { qi: new T.Quaternion(), qr: new T.Quaternion(), vz: new T.Vector3(0, 0, 1), vd: new T.Vector3() };
    }
    const mq = this._mqTmp;
    mq.vd.copy(this._mVel);
    if (mq.vd.lengthSq() < 1e-6) mq.vd.set(0, 0, 1); else mq.vd.normalize();
    mq.qi.setFromUnitVectors(mq.vz, mq.vd);
    this._rollAng += dt * (0.5 + this._mid * 0.9);
    mq.qr.setFromAxisAngle(mq.vd, this._rollAng);
    r3.meteor.quaternion.copy(mq.qr).multiply(mq.qi);
    // 迎风面热辉光：亮/暗随节拍、低频与高频抖动（火焰不稳定感）；色相固定暖橙（真实烧岩，不跟主题冷色）
    const fl = 0.5 + this._beat * 0.5 + this._bass * 0.35 + Math.sin(t * 23.0) * 0.08 + Math.sin(t * 41.0) * 0.05;
    r3.hotMat.uniforms.uAmp.value = 0.35 + fl * 0.55;
    r3.hotMat.uniforms.uCol.value.setHSL(0.055, 0.95, 0.55 + this._beat * 0.10);
    r3.heatMat.opacity = 0.16 + this._beat * 0.22 + this._bass * 0.14;
    r3.heatGlow.scale.setScalar((0.72 + this._bass * 0.16 + this._beat * 0.20) * (1 + Math.sin(t * 29.0) * 0.05));
    // 整体轻微呼吸脉冲（岩体+热壳+辉光同步，形变克制）
    r3.meteor.scale.setScalar(1 + this._bass * 0.09 + this._beat * 0.16);
    r3.meteorLight.intensity = 0.5 + this._beat * 1.2 + this._bass * 0.6;
    r3.meteorLight.color.setHSL(hue / 360, 0.8, 0.6);

    // —— 流星拖尾：沿路径重建相机朝向的带状网格 ——
    // 每帧从 _mTrail 环缓冲取点，侧向 = 路径方向 × 指向相机，形成始终面向镜头的光带
    // 按「世界距离」采样而非每帧采样：180fps 下每帧采样会让 44 个点只覆盖 0.24 秒行程（拖尾短到看不见），
    // 改为每前进 _TRAIL_STEP 记一点 → 拖尾长度恒定于世界空间，且与帧率无关
    const head = this._mTrail[0];
    if (!head || head.distanceToSquared(this._mPos) >= this._TRAIL_STEP * this._TRAIL_STEP) {
      this._mTrail.unshift(this._mPos.clone());
      if (this._mTrail.length > this._TRAIL_MAX) this._mTrail.pop();
      this._trailIdle = 0;
    } else if ((this._trailIdle += dt) > 0.5) {
      this._mTrail.length = 0;   // 原地悬停 → 无尾迹（岩石停在半空不该拖着火尾）
      this._trailIdle = 0;
    }
    // —— 拖尾粒子发射：dt 累加器按「每秒速率」发射（帧率无关）；发射方向改为
    //    全球均匀随机（四周环绕 = 相机从哪个方向看都能看到尾巴，不再偏向前方/后方）——
    const pathLen = this._mTrail.length;
    const histMax = Math.max(0, Math.min(pathLen - 1, 20));
    const spk = r3.sparkPool, smk = r3.smokePool, cor = r3.corePool;
    // 核心光条：超高密度、头部优先发射 → 制造"炽热轨迹"（代替旧的扁平 ribbon）
    this._coreAcc = (this._coreAcc || 0) + dt * (620 + this._tre * 400 + this._bass * 280);
    while (this._coreAcc >= 1) {
      this._coreAcc -= 1;
      const hi = Math.max(0, Math.min(histMax, Math.floor(Math.pow(Math.random(), 1.3) * (histMax + 1))));
      const p = this._mTrail[hi] || this._mPos;
      // 速度方向：球均匀随机（四周环绕）
      let dx, dy, dz, d2;
      do { dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1; d2 = dx * dx + dy * dy + dz * dz; } while (d2 > 1 || d2 < 1e-6);
      const inv = 1 / Math.sqrt(d2);
      const sp = 0.25 + Math.random() * 0.8;
      this._emitTrail(cor,
        p.x + (Math.random() - 0.5) * 0.04, p.y + (Math.random() - 0.5) * 0.04, p.z + (Math.random() - 0.5) * 0.04,
        dx * inv * sp, dy * inv * sp, dz * inv * sp,
        0.18 + Math.random() * 0.32, 0.06 + Math.random() * 0.07);
    }
    // 火花层：随机方向爆发（不再绑定速度方向 → 相机从哪个角度看都能看到火花层）
    this._sparkAcc = (this._sparkAcc || 0) + dt * (160 + this._tre * 300 + this._bass * 240 + this._beat * 320);
    while (this._sparkAcc >= 1) {
      this._sparkAcc -= 1;
      const hi = Math.max(0, Math.min(histMax, Math.floor(Math.pow(Math.random(), 1.7) * (histMax + 1))));
      const p = this._mTrail[hi] || this._mPos;
      let dx, dy, dz, d2;
      do { dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1; d2 = dx * dx + dy * dy + dz * dz; } while (d2 > 1 || d2 < 1e-6);
      const inv = 1 / Math.sqrt(d2);
      const sp = 0.9 + Math.random() * 1.8;
      this._emitTrail(spk,
        p.x + (Math.random() - 0.5) * 0.06, p.y + (Math.random() - 0.5) * 0.06, p.z + (Math.random() - 0.5) * 0.06,
        dx * inv * sp, dy * inv * sp, dz * inv * sp,
        0.35 + Math.random() * 0.85, 0.10 + Math.random() * 0.17);
    }
    // 烟雾层：同样四周随机方向（缓慢上浮 + 膨胀）
    this._smokeAcc = (this._smokeAcc || 0) + dt * (24 + this._tre * 40 + this._bass * 26);
    while (this._smokeAcc >= 1) {
      this._smokeAcc -= 1;
      const hi = pathLen > 1 ? Math.floor(Math.random() * Math.min(pathLen, 24)) : 0;
      const p = this._mTrail[hi] || this._mPos;
      let dx, dy, dz, d2;
      do { dx = Math.random() * 2 - 1; dy = Math.random() * 2 - 1; dz = Math.random() * 2 - 1; d2 = dx * dx + dy * dy + dz * dz; } while (d2 > 1 || d2 < 1e-6);
      const inv = 1 / Math.sqrt(d2);
      const sp = 0.15 + Math.random() * 0.4;
      this._emitTrail(smk,
        p.x + (Math.random() - 0.5) * 0.18, p.y + (Math.random() - 0.5) * 0.18, p.z + (Math.random() - 0.5) * 0.18,
        dx * inv * sp, dy * inv * sp, dz * inv * sp,
        1.3 + Math.random() * 1.8, 0.20 + Math.random() * 0.28);
    }
    // 步进三池：核心光条（超短命，几乎原地）、火花（快速阻尼）、烟雾（缓慢上浮膨胀）
    this._stepTrailPool(cor, dt, 0.10, 0.02, 0.55);
    this._stepTrailPool(spk, dt, 0.20, 0.05, 0.30);
    this._stepTrailPool(smk, dt, 2.6, 0.22, 0.35);

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

    // 行星：缓慢自转 + 跟随流星作为远景天幕（行星太远不做回收）
    for (const pl of r3.planets) pl.mesh.rotation.y += pl.spin * dt;
    r3.planetGroup.position.set(mx, my, mz);

    // —— 相机：3D 球面轨道环绕流星，从四周各个角度观察（侧跟、迎头、俯拍、仰拍、追尾）
    // 双自由度：方位角 camAng（绕 Y 轴，~70s 一圈 + 音乐调制）+ 俯仰角 camPol（极轴偏移，缓慢正弦）
    // 半径呼吸让流星有远近纵深，视线始终锁定流星本体
    if (this._camAng == null) { this._camAng = Math.PI * 1.5; this._camPol = 0.25; }
    this._camAng += dt * (0.09 + this._mid * 0.04);
    this._camPol += dt * (0.04 + this._tre * 0.02);
    // 俯仰角在 -1.0 ~ 1.5 之间正弦摆动（避开两极的万向锁死角）
    const pol = Math.sin(this._camPol) * 1.1 + 0.3;   // -0.8 ~ 1.4
    const camR = 6.8 + Math.sin(t * 0.13) * 2.2;
    const sinP = Math.sin(pol), cosP = Math.cos(pol);
    const sx = Math.sin(this._camAng) * sinP;
    const sy = cosP;
    const sz = Math.cos(this._camAng) * sinP;
    const tx2 = mx + sx * camR;
    const ty2 = my + sy * camR;
    const tz2 = mz + sz * camR;
    const ck = Math.min(1, dt * 1.5);
    const cam = this._camBase || (this._camBase = new this._THREE.Vector3().copy(r3.camera.position));
    cam.x += (tx2 - cam.x) * ck;
    cam.y += (ty2 - cam.y) * ck;
    cam.z += (tz2 - cam.z) * ck;
    // 撞击震动：抖动只叠加在「显示位」上 —— 平滑基准 cam 保持干净，否则每帧随机偏移会被
    // 下一帧的 lerp 当起点累积成随机游走，镜头会慢慢漂离轨道
    const shk = this._shake;
    r3.camera.position.set(
      cam.x + (Math.random() - 0.5) * shk * 0.30,
      cam.y + (Math.random() - 0.5) * shk * 0.30,
      cam.z
    );
    r3.camera.lookAt(
      mx + this._mVel.x * 0.3 + (Math.random() - 0.5) * shk * 0.55,
      my + this._mVel.y * 0.3 + (Math.random() - 0.5) * shk * 0.55,
      mz + this._mVel.z * 0.3
    );

    // 靶陨石：相机位姿已定 → 此刻摆放它，本帧即可正确渲染（见 _updateTarget）
    this._updateTarget(r3, dt);
    // —— 接触引爆：爆炸的唯一触发点 —— 靶陨石真实贴到流星上（dist ≤ contact）的这一帧才炸，
    //    不会没碰到就炸、也不会贴上很久才炸；强度取最近一拍的能量 → 重拍炸得大。
    //    全屏微闪/陨石脉冲的 _beat 也在这一瞬间置 1（而不是拍点），视听因果对齐。
    const tm = r3.tgt, tg2 = this._tgt;
    if (tm && tm.visible && tg2.dist <= tg2.contact) {
      const e = clamp(this._beatE || 0.6, 0.15, 2.5);
      this._beat = 1;
      this._explode(e, tm.position);
      this._spawnRing(tm.position, e);   // 3D 冲击环：环面 ⊥ 流星运动方向
      this._shake = Math.min(0.7, this._shake + e * 0.22);   // 震屏收敛（旧版 ×0.55/上限1.5 晃得太大）
      tm.visible = false;
      // 被撞陨石按节奏出现：这里不补 —— 下一拍到来时由节拍块 _spawnTarget() 放出新的
    }
    // —— 碰撞冲击环更新：环面固定 ⊥ 撞击瞬间的运动方向，向外扩张并淡出 ——
    for (const rg of r3.rings) {
      if (!rg.on) continue;
      rg.life += dt;
      const p = rg.life / rg.max;
      if (p >= 1) { rg.on = false; rg.mesh.visible = false; continue; }
      rg.mesh.scale.setScalar(0.35 + p * (2.4 + rg.e * 1.8));
      rg.mesh.material.opacity = Math.pow(1 - p, 1.5) * (0.55 + rg.e * 0.3);
    }

    // —— 渲染 ——
    r3.renderer.render(r3.scene, r3.camera);
    // WebGL 层以「加色」合成到 2D 背景上：空像素（黑）不影响背景，光球/光晕/拖尾/星光
    // 的 RGB 直接叠加发光；source-over 会让 halo 等加色体的 alpha 累积成不透明，
    // 把暖色 2D 渐变背景整片盖掉、露出 WebGL 内部的纯黑，形成暗色多面体壳
    ctx.globalCompositeOperation = 'lighter';
    ctx.drawImage(r3.renderer.domElement, 0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';
  }
}

/* ---------- 场景九：声波涟漪（2026-10-16 重做：GPU 光线求交 3D 水面，精美版）
   低机位相机掠过镜面水体：同心涟漪的幅度绕圆周跟随频谱分布，鼓点砸出扩散波环；
   逐像素法线 → 菲涅尔反射霓虹天空/星野 + 碎钻太阳高光 + 距离雾；
   波峰按频谱能量染色辉光，鼓点全场呼吸；色调映射 + 暗角收尾。
   配置：波高 amp / 涟漪强度 rip / 流速 spd（mgr.waveCfg 每帧实时生效） ---------- */
const WAVE_FRAG = `
uniform vec2 uRes; uniform float uTime,uBass,uMid,uTre,uBeat,uLevel;
uniform vec3 uColA,uColB;
uniform float uAmp,uRip,uSpd;
uniform sampler2D uSpec;
uniform vec4 uDrops[4];
${RM_NOISE}
float waveH(vec2 p){
  float r=length(p);
  float sa=fract(atan(p.y,p.x)/6.28318+0.5);
  float sam=abs(sa-0.5)*2.0;                     // 镜像折叠：消除角度环绕接缝
  float spec=texture2D(uSpec,vec2(sam,0.5)).r*smoothstep(0.05,0.6,r); // 中心淡出防漩涡伪影
  float h=0.0;
  // 主波纹：径向外传，幅度随该角度频谱能量起伏
  h+=sin(r*7.0-uTime*(2.6*uSpd))*(0.10+spec*0.55*uAmp)*uRip;
  h+=sin(r*13.0-uTime*(4.2*uSpd)+sam*12.566)*spec*0.16*uAmp*uRip;
  // 鼓点水滴：环形波前扩散 + 指数衰减
  for(int i=0;i<4;i++){
    float age=uTime-uDrops[i].x;
    if(age>0.0&&age<5.0){
      float wv=age*1.6;
      float g=exp(-pow((r-wv)*2.4,2.0));
      h+=g*sin((r-wv)*10.0-age*3.0)*0.30*uDrops[i].y*exp(-age*0.9);
    }
  }
  // 环境微浪
  h+=sin(p.x*2.3+uTime*0.9)*sin(p.y*1.9-uTime*0.7)*0.05*uRip;
  return h*smoothstep(0.02,0.45,r);   // 中心风平浪静：涟漪眼成镜面，消除漩涡伪影
}
vec3 skyCol(vec3 rd){
  vec3 sky=mix(uColB*0.12+uColA*0.07,vec3(0.004,0.005,0.010),clamp(rd.y*2.2,0.0,1.0));
  sky+=uColB*0.30*exp(-abs(rd.y+0.02)*8.0);        // 地平线霓虹光带
  sky+=uColA*0.10*exp(-abs(rd.y+0.10)*4.0);
  // 落日辉光（天际正中的柔光球，水面会映出碎光路）
  float sun=exp(-pow(length(vec2(rd.x*1.6,rd.y-0.045))*4.2,2.0));
  sky+=(uColA*0.38+vec3(0.22,0.18,0.24))*sun;
  vec3 sg=floor(rd*230.0);
  float st=rmHash(sg);
  if(st>0.9985) sky+=vec3(0.9)*max(0.0,sin(uTime*2.4+st*80.0))*0.85; // 稀疏星点（只增亮，不产生黑斑）
  return sky;
}
void main(){
  vec2 uv=(2.0*gl_FragCoord.xy-uRes)/uRes.y;
  vec3 ro=vec3(0.0,1.10+uBass*0.10,2.4);
  vec3 rd=normalize(vec3(uv.x,uv.y-0.10,-1.5));
  vec3 col=skyCol(rd);
  if(rd.y<-0.004){
    float tH=-ro.y/rd.y;
    vec2 xz=(ro+rd*tH).xz*0.55;
    float e=0.05;
    float hC=waveH(xz);
    float hX=waveH(xz+vec2(e,0.0));
    float hZ=waveH(xz+vec2(0.0,e));
    vec3 n=normalize(vec3(hC-hX,e*2.2,hC-hZ));
    vec3 rr=reflect(rd,n);
    rr.y=abs(rr.y)*0.9+0.05;
    vec3 refl=skyCol(normalize(rr));
    float fres=mix(0.05,1.0,pow(1.0-max(0.0,dot(-rd,n)),4.0));
    vec3 deep=uColA*0.045+uColB*0.03;             // 深水色
    col=mix(deep,refl,fres);
    // 波峰辉光（频谱能量染色）
    float crest=smoothstep(0.04,0.28,hC);
    col+=uColA*crest*(0.45+0.55*uLevel);
    col+=uColB*smoothstep(0.10,0.40,hC)*uBeat*0.7;
    // 主光高光（碎钻闪点，随高频更亮）
    vec3 sunDir=normalize(vec3(0.25,0.22,-0.94));
    float glint=pow(max(0.0,dot(rr,sunDir)),80.0);
    col+=(uColA*0.7+vec3(0.5))*glint*(0.5+uTre*0.9);
    // 距离雾融入天际
    float fog=1.0-exp(-tH*0.05);
    col=mix(col,skyCol(normalize(vec3(rd.x,0.02,rd.z)))*0.8,fog*0.75);
  }
  col*=1.0+uBeat*0.12;                            // 鼓点全场呼吸
  col*=1.0-0.32*pow(length(uv*vec2(0.55,0.85)),2.2); // 暗角
  col=col/(1.0+col);                              // 色调映射
  gl_FragColor=vec4(pow(max(col,vec3(0.0)),vec3(0.4545)),1.0);
}`;
class WaveScene extends RaymarchSceneBase {
  constructor(mgr) {
    super(mgr, WAVE_FRAG);
    this._dropIdx = 0;
    this._spec = new Float32Array(64);   // 平滑频谱（写入 64x1 纹理）
    this._specTex = null;
  }
  _uniforms3x(T, u) {
    u.uAmp = { value: 1 }; u.uRip = { value: 1 }; u.uSpd = { value: 1 };
    const fmt = T.RedFormat !== undefined ? T.RedFormat : T.LuminanceFormat;
    this._specTex = new T.DataTexture(new Uint8Array(64), 64, 1, fmt, T.UnsignedByteType);
    this._specTex.magFilter = T.LinearFilter; this._specTex.minFilter = T.LinearFilter;
    this._specTex.needsUpdate = true;
    u.uSpec = { value: this._specTex };
    u.uDrops = { value: [0, 1, 2, 3].map(() => new T.Vector4(-99, 0, 0, 0)) };
  }
  _frame3x(dt, t, bands, bins) {
    const u = this._r3.uniforms, cfg = this.mgr.waveCfg || { amp: 1, rip: 1, spd: 1 };
    u.uAmp.value = cfg.amp; u.uRip.value = cfg.rip; u.uSpd.value = cfg.spd;
    // 频谱 → 64 柱平滑 → 写纹理（攻快放慢，柱间线性插值由纹理过滤完成）
    const n = bins ? bins.length : 0;
    for (let i = 0; i < 64; i++) {
      const v = n ? (bins[Math.floor((i / 64) * n)] || 0) : 0;
      this._spec[i] += (v - this._spec[i]) * Math.min(1, dt * (v > this._spec[i] ? 18 : 8));
      this._specTex.image.data[i] = Math.round(Math.min(1, this._spec[i]) * 255);
    }
    this._specTex.needsUpdate = true;
    // 鼓点 → 水滴入池（4 槽循环，强度随低频）
    if (bands.beat) {
      u.uDrops.value[this._dropIdx].set(t, 0.6 + Math.min(0.4, this._bass * 0.5), 0, 0);
      this._dropIdx = (this._dropIdx + 1) % 4;
    }
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


/* ---------- 微信对话：DOM 覆盖层场景（#wxChat，ui.js 驱动歌词打字机） ----------
   画布层只压暗衬底 —— 聊天界面/CD/背景封面全是 DOM，性能开销几乎为零 */
class WxChatScene {
  constructor(mgr) { this.mgr = mgr; }
  resize() {}
  onTrack() {}
  frame(ctx, w, h) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#06070b';
    ctx.fillRect(0, 0, w, h);
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
       场景每帧读 mgr.pal.hue/hue2，渐变自动作用于全部视角场景 */
    this._palCur = null;   // 当前缓动色相（浮点，最短 hue 路径插值）
    this._palTgt = null;   // 目标色相 { hue, hue2 }
    this._palWaveT = -1;   // 换色扩散波起始（渲染秒，-1=无）：新色相从画布中心径向扩散覆盖（hue 混合）
    this._palSyncAt = 0;   // 上次 CSS 氛围变量同步时刻：过渡期间 80ms 节流，防全界面每帧重绘卡顿
    this.palRandom = false; // 节奏随机换色开关（settings.palRandom）
    this.palSpeed = 2.2;    // 换色过渡时长（秒，settings.palSpeed 1-5，视觉控制台可调；仍由节奏点触发）
    this.palTrig = 'beat';  // 换色触发模式：beat 跟随节奏 / random 随机时间 / fixed 固定间隔（settings.palTrig）
    this.palGap = 6;        // 换色间隔（秒，settings.palGap 3-15；random=随机上限、fixed=固定周期）
    this._rndLast = 0;      // 上次随机换色时刻（渲染秒）：限制最小间隔防频闪
    this._rndNext = 0;      // random 模式的下次触发时刻（渲染秒）
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
      flow: new DiscoBallScene(this),
      collide: new CollideScene(this),
      vinyl: new VinylScene(this),
      wave: new WaveScene(this),
      field: new EnergyFieldScene(this),
      mirror: new MirrorWaveScene(this),
      pv: new PvScene(this),
      wxchat: new WxChatScene(this)
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
    this.flowCfg = { count: 6000, spd: 1, size: 1 }; // 迪斯科球：镜面数量 800-15000 / 旋转速度 0.2-2 / 光点大小 0.5-2（设置中心实时写入；数量变化场景内重建）
    this.waveCfg = { amp: 1, rip: 1, spd: 1 };     // 声波涟漪：波高 0.3-2 / 涟漪强度 0-2 / 流速 0.3-2（设置中心实时写入）
    this.collideCfg = { count: 500, rest: 0.92, shock: 1, trail: 0.45 }; // 流星碰撞：碎片数量 300-2400 / 飞行阻尼 0.5-1 / 爆炸强度 0-2 / 拖尾亮度 0-0.9（设置中心实时写入）
    this.fieldCfg = { count: 900, power: 1, shake: 0.7 };    // 粒子能量场：数量 300-2400 / 爆发强度 0.5-2 / 镜头震动 0-1（设置中心实时写入）
    this.mirrorCfg = { amp: 1, glow: 1, pcount: 140 };       // 镜像波形：幅度 0.5-2 / 辉光 0.5-2 / 粒子数量 0-300（设置中心实时写入）

    this._resize();
    window.addEventListener('resize', () => this._resize());
    engine.addEventListener('palette', (e) => {
      this.setPaletteHue(e.detail.hue, e.detail.hue2); // 统一走渐变入口
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
    if (patch.grid != null) c.grid = Math.round(clamp(+patch.grid, 32, 512));
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

  /** 迪斯科球配置：镜面数量 800-15000 / 旋转速度 0.2-2 / 光点大小 0.5-2（设置中心持久化；数量变化由场景内部比对重建 geometry） */
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
      封面粒子云采样在过渡收尾时重建一次（粒子颜色来自采样而非逐帧 hue） */
  setPaletteHue(hue, hue2) {
    const t = { hue: Math.round(hue), hue2: Math.round(hue2) };
    if (!this._palCur) { // 首次：直接落色
      this._palCur = { ...t };
      this._palTgt = { ...t };
      this._palStart = { ...t };
      this._palStartAt = 0;
      this.pal = { ...t };
      this._syncPalVars();
      this.scenes.cover.setCover(this.coverImg, this.pal);
      return;
    }
    this._palStart = { ...this._palCur }; // 从当前显示色相出发（连续换色不跳变）
    this._palStartAt = performance.now() / 1000;
    this._palTgt = t;
    this._palWaveT = performance.now() / 1000; // 启动径向扩散波：新色相从画布中心往外扫（波先扫到，颜色随后铺满）
    // 独立推进：渲染循环仅在播放/活跃时运行，未播放时点色板/换歌也要看到渐变 →
    // 挂自终止 rAF 微循环（与主循环的 _palTick 幂等：定时插值重复调用安全，到位自动停）
    if (this._palRaf) cancelAnimationFrame(this._palRaf);
    const step = () => {
      this._palTick();
      this._palRaf = this._palAtTarget() ? 0 : requestAnimationFrame(step);
    };
    this._palRaf = requestAnimationFrame(step);
  }

  /** 节奏随机换色开关（视觉控制台 COLOR 分区「随机颜色」）：开 → 每个节奏点（限最小间隔）
      随机跳一个新目标色相，经渐变过渡；关 → 恢复当前配色来源（ui.js 调 theme.applyFromTrack） */
  setPaletteRandom(on) {
    this.palRandom = !!on;
    if (on) { this._rndLast = 0; this._rndNext = performance.now() / 1000 + 2; } // 开启后尽快换一次
  }

  /** 换色过渡时长（秒，视觉控制台「换色速度」滑块 1-5s；触发时机仍跟随节奏点/手动换色不变） */
  setPaletteSpeed(sec) {
    this.palSpeed = clamp(+sec || 2.2, 1, 5);
  }

  /** 换色触发模式（视觉控制台）：beat=跟随节奏点 / random=随机时间 / fixed=固定间隔 */
  setPaletteTrig(mode) {
    this.palTrig = ['beat', 'random', 'fixed'].includes(mode) ? mode : 'beat';
    this._rndNext = performance.now() / 1000 + 2; // 切模式后 2s 起首次触发
  }
  /** 换色间隔（秒）：random=随机上限（2~2+gap 秒）、fixed=固定周期 */
  setPaletteGap(sec) {
    this.palGap = clamp(+sec || 6, 3, 15);
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

  /** palSpeed 秒 smoothstep 定时插值：色相沿最短 hue 路径从起点匀滑走到目标（前缓后缓，观感从容）。
      量化到整度（逐柱色相缓存按度重烘焙）；到位帧重建封面粒子采样（兜底色相跟随新色） */
  _palTick() {
    const start = this._palStart, tgt = this._palTgt;
    if (!start || !tgt) return;
    const p = Math.min(1, (performance.now() / 1000 - (this._palStartAt || 0)) / this.palSpeed);
    const e = p * p * (3 - 2 * p); // smoothstep：0→1 前缓后缓
    const hue = start.hue + (((tgt.hue - start.hue + 540) % 360) - 180) * e;
    const hue2 = start.hue2 + (((tgt.hue2 - start.hue2 + 540) % 360) - 180) * e;
    if (p >= 1) { // 到位
      if (this.pal.hue !== tgt.hue || this.pal.hue2 !== tgt.hue2) {
        this._palCur = { ...tgt };
        this.pal = { ...tgt };
        this._syncPalVars();
        this.scenes.cover.setCover(this.coverImg, this.pal); // 收尾重建一次粒子采样
      }
      return;
    }
    const q1 = Math.round(((hue % 360) + 360) % 360), q2 = Math.round(((hue2 % 360) + 360) % 360); // 归一 0-359（CSS/缓存键/下游取模安全）
    this._palCur = { hue, hue2 };
    if (q1 !== this.pal.hue || q2 !== this.pal.hue2) {
      this.pal = { hue: q1, hue2: q2 };
      // CSS 氛围变量过渡期 80ms 节流：画布每帧直读 pal 不受影响，UI 歌词辉光等 80ms 内跟上无感知，
      // 避免每帧写 --pal-hue/--amb 触发大面积界面重绘（换色卡顿主因之一）
      const nowS = performance.now() / 1000;
      if (nowS - this._palSyncAt > 0.08) { this._palSyncAt = nowS; this._syncPalVars(); }
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

        // 随机换色触发：beat=节奏点（≥5s 防频闪）/ random=2~2+gap 秒随机间隔 / fixed=固定 gap 秒周期；
        // 统一要求上次过渡已到位（过渡中不叠新目标）
        if (this.palRandom && this._palAtTarget()) {
          let fire = false;
          if (this.palTrig === 'random') {
            if (t >= this._rndNext) { fire = true; this._rndNext = t + 2 + Math.random() * this.palGap; }
          } else if (this.palTrig === 'fixed') {
            if (t - this._rndLast >= this.palGap) fire = true;
          } else if (bands.beat && t - this._rndLast > 5) {
            fire = true;
          }
          if (fire) { this._rndLast = t; this._randomizePal(); }
        }
        this._palTick(); // 调色板 2.2s 定时插值：所有场景颜色渐变逼近目标

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

        // 换色径向扩散波：新色相从画布中心往外扫（hue 混合只换色相、保留画面明暗结构），
        // 波时长 = 换色速度 × 0.82（2.2s 档 ≈1.8s），与颜色过渡同步到位
        const waveDur = Math.max(0.8, this.palSpeed * 0.82);
        if (this._palWaveT >= 0) {
          const wp = (t - this._palWaveT) / waveDur;
          if (wp >= 1) {
            this._palWaveT = -1; // 扩散结束：全画面即新色，无接缝
          } else if (this._palTgt) {
            const p = wp, eio = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2; // easeInOutCubic：缓起缓收，扩散从容
            const cx = this.w / 2, cy = this.h / 2;
            const r = 10 + eio * Math.hypot(this.w, this.h) * 0.62; // 中心到最远角
            const feather = Math.max(this.h * 0.3, 60); // 环带羽化宽度
            const gWave = this.ctx.createRadialGradient(cx, cy, Math.max(0, r - feather), cx, cy, r);
            gWave.addColorStop(0, `hsla(${this._palTgt.hue}, 85%, 55%, 1)`);   // 波内：完全取新色相
            gWave.addColorStop(0.72, `hsla(${this._palTgt.hue}, 85%, 55%, 0.5)`);
            gWave.addColorStop(1, `hsla(${this._palTgt.hue2}, 85%, 55%, 0)`);  // 波前缘：融入旧画面
            this.ctx.globalCompositeOperation = 'hue';
            this.ctx.fillStyle = gWave;
            this.ctx.fillRect(0, 0, this.w, this.h);
            this.ctx.globalCompositeOperation = 'source-over';
          }
        }

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

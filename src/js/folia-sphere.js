/* 歌单封面圆柱（FoliaSphere，2026-10-15 由球面改为圆柱内视）
   用户语义：
   - 「视角在圆柱体中间」：相机在轴心，面朝 -Z，封面瓦片贴圆柱内壁
   - 「只能左右移动」：仅绕世界 Y 轴旋转（拖动/惯性/滚轮都是水平），360° 无限环绕无边界
   - 「边缘不能是黑的」：圆柱垂直方向上下各多铺 2 行余量，FOV 内永远有封面（球面版的
     网格尽头渐隐已删除）
   - 「卡片放大」：屏幕垂直可见 6 行（原 8 行）
   - 「所有卡片显示歌名」：图集每格底部叠渐变条 + 歌名/歌手（hero 卡共用图集 → 飞行途中也有）
   - 「点击卡片飞出来放大 + 控制器 + ⤢ 进歌词MV」：英雄卡从圆柱壁位置向内飞向相机前方
     billboard，DOM overlay（ui.js #pfSphereHeroDom）贴合，交互链路不变
   流畅度：指针位移只在 pointermove 里累计，旋转统一在 rAF 里按 dt 计算；
   阻尼用 pow(damp, dt*60) 归一；pixelRatio 封顶 1.5；每帧零分配。
   性能：全量封面合并为一张图集（atlas），圆柱与英雄卡各自只占一次绘制调用。 */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TILE = 144;               // 图集中单张封面尺寸
const ATLAS_COLS = 8;           // 图集起始列数（行数超限时自动加宽）
const MAX_TEX = 16384;          // GPU 单边纹理上限

const FOV = 68;                 // 相机视场角（内部视角，68° 包裹感与边缘畸变更平衡）
const R = 5.0;                  // 圆柱半径（固定大圆柱，包裹相机）
const COVER_K = 0.97;           // 瓦片覆盖系数：理论相切，留 3% 呼吸缝
const ROWS_VIEW = 6;            // 屏幕垂直可见行数（越小卡片越大；用户要求放大 → 6 行）
const CYL_MARGIN = 2;           // 圆柱上下各多铺的行数余量（保证垂直永远不露边）

const DRAG_K = 0.0052;          // 每像素拖动对应的旋转弧度
const DAMP = 0.94;              // 每 1/60 秒保留的速度比例

const HERO_DIST = 1.5;          // 英雄卡最终停在相机前方的距离（在 R=5 内侧）
const HERO_SCREEN = 0.55;       // 英雄卡最终占视口高度的比例（放大！）
const HERO_DUR = 0.5;           // 飞出 / 飞回时长（秒）

const easeOut = (t) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export class FoliaSphere {
  constructor(canvas) {
    this.canvas = canvas;
    this._dead = false;
    this._ready = false;
    this.tracks = [];
    this._lastFocusIdx = 0;
    this._quat = null;             // 圆柱姿态（只绕世界 Y 轴）
    this._omegaY = 0;              // 惯性：绕世界 Y 轴角速度（rad/s）
    this._pendX = 0;               // 本帧待应用的水平手指位移（px）
    this._pendY = 0;
    this._drag = null;
    this._last = 0;
    this._holeTile = -1;           // 被挖洞的瓦片（-1 = 无）
    this._hero = { on: false, tile: -1, track: -1, p: 0, phase: 'out', pending: -1, arrived: false };
    this.onTileClick = null;       // (trackIdx) => void 点击瓦片
    this.onTileCenter = null;      // (trackIdx) => void 英雄卡飞到面前（用于挂 DOM 控制器）
    this.onHeroBack = null;        // () => void 英雄卡飞回（清理 DOM 控制器）
    this.onHeroUpdate = null;      // ({ x, y, cssW, cssH, arrived }) => void 每帧推送 hero 卡屏幕矩形
    this._ac = new AbortController();
  }

  async init(tracks) {
    this.tracks = tracks || [];
    const mod = await import('../vendor/three/three.module.js');
    this._T = mod;
    this._axX = new mod.Vector3(1, 0, 0);
    this._axY = new mod.Vector3(0, 1, 0);
    this._qa = new mod.Quaternion();
    this._ray = new mod.Raycaster();
    this._ndc = new mod.Vector2();
    await this._buildAtlas();
    this._buildMesh();
    this._bindPointer();
    this._ready = true;
    // 图集是异步的（首屏封面要等），进入歌单时的自动聚焦可能早于建网格 → 补一次
    const q = this._queuedFocus;
    this._queuedFocus = null;
    if (q) this._spawnHero(q.idx, q.notify);
    this._last = performance.now();
    this._loop();
    return this;
  }

  /* 图集：把全部封面画进一张大 canvas → 作为单一 texture（行数超限时自动加宽列数） */
  async _buildAtlas() {
    const T = this._T;
    const n = Math.max(1, this.tracks.length);
    const maxRows = Math.floor(MAX_TEX / TILE);
    let cols = ATLAS_COLS;
    let rows = Math.ceil(n / cols);
    if (rows > maxRows) {
      cols = Math.ceil(n / maxRows);
      rows = Math.ceil(n / cols);
    }
    const cv = document.createElement('canvas');
    cv.width = cols * TILE;
    cv.height = rows * TILE;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#15151d';
    ctx.fillRect(0, 0, cv.width, cv.height);
    this._atlasCanvas = cv;
    this._atlasCtx = ctx;
    this._atlasCols = cols;
    this._atlasRows = rows;
    // 先铺占位色块，图片异步到位后逐格补画
    const PAD = 2;   // 每格四周留白（避免相邻封面边缘渗色）
    this._atlasPad = PAD;
    // 卡片歌名条：封面底部叠 30% 高渐变 + 歌名/歌手两行小字（网格所有卡片直接可见，
    // 与 hero 卡共用图集 → 飞行途中也有歌名）
    const drawLabel = (i) => {
      const s = this.tracks[i];
      if (!s) return;
      const cx = (i % cols) * TILE, cy = Math.floor(i / cols) * TILE;
      const gh = Math.round(TILE * 0.30);
      const g = ctx.createLinearGradient(0, cy + TILE - gh, 0, cy + TILE);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.78)');
      ctx.fillStyle = g;
      ctx.fillRect(cx, cy + TILE - gh, TILE, gh);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = '#ffffff';
      ctx.font = `600 ${Math.round(TILE * 0.105)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(String(s.name || s.title || ''), cx + TILE / 2, cy + TILE - gh * 0.46, TILE - 14);
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.font = `${Math.round(TILE * 0.085)}px "Segoe UI", system-ui, sans-serif`;
      ctx.fillText(String(s.artist || ''), cx + TILE / 2, cy + TILE - gh * 0.18, TILE - 14);
    };
    this.tracks.forEach((s, i) => {
      const cx = (i % cols) * TILE, cy = Math.floor(i / cols) * TILE;
      ctx.fillStyle = `hsl(${(i * 47) % 360} 30% 20%)`;
      ctx.fillRect(cx + PAD, cy + PAD, TILE - PAD * 2, TILE - PAD * 2);
      drawLabel(i);
      if (s.coverUrl) {
        const im = new Image();
        im.referrerPolicy = 'no-referrer';
        im.onload = () => {
          ctx.drawImage(im, cx + PAD, cy + PAD, TILE - PAD * 2, TILE - PAD * 2);
          drawLabel(i);
          if (this._atlasTex) this._atlasTex.needsUpdate = true;
        };
        im.src = s.coverUrl;
      }
    });
    const tex = new T.CanvasTexture(cv);
    tex.colorSpace = T.SRGBColorSpace;
    tex.generateMipmaps = true;
    tex.minFilter = T.LinearMipmapLinearFilter;
    this._atlasTex = tex;
    // 不阻塞：占位色块先上屏，封面 onload 后逐格补画并标记 needsUpdate
  }

  _buildMesh() {
    const T = this._T;
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this._renderer = new T.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this._renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this._renderer.setSize(w, h, false);
    this._renderer.setClearColor(0x000000, 0);
    this._scene = new T.Scene();

    // —— 内部视角：相机在原点，FOV 46°，面朝 -Z ——
    this._camera = new T.PerspectiveCamera(FOV, w / h, 0.05, 45);
    this._camera.position.set(0, 0, 0);
    this._camera.lookAt(0, 0, -1);
    this._camera.updateMatrixWorld(true);
    this._tanHalf = Math.tan((FOV * Math.PI / 180) / 2);

    // 黑色内球兜底：网格尽头之外永远是纯黑空间，不露 DOM 模糊背景
    const bgSphere = new T.Mesh(
      new T.SphereGeometry(40, 32, 16),
      new T.MeshBasicMaterial({ color: 0x05060a, side: T.BackSide, depthWrite: false })
    );
    bgSphere.renderOrder = -1;
    this._bgSphere = bgSphere;
    this._scene.add(bgSphere);

    const n = Math.max(1, this.tracks.length);
    // —— 圆柱内视网格：相机在轴心，封面瓦片贴圆柱内壁 ——
    // 水平方向 360° 无限环绕（左右拖动无边界）；垂直方向圆柱上下各多铺 2 行余量，
    // FOV 内永远有封面 → 不存在球面版的网格尽头黑边，无需渐隐。
    // 瓦片物理尺寸为正方形（宽 = 弦长 = 高），中心区域透视投影接近等大矩形，
    // 两侧随 cos θ 自然收窄（圆柱全景的正常透视）。
    const fovVRad = FOV * Math.PI / 180;
    const tanV = Math.tan(fovVRad / 2);
    const tileH = (2 * R * tanV) / ROWS_VIEW;       // 行高：垂直半屏 = R·tanV 恰好 ROWS_VIEW/2 行
    const COLS = Math.max(12, Math.round((2 * Math.PI * R) / tileH)); // 周长铺等宽列 → 瓦片近正方形
    const thetaStep = (Math.PI * 2) / COLS;
    const ROWS = (Math.ceil(ROWS_VIEW / 2) + CYL_MARGIN) * 2;         // 上下对称，偶数行（中线在两行之间）
    const N = COLS * ROWS;
    this._N = N;
    this._R = R;
    this._COLS = COLS;
    this._ROWS = ROWS;
    const halfH = (ROWS * tileH) / 2;               // 圆柱半高（远大于 R·tanV → 垂直永不露边）

    const tv1 = new T.Vector3();
    const tv2 = new T.Vector3(0, 1, 0);
    const nm = new T.Vector3();
    const m4 = new T.Matrix4();
    const geo = new T.BufferGeometry();
    const pos = new Float32Array(N * 4 * 3);
    const uv = new Float32Array(N * 4 * 2);
    const tileAttr = new Float32Array(N * 4);
    const idx = new Uint32Array(N * 6);
    this._centers = [];   // [{ pos: 瓦片中心/R（hero 飞行起点还原用）, quat }] 长度 = N
    const hw = R * Math.sin(thetaStep / 2) * COVER_K;  // 半宽 = 半弦长（内壁贴合无缝隙）
    const hh = tileH / 2 * COVER_K;
    let centerTileSize = 0;
    for (let row = 0; row < ROWS; row++) {
      const y = halfH - (row + 0.5) * tileH;
      for (let col = 0; col < COLS; col++) {
        const i = row * COLS + col;
        const th = (col + 0.5) * thetaStep;
        const st = Math.sin(th), ct = Math.cos(th);
        // 瓦片中心（θ=0 在正前方 -Z；col 增大向右绕）
        const cx = R * st, cz = -R * ct;
        // 内壁朝向：tv1 = 屏幕右切向，tv2 = 上，nm = 指向轴心（相机）的法线
        tv1.set(ct, 0, st);
        nm.set(-st, 0, ct);
        const quat = new T.Quaternion().setFromRotationMatrix(m4.makeBasis(tv1, tv2, nm));
        this._centers.push({ pos: new T.Vector3(cx / R, y / R, cz / R), quat });
        // 角点（瓦片平面内，略缩留缝）—— TL/TR/BR/BL
        const c0 = i * 4 * 3;
        pos[c0]     = cx - tv1.x * hw + tv2.x * hh;
        pos[c0 + 1] = y + hh;
        pos[c0 + 2] = cz - tv1.z * hw + tv2.z * hh;
        pos[c0 + 3] = cx + tv1.x * hw + tv2.x * hh;
        pos[c0 + 4] = y + hh;
        pos[c0 + 5] = cz + tv1.z * hw + tv2.z * hh;
        pos[c0 + 6] = cx + tv1.x * hw - tv2.x * hh;
        pos[c0 + 7] = y - hh;
        pos[c0 + 8] = cz + tv1.z * hw - tv2.z * hh;
        pos[c0 + 9] = cx - tv1.x * hw - tv2.x * hh;
        pos[c0 + 10] = y - hh;
        pos[c0 + 11] = cz - tv1.z * hw - tv2.z * hh;
        tileAttr.fill(i, i * 4, i * 4 + 4);
        const ci = i % n;
        const cell = this._cellUV(ci);
        uv.set([cell.u0, cell.v1, cell.u1, cell.v1, cell.u1, cell.v0, cell.u0, cell.v0], i * 8);
        idx.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
        if (row === (ROWS >> 1) - 1 && col === (COLS >> 1)) centerTileSize = hw + hh;
      }
    }
    this._tileSize = centerTileSize || hw + hh;
    geo.setAttribute('position', new T.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new T.BufferAttribute(uv, 2));
    geo.setAttribute('aTile', new T.BufferAttribute(tileAttr, 1));
    geo.setIndex(new T.BufferAttribute(idx, 1));
    // DoubleSide：内外两面都渲染（内部视角，法线朝向轴心）
    const mat = new T.MeshBasicMaterial({ map: this._atlasTex, side: T.DoubleSide, transparent: true });
    // 挖洞：hero 卡位置的瓦片折叠到相机位置（不可见），hero 卡从洞里飞出来
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uHoleTile = { value: this._holeTile };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
          attribute float aTile; uniform float uHoleTile;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          if ( abs( aTile - uHoleTile ) < 0.5 ) { transformed = vec3( 0.0 ); }`);
      this._shader = sh;
    };
    this._mesh = new T.Mesh(geo, mat);
    this._mesh.frustumCulled = false;
    this._group = new T.Group();
    this._group.add(this._mesh);
    this._scene.add(this._group);
    this._quat = new T.Quaternion();
    this._group.quaternion.copy(this._quat);
    this._buildHero();
  }

  /* 图集里某张封面实际绘制区域的 UV 矩形（内缩 PAD，不采到四周留白 → 无深色缝） */
  _cellUV(trackIdx) {
    const cols = this._atlasCols, PAD = this._atlasPad || 0;
    const cw = this._atlasCanvas.width, chh = this._atlasCanvas.height;
    const cx = (trackIdx % cols) * TILE, cy = Math.floor(trackIdx / cols) * TILE;
    return {
      u0: (cx + PAD) / cw,
      u1: (cx + TILE - PAD) / cw,
      v1: 1 - (cy + PAD) / chh,          // 顶边（GL 的 v=0 在下方）
      v0: 1 - (cy + TILE - PAD) / chh,   // 底边
    };
  }

  /* 英雄卡：与球面共享同一图集纹理的独立平面，UV 指向被点中封面的图集矩形
     内部视角下英雄卡从球面位置向内飞向相机前方 billboard */
  _buildHero() {
    const T = this._T;
    this._heroUV = new Float32Array(8);
    const geo = new T.PlaneGeometry(1, 1);
    geo.setAttribute('uv', new T.BufferAttribute(this._heroUV, 2));
    const mat = new T.MeshBasicMaterial({
      map: this._atlasTex, side: T.DoubleSide,
      depthTest: false, depthWrite: false,   // 永远压在球面之上
    });
    this._heroGeo = geo;
    this._heroMesh = new T.Mesh(geo, mat);
    this._heroMesh.renderOrder = 999;
    this._heroMesh.frustumCulled = false;
    this._heroMesh.visible = false;
    this._scene.add(this._heroMesh);
    // 逐帧复用的临时对象（避免每帧 new）
    this._h0p = new T.Vector3(); this._h1p = new T.Vector3();
    this._h0q = new T.Quaternion(); this._h1q = new T.Quaternion();
    this._camFwd = new T.Vector3();
  }

  /* ---------- 交互：拖动旋转（无缩放） ---------- */
  _bindPointer() {
    const cv = this.canvas;
    const sig = { signal: this._ac.signal };
    cv.style.touchAction = 'none';
    cv.addEventListener('pointerdown', (e) => {
      e.stopPropagation();
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      // 拖动前先把放大的 hero 卡收回圆柱壁，避免 hero 和圆柱一起转
      if (this._hero.on) this._heroBack(-1);
      this._drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: 0 };
      this._omegaX = 0; this._omegaY = 0;
      try { cv.setPointerCapture(e.pointerId); } catch {}
    }, sig);
    cv.addEventListener('pointermove', (e) => {
      e.stopPropagation();
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      d.x = e.clientX; d.y = e.clientY;
      d.moved += Math.abs(dx) + Math.abs(dy);
      this._pendX += dx; this._pendY += dy;
    }, sig);
    const up = (e) => {
      e.stopPropagation();
      const d = this._drag;
      if (!d || d.id !== e.pointerId) return;
      this._drag = null;
      if (d.moved < 7) this._handleTap(e.clientX, e.clientY);
    };
    cv.addEventListener('pointerup', up, sig);
    cv.addEventListener('pointercancel', (e) => { e.stopPropagation(); this._drag = null; }, sig);
    // 滚轮 = 左右旋转（圆柱只有水平一个自由度）
    cv.addEventListener('wheel', (e) => {
      e.preventDefault(); e.stopPropagation();
      if (this._hero.on) this._heroBack(-1);
      this._applyRot(e.deltaY * 0.0012);
    }, { passive: false, signal: this._ac.signal });
  }

  /* 圆柱只有水平旋转：绕世界 Y 轴（premultiply = 世界坐标系下左乘）；俯仰忽略 */
  _applyRot(angY) {
    if (!angY) return;
    this._qa.setFromAxisAngle(this._axY, angY);
    this._quat.premultiply(this._qa).normalize();
  }

  /* ---------- 点击：命中英雄卡 → 收回；命中瓦片 → 飞到面前；空白 → 收回 ---------- */
  _handleTap(px, py) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.set(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
    this._ray.setFromCamera(this._ndc, this._camera);
    if (this._hero.on && this._ray.intersectObject(this._heroMesh, false).length) {
      this._heroBack(-1);
      return;
    }
    const hit = this._ray.intersectObject(this._mesh, false);
    if (hit.length && hit[0].faceIndex != null) {
      this._spawnHero(Math.floor(hit[0].faceIndex / 2), true);
      return;
    }
    if (this._hero.on) this._heroBack(-1);
  }

  /* 聚焦 = 让该封面飞到相机面前（公开入口） */
  focusTile(trackIdx, notify = false) {
    this._spawnHero(trackIdx, notify);
  }

  /* 程序化聚焦（⏮/⏭/自动聚焦）：从「当前视野中央附近、同一曲目」的瓦片飞出，
     保证飞行起点在用户眼前而不是随机远处（瓦片按 i%n 循环映射曲目） */
  focusTrack(trackIdx, notify = false) {
    if (!this._centers) { this._queuedFocus = { idx: trackIdx, notify }; return; }
    const n = Math.max(1, this.tracks.length);
    if (trackIdx < 0 || trackIdx >= n) return;
    // 视线中央在圆柱本地坐标下的列号（yaw 四元数逆变换 -Z 方向）
    const inv = this._qa.set(this._quat).invert();
    const fwd = this._h1p.set(0, 0, -1).applyQuaternion(inv);   // 复用临时向量
    let col = Math.round((Math.atan2(fwd.x, -fwd.z) / (Math.PI * 2)) * this._COLS);
    const midRow = (this._ROWS >> 1) - 1;                        // 中线上方一行（视觉居中）
    // 从中央列向两侧找 trackIdx%tracks 命中的瓦片
    for (let k = 0; k <= (this._COLS >> 1); k++) {
      for (const c of (k === 0 ? [col] : [col + k, col - k])) {
        const cc = ((c % this._COLS) + this._COLS) % this._COLS;
        const tile = midRow * this._COLS + cc;
        if (tile % n === trackIdx) { this._spawnHero(tile, notify); return; }
      }
    }
    this._spawnHero(trackIdx, notify);  // 兜底（理论上必命中）
  }

  /* 让英雄卡飞回原位；next >= 0 时回位后立刻从该瓦片重新飞出 */
  _heroBack(next) {
    const hero = this._hero;
    if (!hero.on || hero.phase === 'in') return;
    hero.phase = 'in';
    hero.pending = next >= 0 ? next : -1;
    hero.arrived = false;
    // 落位后才通过 onHeroBack 隐藏 DOM（飞回途中 overlay 继续贴着卡片）
  }

  _spawnHero(tileIdx, notify) {
    const N = this._centers ? this._centers.length : this._N || this.tracks.length;
    if (tileIdx < 0 || tileIdx >= N) return;
    if (!this._centers) { this._queuedFocus = { idx: tileIdx, notify }; return; }
    const trackIdx = tileIdx % this.tracks.length;
    const hero = this._hero;
    this._lastFocusIdx = trackIdx;
    if (hero.on) {
      // 已在场：先飞回，落位后再从新瓦片飞出（pending >= 0，DOM 全程不隐藏）
      hero.phase = 'in';
      hero.pending = tileIdx;
      hero.arrived = false;
      if (notify && this.onTileClick) this.onTileClick(trackIdx);
      return;
    }
    hero.on = true;
    hero.tile = tileIdx;
    hero.track = trackIdx;
    hero.phase = 'out';
    hero.p = 0;
    hero.arrived = false;
    hero.pending = -1;
    this._syncHeroUV(trackIdx);
    this._setHole(tileIdx);
    this._heroMesh.visible = true;
    this._updateHero();
    if (notify && this.onTileClick) this.onTileClick(trackIdx);
  }

  _syncHeroUV(trackIdx) {
    const cell = this._cellUV(trackIdx);
    const u = this._heroUV;
    u[0] = cell.u0; u[1] = cell.v1;   // 左上
    u[2] = cell.u1; u[3] = cell.v1;   // 右上
    u[4] = cell.u0; u[5] = cell.v0;   // 左下
    u[6] = cell.u1; u[7] = cell.v0;   // 右下
    this._heroGeo.attributes.uv.needsUpdate = true;
  }

  _setHole(idx) {
    this._holeTile = idx;
    if (this._shader) this._shader.uniforms.uHoleTile.value = idx;
  }

  /* 内部视角下英雄卡飞行：
     p0：瓦片在球面上的当前世界位姿（随球体旋转）
     p1：相机正前方 HERO_DIST 处的 billboard */
  _updateHero() {
    const hero = this._hero;
    const c = this._centers[hero.tile];
    // p0：该瓦片当前世界位姿（内部视角，瓦片在 R 半径球面上）
    this._h0p.copy(c.pos).multiplyScalar(this._R).applyQuaternion(this._quat);
    this._h0q.copy(this._quat).multiply(c.quat);
    // p1：相机正前方 billboard（相机看向 -Z）
    this._camFwd.set(0, 0, -1).applyQuaternion(this._camera.quaternion);
    this._h1p.copy(this._camera.position).addScaledVector(this._camFwd, HERO_DIST);
    this._h1q.copy(this._camera.quaternion);
    const t = hero.phase === 'out' ? easeOut(hero.p) : easeInOut(hero.p);
    const m = this._heroMesh;
    m.position.copy(this._h0p).lerp(this._h1p, t);
    m.quaternion.copy(this._h0q).slerp(this._h1q, t);
    // 目标尺寸：占视口高度 HERO_SCREEN（放大），窄窗口下按宽度封顶
    const rw = this._renderer.domElement.clientWidth || 1;
    const rh = this._renderer.domElement.clientHeight || 1;
    const hCss = Math.min(HERO_SCREEN * rh, HERO_SCREEN * 1.25 * rw);
    const target = 2 * HERO_DIST * this._tanHalf * (hCss / rh);
    const s = this._tileSize + (target - this._tileSize) * t;
    m.scale.set(s, s, s);
  }

  resize(w, h) {
    if (!this._renderer) return;
    this._renderer.setSize(w, h, false);
    this._camera.aspect = w / h;
    this._camera.updateProjectionMatrix();
  }

  _loop() {
    if (this._dead) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const now = performance.now();
    let dt = (now - this._last) / 1000;
    if (!(dt > 0) || dt > 0.1) dt = 1 / 60;
    dt = Math.max(dt, 0.004);
    this._last = now;

    // 1) 拖动位移 → 立即旋转（圆柱：只取水平位移，垂直位移忽略）
    const dx = this._pendX;
    this._pendX = 0; this._pendY = 0;
    if (dx) {
      this._applyRot(dx * DRAG_K);
      this._omegaY = (dx * DRAG_K) / dt;
    } else if (this._drag) {
      this._omegaY = 0;
    } else {
      // 2) 惯性 + 阻尼（360° 环绕无边界，不做自动自转避免停不下来）
      const dump = Math.pow(DAMP, dt * 60);
      this._applyRot(this._omegaY * dt);
      this._omegaY *= dump;
      if (Math.abs(this._omegaY) < 1e-4) this._omegaY = 0;
    }

    // 3) 英雄卡飞行
    const hero = this._hero;
    if (hero.on) {
      if (hero.phase === 'out') {
        hero.p = Math.min(1, hero.p + dt / HERO_DUR);
        if (hero.p >= 1 && !hero.arrived) {
          hero.arrived = true;
          if (this.onTileCenter) this.onTileCenter(hero.track);
        }
      } else {
        hero.p = Math.max(0, hero.p - dt / HERO_DUR);
        if (hero.p <= 0) {
          this._setHole(-1);
          const nx = hero.pending;
          hero.pending = -1;
          hero.on = false;
          if (nx >= 0) this._spawnHero(nx, false);
          else {
            this._heroMesh.visible = false;
            if (this.onHeroBack) this.onHeroBack();   // 真正落位 → 隐藏 DOM 控制器
          }
        }
      }
      if (hero.on) this._updateHero();
    }

    this._group.quaternion.copy(this._quat);

    // —— hero 卡屏幕投影：每帧推送 DOM 覆盖层位置/尺寸（对象全部复用，避免 GC）——
    if (hero.on && this._heroMesh.visible && this.onHeroUpdate) {
      const T = this._T;
      if (!this._hProj) {
        this._hProj = Array.from({ length: 5 }, () => new T.Vector4());
        this._hCorners = [
          new T.Vector3(0, 0, 0),
          new T.Vector3(-0.5, -0.5, 0), new T.Vector3(0.5, -0.5, 0),
          new T.Vector3(0.5, 0.5, 0), new T.Vector3(-0.5, 0.5, 0),
        ];
        this._hWp = new T.Vector3();
      }
      const mesh = this._heroMesh, cam = this._camera;
      const proj = this._hProj;
      for (let k = 0; k < 5; k++) {
        this._hWp.copy(this._hCorners[k]).applyMatrix4(mesh.matrixWorld);
        proj[k].set(this._hWp.x, this._hWp.y, this._hWp.z, 1)
          .applyMatrix4(cam.projectionMatrix).applyMatrix4(cam.matrixWorldInverse);
      }
      // 屏幕中心（canvas CSS 像素，左上角 0,0）
      const cw = this.canvas.clientWidth || 1, ch = this.canvas.clientHeight || 1;
      const ndcX = proj[0].x / proj[0].w;
      const ndcY = proj[0].y / proj[0].w;
      const cssX = ((ndcX + 1) / 2) * cw;
      const cssY = ((1 - ndcY) / 2) * ch;
      // 屏幕尺寸：取四角相对中心的最大 NDC 偏移，换算为 canvas CSS 像素
      const ndcHalfW = Math.max(Math.abs(proj[1].x/proj[1].w - proj[0].x/proj[0].w), Math.abs(proj[2].x/proj[2].w - proj[0].x/proj[0].w));
      const ndcHalfH = Math.max(Math.abs(proj[3].y/proj[3].w - proj[0].y/proj[0].w), Math.abs(proj[1].y/proj[1].w - proj[0].y/proj[0].w));
      // NDC 半偏移 → 像素：ndcHalf 是相对中心的 NDC 距离（全幅为 2），故全高像素 = ndcHalfH * ch
      const cssW = Math.max(4, ndcHalfW * cw);
      const cssH = Math.max(4, ndcHalfH * ch);
      if (isFinite(cssW) && isFinite(cssH)) {
        this.onHeroUpdate({ x: cssX, y: cssY, w: cssW, h: cssH, arrived: hero.arrived });
      }
    }

    // 更新挖洞 uniform（每帧）
    if (this._shader) {
      this._shader.uniforms.uHoleTile.value = this._holeTile;
    }

    this._renderer.render(this._scene, this._camera);
  }

  dispose() {
    this._dead = true;
    cancelAnimationFrame(this._raf);
    this._ac.abort();
    if (this._heroGeo) this._heroGeo.dispose();
    if (this._heroMesh) this._heroMesh.material.dispose();
    if (this._mesh) this._mesh.geometry.dispose();
    if (this._mesh) this._mesh.material.dispose();
    if (this._bgSphere) { this._bgSphere.geometry.dispose(); this._bgSphere.material.dispose(); }
    if (this._atlasTex) this._atlasTex.dispose();
    if (this._renderer) this._renderer.dispose();
  }
}

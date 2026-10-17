/* ============ 音频引擎：播放队列 + WebAudio 分析 + 节拍 + 配色 ============ */

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) s = 0;
  const m = Math.floor(s / 60), ss = Math.floor(s % 60);
  return `${m}:${String(ss).padStart(2, '0')}`;
};

let uid = 1;
export function makeTrack(partial) {
  return {
    uid: uid++,
    source: partial.source || 'local',   // 'local' | 'online' | 'demo'
    path: partial.path || null,          // 本地文件路径
    songId: partial.songId || null,      // 源内歌曲 id
    srcId: partial.srcId || null,        // 音源插件 id（null = 旧收藏条目，播放时由宿主自动换源兜底）
    srcName: partial.srcName || null,    // 命中音源名称（换源后更新）
    title: partial.title || '未知标题',
    artist: partial.artist || '',
    album: partial.album || '',
    duration: partial.duration || 0,
    coverUrl: partial.coverUrl || null,  // http(s) 封面（在线）
    coverBlob: partial.coverBlob || null, // blob: 封面（本地解析 / 在线下载后）
    lyricText: partial.lyricText || null,
    transText: partial.transText || null
  };
}

/* 在线资源分发钩子：由 app 层注入（内置直连 / 插件音源 / 自动换源），播放引擎不感知音源实现 */
let _urlHook = null, _lyricHook = null;
export function setOnlineHooks({ url, lyric }) {
  if (url) _urlHook = url;
  if (lyric) _lyricHook = lyric;
}

export class AudioEngine extends EventTarget {
  constructor() {
    super();
    this.audio = new Audio();
    this.audio.preload = 'auto';
    this.audio.crossOrigin = 'anonymous';

    this.queue = [];
    this.index = -1;
    this.playing = false;
    this.shuffle = false;
    this.playMode = 'list';  // list 顺序循环 | one 单曲循环 | shuffle 随机播放
    this.history = []; // 随机播放回退

    this.ctx = null;
    this.analyser = null;
    this.gain = null;
    this.mediaSrc = null;
    this.eqFilters = null;                       // 五段 EQ（sub/low/mid/high/pres）
    this.eq = { sub: 0, low: 0, mid: 0, high: 0, pres: 0 };  // dB，-12..12
    this.sensitivity = 1;                        // 视觉灵敏度倍率
    // 音效链节点（_ensureCtx 内创建）
    this.fx = {
      comp: null, dry: null, reverb: null, reverbWet: null,
      delay: null, delayFb: null, delayWet: null, panner: null,
    };
    this.fxCfg = {
      comp: { on: true, threshold: -18, ratio: 3, knee: 24, attack: 0.003, release: 0.25 },
      reverb: { wet: 0 },        // 0..1
      echo: { time: 0.28, fb: 0.35, wet: 0 },   // time s, fb 0..0.85, wet 0..1
      spatial: { mode: 'off' },  // off | orbit | front
      speed: 1,                  // 0.5..2
    };

    this.freq = new Uint8Array(1024);
    this.wave = new Uint8Array(1024);
    this.bins = new Float32Array(96);        // 对数分箱，供场景使用
    this.bands = { level: 0, bass: 0, mid: 0, treble: 0, beat: false, beatPulse: 0 };
    this._bassHist = new Float32Array(46);
    this._histIdx = 0;
    this._lastBeat = 0;
    this._prevRms = 0;

    this.palette = { hue: 208, hue2: 268, accent: '#4ea8ff', accent2: '#8f6cff', luma: 0.5 };

    this._blobCache = new Map();   // track.uid -> {audio, lyric, cover}
    this._loading = null;          // 当前加载 promise，防竞态
    this._demo = null;             // 演示曲状态

    this.audio.addEventListener('ended', () => {
      // 单曲循环：原地重播当前曲（seek 回 0，不重解析在线地址）；其余模式走下一首逻辑
      if (this.playMode === 'one') { this.audio.currentTime = 0; this.audio.play().catch(() => {}); }
      else this.next(true);
    });
    this.audio.addEventListener('play', () => { this.playing = true; this._emit('state'); });
    this.audio.addEventListener('pause', () => { this.playing = false; this._emit('state'); });
    // 缓冲状态：在线流式播放等待数据时给出加载指示
    this.audio.addEventListener('waiting', () => this._emit('loading', { on: true }));
    this.audio.addEventListener('canplay', () => this._emit('loading', { on: false }));
    this.audio.addEventListener('playing', () => this._emit('loading', { on: false }));
    this.audio.addEventListener('loadedmetadata', () => {
      const t = this.current;
      if (t && !t.duration && isFinite(this.audio.duration)) {
        t.duration = this.audio.duration;
        this._emit('queue');
      }
      // 提示音兜底：无版权/失效资源 302 到短提示音（实际时长 << 元数据时长）→ 自动跳下一首，
      // 否则会“播完提示音→下一首又提示音”无限循环
      if (t && t.source === 'online' && isFinite(this.audio.duration)
        && this.audio.duration < 25 && (t.duration || 0) >= 40000) {
        this._failCount = (this._failCount || 0) + 1;
        this._emit('error', { msg: `「${t.title}」资源已失效，自动跳过` });
        if (this._failCount <= 8) setTimeout(() => this.next(), 400);
        return;
      }
      this._emit('time');
    });
    // 播放超过 45 秒视为真正成功，重置连败计数（不能用 play 成功就重置，提示音也能“成功”）
    this.audio.addEventListener('timeupdate', () => {
      if (this.audio.currentTime > 45) this._failCount = 0;
    });
  }

  _emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  get current() { return this.queue[this.index] || null; }

  /* ---------- 队列 ---------- */
  addTracks(tracks, playNow = false) {
    this.queue.push(...tracks);
    this._emit('queue');
    if (playNow) this.playIndex(this.queue.length - tracks.length);
    else if (this.index === -1 && this.queue.length) { this.index = 0; this._emit('track'); }
  }

  removeAt(i) {
    if (i < 0 || i >= this.queue.length) return;
    this._dropCache(this.queue[i].uid);
    this.queue.splice(i, 1);
    if (i < this.index) this.index--;
    else if (i === this.index) {
      const wasPlaying = this.playing;
      this.stop();
      if (this.queue.length) this.playIndex(clamp(this.index, 0, this.queue.length - 1));
      else { this.index = -1; this._emit('track'); }
      if (wasPlaying && this.queue.length) this.play();
    }
    this._emit('queue');
  }

  clear() {
    this.stop();
    for (const t of this.queue) this._dropCache(t.uid);
    this.queue = [];
    this.index = -1;
    this._emit('queue');
    this._emit('track');
  }

  setShuffle(v) { this.shuffle = v; this.playMode = v ? 'shuffle' : 'list'; }

  /** 播放模式：list 顺序循环 | one 单曲循环 | shuffle 随机播放（shuffle 字段保持同步，旧逻辑兼容） */
  setPlayMode(m) { this.playMode = m; this.shuffle = m === 'shuffle'; }

  async playIndex(i) {
    if (i < 0 || i >= this.queue.length) return;
    this.index = i;
    const t = this.queue[i];
    this._emit('track');
    try {
      // 确保 WebAudio 分析链已建立（此前只有演示曲会创建，导致真实播放不律动）
      await this._ensureCtx();
      await this._loadTrack(t);
      await this.audio.play();
      // 连败计数由 timeupdate(>45s) 重置：提示音/试听也会“播放成功”，不能在这里清零
      // 播放成功 → 后台预取同歌单（队列）后续在线歌曲进磁盘缓存，切歌秒开/可离线
      try {
        const ahead = [];
        for (let k = 1; k <= 8 && this.queue.length > 1; k++) {
          const nt = this.queue[(this.index + k) % this.queue.length];
          if (nt?.source === 'online' && nt.songId) ahead.push({ srcId: nt.srcId || 'netease', id: nt.songId, title: nt.title, artist: nt.artist });
        }
        if (ahead.length) window.api.audioCachePrefetch?.(ahead);
      } catch { /* 预取可选 */ }
    } catch (err) {
      if (err && err.name === 'AbortError') return; // 切歌竞态，忽略
      console.error('播放失败:', err);
      this._emit('error', { msg: `「${t.title}」加载失败：${err.message || err}` });
      this.playing = false;
      this._emit('state');
      // 在线歌曲失败 → 自动跳下一首（连跳上限 8，配合提示音兜底防死循环）
      if (t.source === 'online' && this.queue.length > 1) {
        this._failCount = (this._failCount || 0) + 1;
        if (this._failCount <= 8) setTimeout(() => this.next(), 500);
      }
    }
  }

  next(auto = false) {
    if (!this.queue.length) return;
    let i;
    if (this.shuffle && this.queue.length > 1) {
      if (!this.history.length) this.history = [...this.queue.keys()].filter(k => k !== this.index);
      const pick = Math.floor(Math.random() * this.history.length);
      i = this.history.splice(pick, 1)[0];
    } else {
      i = (this.index + 1) % this.queue.length;
    }
    this.playIndex(i);
  }

  prev() {
    if (!this.queue.length) return;
    this.playIndex((this.index - 1 + this.queue.length) % this.queue.length);
  }

  playPause() {
    if (this.current?.source === 'demo') {
      if (this._demo) {
        this._releaseDemo();
        this.playing = false;
        this._emit('state');
      } else {
        this.playDemo().catch(() => {});
      }
      return;
    }
    if (!this.current) { if (this.queue.length) this.playIndex(0); return; }
    if (this.audio.paused) this.audio.play().catch(() => {});
    else this.audio.pause();
  }

  stop() {
    this.audio.pause();
    this.audio.removeAttribute('src');
    this.audio.load();
    this._releaseDemo();
  }

  seek(sec) {
    if (this._demo) return; // 演示曲不支持 seek
    if (isFinite(this.audio.duration)) {
      this.audio.currentTime = clamp(sec, 0, this.audio.duration);
      this._emit('time');
    }
  }

  get time() { return this._demo ? (this._demo.pos() % this._demo.duration) : (this.audio.currentTime || 0); }
  get duration() { return this._demo ? this._demo.duration : (isFinite(this.audio.duration) ? this.audio.duration : (this.current?.duration || 0)); }

  setVolume(v) {
    this.audio.volume = clamp(v, 0, 1);
    if (this.gain) this.gain.gain.value = clamp(v, 0, 1);
  }

  /* ---------- 资源加载 ---------- */
  _cacheOf(uid) {
    if (!this._blobCache.has(uid)) this._blobCache.set(uid, {});
    return this._blobCache.get(uid);
  }
  _dropCache(uid) {
    const c = this._blobCache.get(uid);
    if (c) {
      // 直链流式地址（http(s)）不是 blob，不可 revoke
      if (c.audio && String(c.audio).startsWith('blob:')) URL.revokeObjectURL(c.audio);
      if (c.cover && String(c.cover).startsWith('blob:')) URL.revokeObjectURL(c.cover);
      this._blobCache.delete(uid);
    }
  }

  /** 生成合成混响脉冲响应（指数衰减噪声，无需外部音频文件） */
  _makeImpulse(duration = 2.4, decay = 2.6) {
    const ctx = this.ctx, rate = ctx.sampleRate;
    const len = Math.max(1, Math.floor(rate * duration));
    const ir = ctx.createBuffer(2, len, rate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
      }
    }
    return ir;
  }
  async _ensureCtx() {
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.8;
      this.gain = this.ctx.createGain();
      this.analyser.connect(this.gain);
      this.gain.connect(this.ctx.destination);
      this.mediaSrc = this.ctx.createMediaElementSource(this.audio);
      // —— 五段 EQ：sub(60Hz lowshelf) / low(220Hz lowshelf) / mid(1.2k peaking) / high(5.2k highshelf) / pres(12k highshelf) ——
      const mk = (type, freq, q = 1) => {
        const f = this.ctx.createBiquadFilter();
        f.type = type; f.frequency.value = freq; f.Q.value = q; return f;
      };
      const sub = mk('lowshelf', 60), low = mk('lowshelf', 220), mid = mk('peaking', 1200, 0.9),
            high = mk('highshelf', 5200), pres = mk('highshelf', 12000);
      this.mediaSrc.connect(sub); sub.connect(low); low.connect(mid); mid.connect(high); high.connect(pres);
      this.eqFilters = { sub, low, mid, high, pres };
      // —— 压缩器（响度归一，默认开启）——
      const comp = this.ctx.createDynamicsCompressor();
      pres.connect(comp);
      // —— 干声 + 效果发送/返回 ——
      const dry = this.ctx.createGain();
      dry.gain.value = 1;
      comp.connect(dry);
      // 混响：合成 IR Convolver + wet
      const reverb = this.ctx.createConvolver();
      reverb.buffer = this._makeImpulse();
      const reverbWet = this.ctx.createGain(); reverbWet.gain.value = 0;
      comp.connect(reverb); reverb.connect(reverbWet); reverbWet.connect(dry);
      // 回声：DelayNode + 反馈 + wet
      const delay = this.ctx.createDelay(2.0); delay.delayTime.value = 0.28;
      const delayFb = this.ctx.createGain(); delayFb.gain.value = 0.35;
      const delayWet = this.ctx.createGain(); delayWet.gain.value = 0;
      comp.connect(delay); delay.connect(delayFb); delayFb.connect(delay);
      delay.connect(delayWet); delayWet.connect(dry);
      // —— 空间音频：PannerNode（HRTF）——
      const panner = this.ctx.createPanner();
      panner.panningModel = 'HRTF';
      panner.distanceModel = 'inverse';
      panner.refDistance = 1; panner.maxDistance = 10; panner.rolloffFactor = 0.8;
      dry.connect(panner); panner.connect(this.analyser);
      this.fx = { comp, dry, reverb, reverbWet, delay, delayFb, delayWet, panner };
      this.setEQ(this.eq);
      this.applyFx();
      this.gain.gain.value = this.audio.volume;
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** 音效 EQ（五段，dB 增益，-12..+12）；兼容旧三段 {low,mid,high} */
  setEQ({ sub, low, mid, high, pres } = {}) {
    this.eq = {
      sub: clamp(sub ?? this.eq?.sub ?? 0, -12, 12),
      low: clamp(low ?? 0, -12, 12),
      mid: clamp(mid ?? 0, -12, 12),
      high: clamp(high ?? 0, -12, 12),
      pres: clamp(pres ?? this.eq?.pres ?? 0, -12, 12),
    };
    if (this.eqFilters) {
      this.eqFilters.sub.gain.value = this.eq.sub;
      this.eqFilters.low.gain.value = this.eq.low;
      this.eqFilters.mid.gain.value = this.eq.mid;
      this.eqFilters.high.gain.value = this.eq.high;
      this.eqFilters.pres.gain.value = this.eq.pres;
    }
  }

  /** 应用全部音效链设置（压缩/混响/回声/空间/速度） */
  applyFx() {
    const f = this.fx, c = this.fxCfg;
    if (!f.comp) return;
    // 压缩器
    const on = c.comp.on !== false;
    f.comp.threshold.value = c.comp.threshold;
    f.comp.knee.value = c.comp.knee;
    f.comp.ratio.value = on ? c.comp.ratio : 1;
    f.comp.attack.value = c.comp.attack;
    f.comp.release.value = c.comp.release;
    // 混响
    f.reverbWet.gain.value = clamp(c.reverb.wet, 0, 1);
    // 回声
    f.delay.delayTime.value = clamp(c.echo.time, 0.02, 1.5);
    f.delayFb.gain.value = clamp(c.echo.fb, 0, 0.85);
    f.delayWet.gain.value = clamp(c.echo.wet, 0, 1);
    // 空间音频
    const mode = c.spatial.mode;
    if (mode === 'off') { f.panner.panningModel = 'equalpower'; f.panner.setPosition(0, 0, 0); }
    else { f.panner.panningModel = 'HRTF'; }
    // 播放速度（保持音高：preservesPitch 由 audio 元素决定，electron 默认 true）
    try { this.audio.playbackRate = clamp(c.speed, 0.5, 2); } catch { /* noop */ }
  }

  /** 设置压缩器参数 */
  setComp(patch = {}) {
    Object.assign(this.fxCfg.comp, patch);
    this.applyFx();
  }
  setReverb(wet) { this.fxCfg.reverb.wet = wet; this.applyFx(); }
  setEcho(patch = {}) { Object.assign(this.fxCfg.echo, patch); this.applyFx(); }
  setSpatial(mode) { this.fxCfg.spatial.mode = mode; this.applyFx(); }
  setSpeed(s) { this.fxCfg.speed = s; this.applyFx(); }

  /** 空间音频位置更新（由帧循环调用，环绕模式时绕 Y 轴旋转） */
  updateSpatial(t) {
    const f = this.fx, c = this.fxCfg;
    if (!f.panner) return;
    switch (c.spatial.mode) {
      case 'orbit': {
        const a = t * 0.6;
        f.panner.setPosition(Math.sin(a) * 1.5, 0, Math.cos(a) * 1.5);
        break;
      }
      case 'orbit-fast': {
        const a = t * 1.4;
        f.panner.setPosition(Math.sin(a) * 1.8, 0, Math.cos(a) * 1.8);
        break;
      }
      case 'front':
        f.panner.setPosition(0, 0, 1);
        break;
      case 'behind':
        f.panner.setPosition(0, 0, -1);
        break;
      case 'left':
        f.panner.setPosition(-1.5, 0, 0);
        break;
      case 'right':
        f.panner.setPosition(1.5, 0, 0);
        break;
      case 'above':
        f.panner.setPosition(0, 1.5, 0.3);
        break;
      default:
        f.panner.setPosition(0, 0, 0);
    }
  }

  async _loadTrack(t) {
    const token = Symbol();
    this._loading = token;
    try {
      if (t.source === 'local') {
        await this._loadLocal(t);
      } else if (t.source === 'online') {
        await this._loadOnline(t);
      }
    } finally {
      if (this._loading === token) this._loading = null;
    }
  }

  async _loadLocal(t) {
    const cache = this._cacheOf(t.uid);
    if (!cache.audio) {
      const buf = await window.api.readFile(t.path);
      const ext = (t.path.split('.').pop() || 'mp3').toLowerCase();
      const mime = ext === 'flac' ? 'audio/flac' : ext === 'm4a' ? 'audio/mp4' : ext === 'wav' ? 'audio/wav' : ext === 'ogg' || ext === 'opus' ? 'audio/ogg' : 'audio/mpeg';
      cache.audio = URL.createObjectURL(new Blob([buf], { type: mime }));
    }
    if (!cache.cover && !t.coverBlob) {
      try {
        const meta = await window.api.parseMeta(t.path);
        if (meta.picture?.data) {
          cache.cover = URL.createObjectURL(new Blob([meta.picture.data], { type: meta.picture.format }));
          t.coverBlob = cache.cover;
          this._emit('cover');
        }
        if (t.lyricText == null) {
          const lr = await window.api.findLyric(t.path);
          // 同目录 .lrc 未找到 → 标记 ''（UI 显示「纯音乐」）
          t.lyricText = lr?.text || '';
          if (lr) t.transText = null;
          this._emit('lyric');
        }
      } catch { /* 标签解析失败不影响播放 */ }
    }
    this._releaseDemo();
    this.audio.src = cache.audio;
  }

  async _loadOnline(t) {
    const cache = this._cacheOf(t.uid);
    if (!cache.audio) {
      // 全音源统一链路：url hook（外部插件音源 / 自动换源）
      // 策略：① 直链流式播放（CORS 允许时秒开，WebAudio 分析器正常）
      //       ② 失败再走主进程字节流 blob 兜底（防盗链 Referer / 无 CORS / 代理）
      // 播放直链绝不落盘缓存：blob 仅本次会话内存持有，切歌/清队列即释放
      this._emit('loading', { on: true });
      let got;
      try {
        // 歌单预取磁盘缓存命中：直接播本地文件（秒开、离线可播）；缓存损坏则回退在线链路
        let fromCache = false;
        try {
          const hit = await window.api.audioCacheTake?.({ srcId: t.srcId || 'netease', id: t.songId });
          if (hit?.url) {
            this._releaseDemo();
            this.audio.crossOrigin = null;
            this.audio.src = hit.url;
            await this._waitReady(5000);
            cache.audio = hit.url;
            cache.stream = true;
            fromCache = true;
          }
        } catch { this.audio.removeAttribute('src'); }
        if (!fromCache) {
        got = _urlHook
          ? await _urlHook(t)
          : await window.api.sourcePlayUrl({ srcId: t.srcId || 'netease', id: t.songId, title: t.title, artist: t.artist });
        const url = got?.url || null;
        if (!url) throw new Error(got?.msg || '无可用播放地址（可能为 VIP 或无版权歌曲）');
        if (got.newId) t.songId = got.newId;      // 换源命中后的新歌曲 id（歌词/封面跟随）
        if (got.via) { t.srcId = got.srcId; if (got.name) t.title = t.title || got.name; }

        // ① 直链流式：crossOrigin 必须在赋 src 前设置，无 CORS 会触发 error → 立即兜底
        this._releaseDemo();
        this.audio.crossOrigin = 'anonymous';
        try {
          this.audio.src = url;
          await this._waitReady(8000);
          cache.audio = url;
          cache.stream = true;
        } catch (eDirect) {
          // ② 主进程代理下载（整曲 blob）—— 与旧链路一致，无 CORS / 需 Referer 的源走这里
          this.audio.pause();
          this.audio.removeAttribute('src');
          const bin = await window.api.sourceBinary(url, got?.headers || {});
          if (!bin) throw new Error('音频下载失败（' + (t.srcName || t.srcId || '在线') + '）');
          const buf = bin.data instanceof Uint8Array ? bin.data : new Uint8Array(bin.data);
          if (buf.length < 4096) throw new Error('音频内容不可用（可能无版权）');
          cache.audio = URL.createObjectURL(new Blob([buf], { type: bin.contentType || 'audio/mpeg' }));
          cache.stream = false;
        }
        }
      } finally {
        this._emit('loading', { on: false });
      }
    }
    if (t.lyricText == null) {
      // 歌词必须尝试加载；仅接口明确纯音乐才置 pureMusic（UI 显示「纯音乐」），其余空结果显示默认提示
      let lrc = '', trans = null, pure = false;
      try {
        const ly = _lyricHook
          ? await _lyricHook(t)
          : await window.api.sourceLyricMatch({ srcId: t.srcId || 'netease', id: t.songId, title: t.title, artist: t.artist });
        lrc = ly?.yrc || ly?.lrc || ly?.ttml || '';
        trans = ly?.tlrc || ly?.trans || null;
        pure = ly?.pure === true;
      } catch { /* 歌词可选 */ }
      t.lyricText = lrc;
      t.transText = trans;
      t.pureMusic = pure;
      this._emit('lyric');
    }
    // 封面通用化：任意 http(s) 封面经主进程下载为 blob（规避防盗链/跨域）
    if (!t.coverBlob && t.coverUrl && !cache.cover && /^https?:/.test(t.coverUrl)) {
      try {
        const bin = await window.api.sourceBinary(t.coverUrl, {});
        if (bin) {
          const u8 = bin.data instanceof Uint8Array ? bin.data : new Uint8Array(bin.data);
          cache.cover = URL.createObjectURL(new Blob([u8], { type: bin.contentType || 'image/jpeg' }));
          t.coverBlob = cache.cover;
          this._emit('cover');
        }
      } catch { /* 封面可选 */ }
    }
    this._releaseDemo();
    if (cache.stream) this.audio.crossOrigin = 'anonymous';
    else this.audio.removeAttribute('crossorigin'); // blob 同源，无需 CORS
    // 直链探测阶段已赋过同一地址，避免重复加载（二次缓冲）
    if (this.audio.src !== cache.audio) this.audio.src = cache.audio;
    // 外链对无版权歌会 302 到几秒的提示音；30s 试听片段同样按实际时长识别并剔除
    const realDur = await this._waitMetadata(8000);
    if (realDur != null) {
      const expectedMs = Number(t.duration) || 0;
      const isTrialClip = realDur < 40 && (expectedMs > realDur * 1000 + 8000 || (!expectedMs && realDur < 20));
      if (isTrialClip) {
        this._dropCache(t.uid); // 丢弃试听片段缓存，下次可重试其他源
        throw new Error('该歌曲仅提供试听片段，已自动跳过');
      }
    }
  }

  /** 等待音频就绪（canplay 或 loadeddata），超时/错误 reject —— 用于直链流式探测 */
  _waitReady(timeout = 8000) {
    return new Promise((resolve, reject) => {
      if (this.audio.readyState >= 2) return resolve();
      const to = setTimeout(fail, timeout);
      const ok = () => { cleanup(); resolve(); };
      function fail() { cleanup(); reject(new Error('直链加载超时')); }
      const cleanup = () => {
        clearTimeout(to);
        this.audio.removeEventListener('loadeddata', ok);
        this.audio.removeEventListener('canplay', ok);
        this.audio.removeEventListener('error', fail);
      };
      this.audio.addEventListener('loadeddata', ok, { once: true });
      this.audio.addEventListener('canplay', ok, { once: true });
      this.audio.addEventListener('error', fail, { once: true });
    });
  }

  /** 等待音频元数据（时长），超时返回 null 放行 */
  _waitMetadata(timeout = 6000) {
    return new Promise((resolve) => {
      if (isFinite(this.audio.duration) && this.audio.duration > 0) return resolve(this.audio.duration);
      const to = setTimeout(() => { cleanup(); resolve(null); }, timeout);
      const onMeta = () => { cleanup(); resolve(isFinite(this.audio.duration) ? this.audio.duration : null); };
      const onErr = () => { cleanup(); resolve(null); };
      const cleanup = () => {
        clearTimeout(to);
        this.audio.removeEventListener('loadedmetadata', onMeta);
        this.audio.removeEventListener('error', onErr);
      };
      this.audio.addEventListener('loadedmetadata', onMeta, { once: true });
      this.audio.addEventListener('error', onErr, { once: true });
    });
  }

  /** 更新本地封面缓存（导入时已解析） */
  attachCover(t, blobUrl) {
    this._cacheOf(t.uid).cover = blobUrl;
    t.coverBlob = blobUrl;
  }

  /* ---------- 演示曲（程序化合成，无文件也可体验可视化） ---------- */
  async playDemo() {
    await this._ensureCtx();
    this.audio.pause();
    this._releaseDemo();
    const sr = 44100, dur = 16;
    const off = new OfflineAudioContext(2, sr * dur, sr);
    const master = off.createGain();
    master.gain.value = 0.9;
    master.connect(off.destination);

    const note = (freq, t0, len, type, vol, detune = 0) => {
      const o = off.createOscillator(), g = off.createGain();
      o.type = type; o.frequency.value = freq; o.detune.value = detune;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.012);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + len);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + len + 0.05);
    };
    const kick = (t0) => {
      const o = off.createOscillator(), g = off.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(150, t0);
      o.frequency.exponentialRampToValueAtTime(42, t0 + 0.11);
      g.gain.setValueAtTime(1.0, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.3);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + 0.35);
    };
    const hat = (t0, vol) => {
      const len = 0.06, buf = off.createBuffer(1, sr * len, sr);
      const d = buf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 2);
      const s = off.createBufferSource(); s.buffer = buf;
      const f = off.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
      const g = off.createGain(); g.gain.value = vol;
      s.connect(f); f.connect(g); g.connect(master);
      s.start(t0);
    };

    const BPM = 122, beat = 60 / BPM;
    const chordProg = [0, -3, -5, -7]; // 半音移位
    const penta = [0, 3, 5, 7, 10];
    for (let bar = 0; bar < 8; bar++) {
      const t0 = bar * 4 * beat;
      const root = 220 * Math.pow(2, chordProg[bar % 4] / 12);
      for (let b = 0; b < 4; b++) {
        const tb = t0 + b * beat;
        kick(tb);                                   // 四踩底鼓
        hat(tb + beat / 2, 0.35);                   // 反拍镲
        if (b % 2 === 1) hat(tb, 0.14);
        // 琶音
        for (let s = 0; s < 2; s++) {
          const st = tb + s * beat / 2;
          const n = penta[(bar * 4 + b * 2 + s) % penta.length];
          note(root * Math.pow(2, (n + 12) / 12), st, 0.22, 'triangle', 0.16);
        }
        note(root / 2, tb, beat * 0.9, 'sawtooth', 0.10); // 贝斯
      }
      // 和弦铺底
      for (const iv of [0, 7, 12, 15]) note(root * Math.pow(2, iv / 12), t0, 4 * beat * 0.95, 'sine', 0.045, iv);
    }

    const rendered = await off.startRendering();
    const src = this.ctx.createBufferSource();
    src.buffer = rendered;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = this.audio.volume;
    src.connect(g); g.connect(this.eqFilters.sub);   // 演示曲也走完整音效链（EQ/压缩/混响/回声/空间）
    src.start();
    const t0 = this.ctx.currentTime;
    this._demo = {
      src, gain: g,
      duration: dur,
      pos: () => this.ctx.currentTime - t0
    };
    this.playing = true;
    this._emit('state');
  }

  _releaseDemo() {
    if (!this._demo) return;
    try { this._demo.src.stop(); } catch { /* already stopped */ }
    try { this._demo.src.disconnect(); this._demo.gain.disconnect(); } catch { /* noop */ }
    this._demo = null;
  }

  /* ---------- 每帧分析（由主渲染循环调用） ---------- */
  update(now) {
    const b = this.bands;
    // 空间音频位置更新（环绕模式每帧推进）
    this.updateSpatial((now || performance.now()) / 1000);
    if (!this.analyser || (!this.playing && !this._demo)) {
      // 停止时平滑衰减
      b.level *= 0.92; b.bass *= 0.92; b.mid *= 0.92; b.treble *= 0.92;
      b.beat = false; b.beatPulse *= 0.94;
      this.bins.fill(this.bins[0] * 0.9 || 0);
      return b;
    }
    if (this._demo) this._analyserTarget = this.analyser; // 演示曲直连 analyser
    this.analyser.getByteFrequencyData(this.freq);
    this.analyser.getByteTimeDomainData(this.wave);

    // RMS（灵敏度倍率：视觉设置）
    const sk = Math.max(0.2, this.sensitivity || 1);
    let sum = 0;
    for (let i = 0; i < this.wave.length; i += 4) { const v = (this.wave[i] - 128) / 128; sum += v * v; }
    const rmsInst = Math.sqrt(sum / (this.wave.length / 4)) * sk; // 瞬时 RMS（时域，不经 analyser 频谱平滑，鼓点 onset 最灵敏）
    b.level = lerp(b.level, rmsInst * 1.9, 0.35);

    // 频段能量（fftSize=2048 → 1024 bins，每 bin ≈ 21.5Hz @44.1k）
    const bandAvg = (lo, hi) => {
      const a = Math.max(1, Math.floor(lo / 21.5)), e = Math.min(this.freq.length - 1, Math.ceil(hi / 21.5));
      let s = 0; for (let i = a; i <= e; i++) s += this.freq[i];
      return s / (e - a + 1) / 255;
    };
    b.bass = lerp(b.bass, bandAvg(20, 250) * 1.25 * sk, 0.4);
    b.mid = lerp(b.mid, bandAvg(250, 2000) * 1.5 * sk, 0.4);
    b.treble = lerp(b.treble, bandAvg(2000, 11000) * 2.0 * sk, 0.4);

    // 对数分箱（96 bins，覆盖 ~35Hz–14kHz）
    const nyq = this.ctx.sampleRate / 2, minF = 35, maxF = Math.min(14000, nyq);
    for (let i = 0; i < this.bins.length; i++) {
      const f0 = minF * Math.pow(maxF / minF, i / this.bins.length);
      const f1 = minF * Math.pow(maxF / minF, (i + 1) / this.bins.length);
      const a = clamp(Math.floor(f0 / 21.5), 1, this.freq.length - 1);
      const e2 = clamp(Math.ceil(f1 / 21.5), a + 1, this.freq.length);
      let mx = 0, s = 0;
      for (let j = a; j < e2; j++) { s += this.freq[j]; if (this.freq[j] > mx) mx = this.freq[j]; }
      const v = (s / (e2 - a) * 0.55 + mx * 0.45) / 255;
      this.bins[i] = lerp(this.bins[i], Math.min(1.4, v * sk), 0.5);
    }

    // 节拍检测：低频能量 > 历史均值 * 阈值（bass 经 analyser 0.8 + lerp 0.4 双重平滑，
    // 持续强低音的歌曲平滑值会贴近均值永不触发，故补充时域瞬时 RMS 上升沿判定 —— 鼓点 onset 在时域最显著）
    this._bassHist[this._histIdx] = b.bass;
    this._histIdx = (this._histIdx + 1) % this._bassHist.length;
    let avg = 0; for (const v of this._bassHist) avg += v;
    avg /= this._bassHist.length;
    b.beat = false;
    const bassHit = b.bass > 0.12 && b.bass > avg * 1.36;
    const rmsHit = rmsInst > 0.12 && rmsInst - this._prevRms > 0.05;
    this._prevRms = rmsInst;
    if ((bassHit || rmsHit) && now - this._lastBeat > 240) {
      b.beat = true;
      b.beatPulse = 1;
      this._lastBeat = now;
      this._emit('beat', { strength: clamp((b.bass - avg) / (avg + 0.001), 0, 3) });
    }
    b.beatPulse *= 0.93;
    return b;
  }

  /* ---------- 配色提取（从封面取主色，驱动全站主题） ---------- */
  async extractPalette(track) {
    const url = track?.coverBlob || track?.coverUrl;
    if (!url) { this._applyPalette(208, 0.5); return; }
    try {
      const img = await this._loadImage(url);
      const n = 24;
      const cv = document.createElement('canvas');
      cv.width = cv.height = n;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.drawImage(img, 0, 0, n, n);
      const d = cx.getImageData(0, 0, n, n).data;
      const buckets = new Float32Array(24), weights = new Float32Array(24), lumas = new Float32Array(24);
      for (let i = 0; i < n * n; i++) {
        const r = d[i * 4], g = d[i * 4 + 1], b2 = d[i * 4 + 2];
        const mx = Math.max(r, g, b2), mn = Math.min(r, g, b2);
        const sat = (mx - mn) / (mx + 0.001), luma = (r * 0.3 + g * 0.6 + b2 * 0.1) / 255;
        if (mx < 26 || sat < 0.18) continue;
        let h;
        if (mx === r) h = ((g - b2) / (mx - mn)) % 6;
        else if (mx === g) h = (b2 - r) / (mx - mn) + 2;
        else h = (r - g) / (mx - mn) + 4;
        h = ((h * 60) + 360) % 360;
        const bi = Math.floor(h / 15) % 24;
        const w = sat * (0.4 + luma);
        buckets[bi] += w; lumas[bi] += luma; weights[bi]++;
      }
      let best = -1, bv = -1;
      for (let i = 0; i < 24; i++) if (buckets[i] > bv) { bv = buckets[i]; best = i; }
      if (best < 0) { this._applyPalette(208, 0.5); return; }
      const hue = best * 15 + 7.5;
      const luma = weights[best] ? lumas[best] / weights[best] : 0.5;
      this._applyPalette(hue, clamp(luma, 0.25, 0.8));
    } catch { this._applyPalette(208, 0.5); }
  }

  _applyPalette(hue, luma) {
    const h2 = (hue + 42) % 360;
    this.palette = {
      hue, hue2: h2, luma,
      accent: `hsl(${hue}, 85%, ${Math.round(52 + luma * 14)}%)`,
      accent2: `hsl(${h2}, 80%, ${Math.round(58 + luma * 10)}%)`
    };
    document.documentElement.style.setProperty('--accent', this.palette.accent);
    document.documentElement.style.setProperty('--accent2', this.palette.accent2);
    this._emit('palette', this.palette);
  }

  _loadImage(url) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => res(img);
      img.onerror = rej;
      img.src = url;
    });
  }
}

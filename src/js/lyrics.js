/* ============ 歌词引擎：LRC/TTML 解析 + 5 套动画预设 + 文字特效参数 + 鼓点弹跳 ============ */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_TAG = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

/** 歌词动画预设（一键切换） */
export const LYRIC_PRESETS = [
  { id: 'flow', name: '流光' },
  { id: 'heart', name: '心象' },
  { id: 'cloud', name: '云阶' },
  { id: 'chars', name: '浮名' },
  { id: 'crowd', name: '群唱' },
  { id: 'neon', name: '霓虹' },
  { id: 'ink', name: '墨' }
];

function tagTime(m) {
  const min = +m[1], sec = +m[2];
  let frac = m[3] ? +(`0.${m[3]}`) : 0;
  if (m[3] && m[3].length >= 3) frac = +m[3] / 1000;
  return min * 60 + sec + frac;
}

/** 解析 LRC（支持逐字 <mm:ss.xx>），返回行数组 */
export function parseLrc(text) {
  if (!text) return [];
  // [offset:±ms] 全局偏移标签（+ 整体延后 / - 整体提前），此前被忽略会导致整曲恒定错位
  const offM = /^\s*\[offset\s*:\s*([+-]?\d+)\s*\]\s*$/im.exec(text);
  const off = offM ? +offM[1] / 1000 : 0;
  const lines = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    TIME_TAG.lastIndex = 0;
    const times = [];
    let m;
    while ((m = TIME_TAG.exec(raw))) times.push(tagTime(m));
    if (!times.length) continue;
    const content = raw.replace(TIME_TAG, '').trim();
    if (!content) continue;

    // 逐字时间戳
    let words = null;
    if (WORD_TAG.test(content)) {
      WORD_TAG.lastIndex = 0;
      words = [];
      let last = times[0], wm;
      let rest = content;
      while ((wm = WORD_TAG.exec(content))) {
        const t = tagTime(wm);
        const before = content.slice(WORD_TAG.lastIndex).split(WORD_TAG)[0] || '';
        const wStart = rest.indexOf(wm[0]);
        const txt = rest.slice(0, wStart);
        if (txt) words.push({ t: last, end: t, text: txt });
        last = t;
        rest = rest.slice(wStart + wm[0].length);
      }
      if (rest) words.push({ t: last, end: last + 3, text: rest });
      words = words.filter(w => w.text);
      if (!words.length) words = null;
    }
    for (const t of times) lines.push({ time: t, end: t + 6, text: content, words });
  }
  lines.sort((a, b) => a.time - b.time);
  // 折叠同槽位翻译行：双语 LRC 常把「原文行 + 中文翻译行」打在同一时间戳（或极近时间）上，
  // 稳定排序后翻译紧跟原文；不处理则二分查找命中翻译行，英文段也显示中文。
  // 规则：与上一行时间差 <0.3s 视为同槽 → 并入上一行 trans（面板双语展示，悬浮歌词只显原文），重复行去重
  for (let i = 1; i < lines.length; i++) {
    const prev = lines[i - 1], cur = lines[i];
    if (cur.time - prev.time >= 0.3) continue;
    if (cur.text !== prev.text && !prev.trans) prev.trans = cur.text;
    lines.splice(i, 1);
    i--;
  }
  for (let i = 0; i < lines.length; i++) {
    lines[i].end = i + 1 < lines.length ? Math.max(lines[i + 1].time, lines[i].time + 0.5) : lines[i].time + 8;
  }
  if (off) {
    for (const l of lines) {
      l.time += off;
      l.end += off;
      if (l.words) for (const w of l.words) { w.t += off; w.end += off; }
    }
  }
  return lines;
}

/** 解析 TTML（逐字高亮）—— span 缺失 end 时不做均分（卡拉OK禁止线性分配），仅做最小占位 */
export function parseTtml(text) {
  if (!text || !/<\s*(tt|p)\b/i.test(text)) return null;
  try {
    const doc = new DOMParser().parseFromString(text, 'text/xml');
    const ps = [...doc.querySelectorAll('p')];
    if (!ps.length) return null;
    const toSec = (v) => {
      if (!v) return NaN;
      const m = /^(\d+):(\d+(?:\.\d+)?)$/.exec(v.trim()); // mm:ss.mmm
      if (m) return +m[1] * 60 + +m[2];
      if (v.includes('s') || v.includes('h') || v.includes('m')) { // ISO-8601 duration
        const d = /P(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(v);
        if (d) return (+d[1] || 0) * 3600 + (+d[2] || 0) * 60 + (+d[3] || 0);
      }
      return +v || NaN;
    };
    const lines = [];
    for (const p of ps) {
      const t0 = toSec(p.getAttribute('begin'));
      const t1 = toSec(p.getAttribute('end'));
      if (!isFinite(t0)) continue;
      const text0 = (p.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text0) continue;
      const line = { time: t0, end: isFinite(t1) ? t1 : t0 + 6, text: text0, words: null };
      // 字级时间：span[begin] 或直接子 span
      const spans = [...p.querySelectorAll('span')].filter(s => s.textContent.trim());
      if (spans.length > 1) {
        const words = [];
        let last = t0;
        for (const s of spans) {
          const sb = toSec(s.getAttribute('begin'));
          const se = toSec(s.getAttribute('end'));
          const st = isFinite(sb) ? sb : last;
          // 【卡拉OK硬性约束：严禁均分】span 缺 end 时禁止用 (line.end - t0) / spans.length 均分，
          // 这是伪精确。改为仅做最小占位（0.08s），真实 end 未知时不造假。
          const en = isFinite(se) ? se : st + 0.08;
          words.push({ t: st, end: en, text: s.textContent });
          last = en;
        }
        line.words = words;
      }
      lines.push(line);
    }
    lines.sort((a, b) => a.time - b.time);
    for (let i = 0; i < lines.length; i++) {
      lines[i].end = i + 1 < lines.length ? Math.max(lines[i + 1].time, lines[i].time + 0.3) : lines[i].time + 8;
    }
    return lines.length ? lines : null;
  } catch { return null; }
}

/** 解析网易云 yrc 逐字歌词（真实人声时间戳）
 *  行格式：[行起点ms,行时长ms](字/词起点ms,时长ms,0)文本(...)文本
 *  强制对齐数据到达——每个 word 有真实人声起止时间，不做任何均分/拉伸压缩 */
export function parseYrc(text) {
  // 注意：真实 yrc 开头常有若干 JSON 制作信息行（{"t":0,...}），必须用 m 标志匹配任意一行
  if (!text || !/^\s*\[\d+,\d+\]/m.test(text)) return null;
  try {
    const lines = [];
    const LINE = /^\[(\d+),(\d+)\](.*)$/;
    for (const raw of text.split(/\r\n|\r|\n/)) {
      const m = LINE.exec(raw.trim());
      if (!m) continue;
      const t0 = +m[1] / 1000;
      const body = m[3];
      const marks = [...body.matchAll(/\((\d+),(\d+),\d+\)/g)];
      if (!marks.length) continue;
      const words = [];
      for (let i = 0; i < marks.length; i++) {
        const st = +marks[i][1] / 1000;
        const en = (+marks[i][1] + Math.max(1, +marks[i][2])) / 1000;
        const from = marks[i].index + marks[i][0].length;
        const to = i + 1 < marks.length ? marks[i + 1].index : body.length;
        const wText = body.slice(from, to).trim();
        if (wText) words.push({ t: st, end: Math.max(en, st + 0.05), text: wText });
      }
      const content = words.map((w) => w.text).join('');
      if (!content || !words.length) continue;
      // 末字结尾兜底：行起点 + 行时长（接口给出），否则推 6s
      const fallbackEnd = t0 + (+m[2] || 6000) / 1000;
      const lastEnd = Math.max(words[words.length - 1].end, t0 + 0.3);
      lines.push({ time: t0, end: Math.max(fallbackEnd, lastEnd), text: content, words });
    }
    lines.sort((a, b) => a.time - b.time);
    for (let i = 0; i < lines.length; i++) {
      lines[i].end = i + 1 < lines.length ? Math.max(lines[i + 1].time, lines[i].time + 0.3) : lines[i].end;
    }
    return lines.length ? lines : null;
  } catch { return null; }
}

/** 合并翻译：按时间戳对齐 */
export function mergeTranslation(lines, transText) {
  if (!transText || !lines.length) return lines;
  const map = new Map();
  for (const raw of transText.split(/\r\n|\r|\n/)) {
    TIME_TAG.lastIndex = 0;
    const m = TIME_TAG.exec(raw);
    if (!m) continue;
    const t = Math.round(tagTime(m) * 10) / 10;
    const content = raw.replace(TIME_TAG, '').trim();
    if (content) map.set(t, content);
  }
  for (const l of lines) {
    const key = Math.round(l.time * 10) / 10;
    if (map.has(key)) l.trans = map.get(key);
    else {
      for (const [t, v] of map) {
        if (Math.abs(t - key) < 0.35) { l.trans = v; break; }
      }
    }
  }
  return lines;
}

/** 将逐词时间切分为逐字时间 —— 卡拉OK正确版本
 *  严格遵守强制对齐原则：
 *  1. word.t 和 word.end 是网易云/QQ 真实人声时间戳（Forced Alignment 产出），
 *     我们绝对不修改、不拉伸、不压缩这个窗口。
 *  2. 当 word 内有多个汉字时（YRC 通常 2-3 字一个 word），在 word 的真实时间片
 *     内部做软分配：按字符数切分窗口，但给首尾字留「呼吸余量」——首字从 word.t 正
 *     式开始，尾字延长到 word.end，中间字时间片略微压缩（每个字取 0.75~0.9 倍等长），
 *     保证总时长 = word.end - word.t（不篡改真实时长）。
 *  这不是「整行均分」（严禁！），是 word 级窗口内的**局部软分配**——窗口本身是
 *  真实人声时间戳，我们只是决定窗口内多字如何过渡。
 *  对比：
 *  ❌ 整行均分：(line.end - line.time) / 总字数 — 伪造时间戳，违反强制对齐
 *  ✅ word 内分配：word 窗口真实，内部按字符数切分 — 保留强制对齐结果
 *  单字 word：直接用 [t, end]，不切分
 */
function wordToChars(w) {
  const chars = [...w.text];
  if (chars.length <= 1) return [{ t: w.t, end: w.end, ch: w.text }];
  const win = w.end - w.t;
  if (win <= 0.01) {
    // 窗口异常 → 全部共享（退化为同时亮）
    return chars.map((c) => ({ t: w.t, end: w.t + 0.05, ch: c }));
  }
  const n = chars.length;
  // 每个字基本时长 = win / n，中间字略微压缩（0.75~0.9 倍），首尾延长
  const base = win / n;
  const out = [];
  let cur = w.t;
  for (let i = 0; i < n; i++) {
    let frac;
    if (i === 0) frac = 1.0;                  // 首字：从 word.t 正始
    else if (i === n - 1) frac = 1.0;         // 尾字：到 word.end
    else frac = 0.82 + (i % 2) * 0.05;        // 中间字：0.82~0.87 压缩（给呼吸感）
    const dur = base * frac;
    out.push({ t: cur, end: cur + dur, ch: chars[i] });
    cur += dur;
  }
  // 把尾字终点对齐回 w.end（浮点误差修正）
  out[n - 1].end = w.end;
  return out;
}

export class LyricRenderer {
  constructor(container, trackEl, hintEl) {
    this.root = container;
    this.track = trackEl;
    this.hint = hintEl;
    this.lines = [];
    this.activeIdx = -1;
    this._offsetY = 0;
    this._els = [];
    this._measureTimer = 0;
    this.bounce = true;   // 鼓点联动弹跳（可开关）
    this.anim = true;     // 歌词动画总开关（低配关闭）
    this.onSeek = null;   // 点击歌词行跳转（app 层注入 engine.seek）
    this._dur = 0;        // 音频总时长（loadedmetadata 后收敛）
    this._lastT = -999;   // 上一帧时间，用于 seek 跳变检测
  }

  /** 应用文字特效参数：glow 发光半径 / stroke 描边宽 / shadow 阴影强度 */
  setTextFx({ glow, stroke, shadow } = {}) {
    const r = this.root.style;
    if (glow != null) r.setProperty('--lyr-glow', glow);
    if (stroke != null) r.setProperty('--lyr-stroke', `${stroke}px`);
    if (shadow != null) r.setProperty('--lyr-shadow', shadow / 100);
  }

  /* 歌词字体（设置中心可选）：写到 :root 变量，歌词面板与舞台悬浮歌词共用。
     默认时移除变量（而非写死 'inherit'），让 CSS 回落 --font-sans，
     保证全局 UI 字体（--ui-font）绝不影响歌词字体 */
  setFont(family) {
    if (family) {
      document.documentElement.style.setProperty('--lyric-font',
        `"${family}", "PingFang SC", "Microsoft YaHei", sans-serif`);
    } else {
      document.documentElement.style.removeProperty('--lyric-font');
    }
  }

  setLyric(text, transText) {
    // yrc 逐字（真人声时间戳）> TTML 逐字 > LRC 行级降级
    const parsed = (text && parseYrc(text))
      || (text && text.includes('<') ? parseTtml(text) : null);
    this.lines = mergeTranslation(parsed || parseLrc(text), transText);
    this.activeIdx = -1;
    this.root.classList.remove('finale'); // 换歌清除收尾淡出态
    this.track.innerHTML = '';
    this._els = [];
    // 有歌词内容时恢复默认提示文案（避免上次的「纯音乐」残留到异常空解析场景）
    if (this._hintDefault) this.hint.innerHTML = this._hintDefault;
    this.hint.style.display = this.lines.length ? 'none' : '';
    this.lines.forEach((line, li) => {
      const div = document.createElement('div');
      div.className = 'lyric-line';
      const t = document.createElement('span');
      t.className = 'tline';
      // 构建字符 span（含逐字时间）
      const chars = line.words
        ? line.words.flatMap(wordToChars)
        : (() => {
            // 【卡拉OK硬性约束：严禁均分】行级 LRC 降级（无强制对齐字级时间戳）——
            // 绝对禁止 (line.end - line.time) / chars.length 把整行时间均分到每个字，
            // 这会违反"禁止任何线性均分时间算法"的规则。
            // 替代方案：所有汉字共享整行窗口 [line.time, line.end)，
            // 即整行同时亮起、同时熄灭（不做卡拉OK扫光）。
            // 没有强制对齐数据就不假装精确——宁可整行亮，也不造假均分。
            const arr = [...line.text];
            const winEnd = Math.max(line.time + 0.3, line.end);
            return arr.map((ch) => ({ t: line.time, end: winEnd, ch }));
          })();
      line.chars = chars;
      chars.forEach((c, ci) => {
        const s = document.createElement('span');
        s.className = 'char dim';
        // 空格用不换行空格：inline-block 下普通空格塌成零宽，英文单词会粘连重叠
        s.textContent = c.ch === ' ' ? ' ' : c.ch;
        s.style.setProperty('--ci', ci);           // 群唱逐字跳动相位
        s.style.setProperty('--cn', chars.length); // 云阶渐入进度
        t.appendChild(s);
      });
      div.appendChild(t);
      if (line.trans) {
        const tr = document.createElement('span');
        tr.className = 'trline';
        tr.textContent = line.trans;
        div.appendChild(tr);
      }
      div.style.setProperty('--li', li);
      // 点击行 → 跳转播放进度（onSeek 由 app 层接线）
      div.addEventListener('click', () => { if (this.onSeek) this.onSeek(Math.max(0, line.time - 0.03)); });
      this.track.appendChild(div);
      this._els.push(div);
    });
    this._lastT = -999; // 换歌重置 seek 检测基线
    this._dur = 0;      // 换歌重置时长基线：等本曲 loadedmetadata 到达后按新时长收敛（不沿用上一曲）
    this._finalize();
  }

  /** 音频总时长到达/变化时收敛时间轴（loadedmetadata 后才能拿到准确值） */
  setDuration(d) {
    d = +d || 0;
    if (d > 0 && Math.abs(d - this._dur) > 0.05) { this._dur = d; this._finalize(); }
  }

  /* 音频时间驱动后处理（幂等）：
     1) 无字级时间戳的行：按整行可用窗口铺满（窗口 = 下一行起点；末行 +8s，收敛 ≤ duration）；
     2) 有字级时间戳的行：清洗为单调递增、每字最小时长的连续时间轴；字间空洞自动填充
        （前一字 end 延伸到下一字 t），扫光进度连续不中断、绝不提前终止；
     3) 边界保护：所有字/行 end 收敛 ≤ 音频总时长（最后一个字的结束时间必须 ≤ duration）；
        LRC 短于音频时末行扫光完成后保持满亮停留，直到音频播完由 .finale 收尾淡出。 */
  _finalize() {
    const dur = this._dur > 0 ? this._dur : 0;
    for (const line of this.lines) {
      const chars = line.chars;
      if (!chars || !chars.length) continue;
      // 首次固化原始时间轴（end0/t0/end0），此后每次重算都从原始值出发 → clamp 可逆、幂等，
      // 时长先按在线元数据、后按 audio.duration 精修时不会越收越短
      if (line.end0 == null) line.end0 = line.end;
      line.end = line.end0;
      for (const c of chars) {
        if (c.t0 == null) { c.t0 = c.t; c.end0 = c.end; }
        c.t = c.t0; c.end = c.end0;
      }
      if (dur && line.end > dur) line.end = dur;
      if (!line.words) {
        // (1) 行级 LRC 降级：所有字共享整行窗口 —— 严禁均分！
        const winEnd = Math.max(line.time + 0.3, line.end);
        chars.forEach((c) => {
          c.t = line.time;
          c.end = winEnd;
        });
      } else {
        // (2) 真实字级时间戳：清洗 + 空洞填充
        let prevT = line.time;
        for (const c of chars) {
          if (!isFinite(c.t) || c.t < prevT - 0.02) c.t = prevT;      // 缺失/回退 → 接续前一字
          if (!isFinite(c.end) || c.end <= c.t) c.end = c.t + 0.08;   // 缺 end → 最小占位，防除零
          prevT = c.t;
        }
        for (let i = 1; i < chars.length; i++) {
          if (chars[i].t > chars[i - 1].end) chars[i - 1].end = chars[i].t; // 空洞：前一字段拉长到本字起点
        }
        // (3) 收敛到音频总时长
        if (dur) {
          for (const c of chars) {
            if (c.t > dur) c.t = dur;
            if (c.end > dur) c.end = dur;
            if (c.end <= c.t) c.end = Math.min(dur, c.t + 0.04);
          }
        }
      }
    }
  }

  clear(pureMusic = false) {
    this.lines = [];
    this.activeIdx = -1;
    this._lastT = -999;
    this.root.classList.remove('finale');
    this.track.innerHTML = '';
    // 已确认该曲无歌词（instrumental / 接口无数据）→ 显示「纯音乐」；
    // 其余情况（未播放 / 加载中）显示默认提示
    if (!this._hintDefault) this._hintDefault = this.hint.innerHTML;
    this.hint.innerHTML = pureMusic ? '纯音乐，请欣赏' : this._hintDefault;
    this.hint.style.display = '';
  }

  _findIdx(time) {
    const ls = this.lines;
    if (!ls.length) return -1;
    let lo = 0, hi = ls.length - 1, res = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ls[mid].time <= time) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return res;
  }

  _measure() {
    const H = this.root.clientHeight;
    let y = 0;
    for (let i = 0; i < this._els.length; i++) {
      const el = this._els[i];
      const h = el.offsetHeight;
      if (i === this.activeIdx) this._target = H / 2 - y - h / 2;
      y += h;
    }
  }

  _scheduleMeasure() {
    clearTimeout(this._measureTimer);
    this._measure();
    this._measureTimer = setTimeout(this._measure.bind(this), 260);
    setTimeout(this._measure.bind(this), 650);
  }

  update(time, bands, dur = 0, rawTime = null) {
    // 音频总时长（loadedmetadata 后才知道）：到达/变化时收敛歌词时间轴（幂等）
    if (dur > 0) this.setDuration(dur);
    // 拖拽 seek 检测：时间位移跳变 → 滚动即刻归位（不缓动爬行）+ 清残留逐字弹跳，高亮立即跳到对应位置
    const jumped = this._lastT > -900 && Math.abs(time - this._lastT) > 1.2;
    this._lastT = time;
    const idx = this._findIdx(time);
    if (idx !== this.activeIdx) {
      this.activeIdx = idx;
      for (let i = 0; i < this._els.length; i++) {
        const el = this._els[i];
        el.classList.toggle('active', i === idx);
        el.classList.toggle('near', Math.abs(i - idx) === 1);
        if (el.style.transform) el.style.transform = '';
        // 清理上一 active 行的逐字弹跳残留
        if (el._singIdx != null) {
          el._charEls?.[el._singIdx]?.classList.remove('sing');
          el._singIdx = null;
        }
      }
      this._scheduleMeasure();
    }
    if (jumped) {
      if (this._target != null) this._offsetY = this._target;
      for (const el of this._els) {
        if (el._singIdx != null) { el._charEls?.[el._singIdx]?.classList.remove('sing'); el._singIdx = null; }
      }
    }
    if (!this.lines.length) return;

    // 滚动缓动（track 以 top:0 定位，target 即视口中心 - 行中心偏移）
    if (this._target != null) this._offsetY += (this._target - this._offsetY) * 0.14;
    // beatPulse 全链路透传须过「鼓点弹跳」开关：关掉后歌词不再有任何鼓点驱动的缩放/弹跳
    const bp = (this.anim && this.bounce) ? (bands?.beatPulse || 0) : 0;
    const pulse = 1 + bp * 0.03;
    this.track.style.transform = `translateY(${this._offsetY.toFixed(1)}px) scale(${pulse.toFixed(4)})`;

    // 鼓点联动弹跳：作用于 .tline（行级 transform 已由 CSS spring 管理，互不打架）
    const el = this._els[idx];
    if (el && this.bounce && this.anim) {
      const tl = el._tlineEl || (el._tlineEl = el.querySelector('.tline'));
      if (tl) tl.style.transform = `scale(${(1 + bp * 0.05).toFixed(4)})`;
    }

    // 逐字点亮：.dim 离散翻转（兼容旧预设）+ --lit 连续插值（丝滑渐变填充）
    // 双轨语义（都是音频时间驱动，暂停即冻结、拖拽即跳转）：
    //   字级（YRC/TTML）：--lit = 已唱字符数（浮点），--cp = clamp(lit - ci) 逐字扫光；
    //   行级（纯 LRC，无逐字时间戳，严禁均分造假）：所有字共享整行窗口，
    //     加 .line-kara 让 --cp = --lit —— 整行随行窗口同步扫光（不假装逐字），
    //     修掉旧版 --lit 只走 0~1 导致「扫光卡在第 1 个字、其余字整行末尾瞬间全亮」的 bug。
    const line = this.lines[idx];
    if (!line || !el) return;
    const charEls = el._charEls || (el._charEls = el.querySelectorAll('.char'));
    const chars = line.chars;
    let litN = 0;
    if (chars && chars.length) {
      if (!line.words) {
        el.classList.add('line-kara');
        const T = line.time, E = Math.max(line.time + 0.3, line.end);
        litN = E > T ? Math.min(1, Math.max(0, (time - T) / (E - T))) : 1;
        for (let i = 0; i < chars.length; i++) {
          const lit = time >= chars[i].t;
          const cls = charEls[i].classList;
          if (lit !== !cls.contains('dim')) cls.toggle('dim', !lit);
        }
        // 行级数据无法定位「正在唱的字」→ 不做逐字弹跳（清残留）
        if (el._singIdx != null) { charEls[el._singIdx]?.classList.remove('sing'); el._singIdx = null; }
      } else {
        el.classList.remove('line-kara');
        for (let i = 0; i < chars.length; i++) {
          const c = chars[i];
          const lit = time >= c.t;
          const cls = charEls[i].classList;
          if (lit !== !cls.contains('dim')) cls.toggle('dim', !lit);
          if (time >= c.end) litN = i + 1;
          else if (lit) { litN = i + (time - c.t) / Math.max(0.05, c.end - c.t); break; }
          else break;
        }
      }
    }
    // --lit：字级 = 已点亮字符数（浮点）；行级 = 整行扫光进度 0~1
    el.style.setProperty('--lit', litN.toFixed(3));
    // 逐字弹跳：正在唱的字加 .sing（上浮放大），唱完自动移交给下一个字（仅字级数据有意义）
    // —— 受「鼓点弹跳」开关门控（this.bounce）：关掉后卡拉OK 不再逐字弹跳
    const singing = (this.bounce && line.words && litN > 0 && litN < chars.length) ? Math.floor(litN) : -1;
    if (singing !== el._singIdx) {
      if (el._singIdx != null) charEls[el._singIdx]?.classList.remove('sing');
      charEls[singing]?.classList.add('sing');
      el._singIdx = singing;
    }
    // 收尾淡出：LRC 短于音频时末行保持满亮停留，直到音频完全播完才缓慢淡出，绝不提前结束
    const rt = rawTime != null ? rawTime : time;
    this.root.classList.toggle('finale', this._dur > 0 && rt >= this._dur - 0.06);
  }
}

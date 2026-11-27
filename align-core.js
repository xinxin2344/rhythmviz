/* ============ 逐字对齐核心：识别字流 × 歌词文本 序列对齐（纯函数，无 Electron 依赖，可单测） ============ */

const SKIP = /[\s\p{P}\p{S}]/u;

/** 归一化：全角→半角 + 小写（用于比对，不改变展示文本） */
export function normChar(ch) {
  if (!ch) return '';
  const code = ch.charCodeAt(0);
  if (code >= 0xff01 && code <= 0xff5e) return String.fromCharCode(code - 0xfee0).toLowerCase();
  return ch.toLowerCase();
}

export function isSkippable(ch) { return SKIP.test(ch); }

/** sherpa-onnx 识别结果 tokens+timestamps → 字流 [{ch, t, end}]
 *  zh 模型 token 基本为单字（时间戳即字时间戳）；英文 BPE 子词（带 ▁ 前缀）为多字符 token，
 *  其时间窗为真实识别窗口，窗内按字符数均分过渡（窗口真实，非整行均分）。 */
export function tokensToChars(tokens, timestamps) {
  const out = [];
  const n = Math.min(tokens?.length || 0, timestamps?.length || 0);
  for (let i = 0; i < n; i++) {
    const raw = String(tokens[i] || '').replace(/^▁+/, '').replace(/ /g, '');
    if (!raw) continue;
    const t0 = +timestamps[i];
    const t1 = i + 1 < timestamps.length ? +timestamps[i + 1] : t0 + 0.3;
    const chars = [...raw];
    if (chars.length === 1) { out.push({ ch: chars[0], t: t0, end: Math.max(t1, t0 + 0.03) }); continue; }
    const span = Math.max(t1 - t0, 0.03 * chars.length);
    for (let k = 0; k < chars.length; k++) {
      out.push({ ch: chars[k], t: t0 + (span * k) / chars.length, end: t0 + (span * (k + 1)) / chars.length });
    }
  }
  return out;
}

/** 歌词行 × 识别字流 序列对齐 → 每行 words（字级真实时间戳）或 null（该行降级行级扫光）
 *  策略：双指针贪心 + 小窗口前瞻（同一首歌两序列大体一致）；
 *  未命中字与标点/空格：借用前一已定位字的 end（链式 +0.05s），不造假拉伸；
 *  行失配率 > maxMiss → 整行 words=null（前端 lyricSingWindow 行级扫光降级）。 */
export function alignLinesToChars(lines, asrChars, opts = {}) {
  const lookahead = opts.lookahead ?? 6;
  const maxMiss = opts.maxMiss ?? 0.4;
  // 识别流预过滤：去标点空白并归一化（保留原始时间）
  const A = [];
  for (const c of asrChars || []) {
    if (!c.ch || isSkippable(c.ch)) continue;
    A.push({ ch: normChar(c.ch), t: c.t, end: c.end });
  }
  let cursor = 0;
  return (lines || []).map((line) => {
    const chars = [...(line.text || '')];
    // 目标序列：本行需定位的字（非标点空白），记录原索引
    const targets = [];
    for (let i = 0; i < chars.length; i++) {
      if (!isSkippable(chars[i])) targets.push({ idx: i, ch: normChar(chars[i]) });
    }
    if (!targets.length) return { time: line.time, end: line.end, text: line.text, words: null };
    const located = new Array(chars.length).fill(null); // idx → {t, end}
    let miss = 0;
    for (const tg of targets) {
      let found = -1;
      const lim = Math.min(cursor + lookahead, A.length);
      for (let j = cursor; j < lim; j++) {
        if (A[j].ch === tg.ch) { found = j; break; }
      }
      if (found >= 0) { located[tg.idx] = { t: A[found].t, end: A[found].end }; cursor = found + 1; }
      else miss++;
    }
    if (miss / targets.length > maxMiss) return { time: line.time, end: line.end, text: line.text, words: null };
    // 填补未定位字（含标点空格）：借前一字 end 链式 +0.05s；行首无参照则用 line.time
    let prevT = line.time, prevEnd = line.time;
    const words = chars.map((ch, i) => {
      let w = located[i];
      if (!w) w = { t: prevEnd, end: prevEnd + 0.05 };
      // 单调保护：识别噪声导致的时间回退在此收敛（_finalize 还会再清洗一次）
      const t = Math.max(w.t, prevT);
      const end = Math.max(w.end, t + 0.03);
      prevT = t; prevEnd = end;
      return { t, end, text: ch };
    });
    return { time: line.time, end: line.end, text: line.text, words };
  });
}

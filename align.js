/* ============ 逐字对齐（主进程）：sherpa-onnx paraformer 中文识别 + 歌词序列对齐 ============
   链路：ffmpeg 解码 16k 单声道 → sherpa-onnx 识别（自带字级时间戳）→ align-core 文本序列对齐
        → 成品歌词行缓存到 userData/align-cache → 'align:done' 推送渲染层热替换
   全部本地运行、免费、不跑 Python/云端；识别与缓存在主进程异步执行，不阻塞播放。 */
import { app, ipcMain } from 'electron';
import path from 'node:path';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { tokensToChars, alignLinesToChars } from './align-core.js';

const require = createRequire(import.meta.url);

/* 模型：sherpa-onnx paraformer 中文（int8，~243MB，首次按需下载，不进安装包） */
const MODEL_REPO = 'csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14';
const MODEL_FILES = ['model.int8.onnx', 'tokens.txt'];
const MODEL_BASES = [
  `https://hf-mirror.com/${MODEL_REPO}/resolve/main`,   // 国内镜像优先
  `https://huggingface.co/${MODEL_REPO}/resolve/main`
];

let store = null, sourceMgr = null, getWin = null;
let recPromise = null;        // OfflineRecognizer 单例（懒加载，createAsync 不阻塞 JS 线程）
let queue = Promise.resolve(); // 对齐任务串行队列
let downloading = null;        // 模型下载进行态 {file, received, total}

const modelDir = () => path.join(app.getPath('userData'), 'models', 'paraformer-zh');
const cacheDir = () => path.join(app.getPath('userData'), 'align-cache');
const enabled = () => store?.get('alignEnabled') !== false; // 默认开
const send = (ch, data) => { try { getWin()?.webContents.send(ch, data); } catch { /* 窗口已销毁 */ } };

function modelState() {
  const dir = modelDir();
  const files = MODEL_FILES.map((f) => path.join(dir, f));
  const ready = files.every((p) => {
    try { return fsSync.statSync(p).size > (p.endsWith('.onnx') ? 100 * 1024 * 1024 : 1000); } catch { return false; }
  });
  return { dir, files, ready };
}

async function ensureRecognizer() {
  if (!recPromise) {
    recPromise = (async () => {
      const so = require('sherpa-onnx-node');
      const { files } = modelState();
      return await so.OfflineRecognizer.createAsync({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          paraformer: { model: files[0] },
          tokens: files[1],
          numThreads: Math.max(2, Math.min(6, os.cpus().length - 2)),
          provider: 'cpu',
          debug: 0
        }
      });
    })();
    recPromise.catch(() => { recPromise = null; }); // 失败后允许重试
  }
  return recPromise;
}

/* ffmpeg 解码 → 16kHz 单声道 Float32Array；input 为本地路径或 URL（headers 可选） */
function decodeAudio(input, headers) {
  return new Promise((resolve, reject) => {
    let ff = require('ffmpeg-static');
    if (ff.includes('app.asar')) ff = ff.replace('app.asar', 'app.asar.unpacked');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (headers && Object.keys(headers).length) {
      args.push('-headers', Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n');
    }
    args.push('-i', input, '-f', 'f32le', '-ac', '1', '-ar', '16000', 'pipe:1');
    const proc = spawn(ff, args);
    const chunks = [];
    let errText = '';
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.stderr.on('data', (d) => { errText += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error('ffmpeg 解码失败: ' + errText.slice(-200)));
      const buf = Buffer.concat(chunks);
      if (buf.length < 16000 * 4) return reject(new Error('音频过短或解码为空'));
      resolve(new Float32Array(buf.buffer, buf.byteOffset, (buf.length / 4) | 0));
    });
  });
}

async function runJob(spec) {
  const { uid, lines } = spec;
  // 音频来源
  let input, headers = null;
  if (spec.kind === 'local') {
    input = spec.path;
  } else {
    const res = await sourceMgr.resolvePlayUrl({ srcId: spec.srcId || 'netease', id: spec.songId, title: spec.title, artist: spec.artist });
    if (!res?.url) throw new Error('无法获取播放地址');
    input = res.url; headers = res.headers || null;
  }
  const samples = await decodeAudio(input, headers);
  const rec = await ensureRecognizer();
  const stream = rec.createStream();
  stream.acceptWaveform({ samples, sampleRate: 16000 });
  const result = await rec.decodeAsync(stream);
  const asrChars = tokensToChars(result.tokens, result.timestamps);
  if (!asrChars.length) throw new Error('识别结果为空（可能无人声）');
  const aligned = alignLinesToChars(lines, asrChars);
  const hitLines = aligned.filter((l) => l.words).length;
  if (!hitLines) throw new Error('歌词与音频匹配度过低');
  return { v: 1, lines: aligned, hit: hitLines + '/' + aligned.length };
}

async function handleRequest(spec) {
  try {
    if (!enabled()) return { ok: false, reason: 'disabled' };
    if (!spec?.lines?.length) return { ok: false, reason: 'no-lines' };
    const ms = modelState();
    if (!ms.ready) return { ok: false, reason: 'need-model' };
    // 缓存键：歌曲标识 + 歌词文本哈希
    let ident;
    if (spec.kind === 'local') {
      const st = await fs.stat(spec.path);
      ident = `${spec.path}:${st.size}:${Math.round(st.mtimeMs)}`;
    } else {
      ident = `${spec.srcId || 'netease'}:${spec.songId}`;
    }
    const key = crypto.createHash('sha1')
      .update(ident + '|' + crypto.createHash('sha1').update(spec.lines.map((l) => l.text).join('\n')).digest('hex'))
      .digest('hex');
    const cacheFile = path.join(cacheDir(), key + '.json');
    try {
      const hit = JSON.parse(await fs.readFile(cacheFile, 'utf8'));
      if (hit?.lines?.length) { send('align:done', { uid: spec.uid, lyricJson: hit }); return { ok: true, cached: true }; }
    } catch { /* 未命中 */ }
    // 排队执行，完成后推送 + 落缓存
    queue = queue.then(async () => {
      try {
        const lyricJson = await runJob(spec);
        await fs.mkdir(cacheDir(), { recursive: true });
        await fs.writeFile(cacheFile, JSON.stringify(lyricJson));
        send('align:done', { uid: spec.uid, lyricJson });
      } catch (e) {
        send('align:fail', { uid: spec.uid, msg: String(e?.message || e) });
      }
    });
    return { ok: true, queued: true };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

async function downloadModel() {
  if (downloading) return { ok: true, running: true };
  const { dir, ready } = modelState();
  if (ready) return { ok: true, ready: true };
  await fs.mkdir(dir, { recursive: true });
  downloading = { file: '', received: 0, total: 0 };
  (async () => {
    try {
      for (const f of MODEL_FILES) {
        const dest = path.join(dir, f);
        const part = dest + '.part';
        let done = false, lastErr = null;
        for (const base of MODEL_BASES) {
          try {
            const resp = await fetch(`${base}/${f}`, { redirect: 'follow' });
            if (!resp.ok || !resp.body) throw new Error('HTTP ' + resp.status);
            const total = +resp.headers.get('content-length') || 0;
            downloading = { file: f, received: 0, total };
            send('align:model-progress', { ...downloading });
            const out = fsSync.createWriteStream(part);
            const reader = resp.body.getReader();
            for (;;) {
              const { done: d, value } = await reader.read();
              if (d) break;
              out.write(Buffer.from(value));
              downloading.received += value.length;
              if (downloading.received - (downloading._lastSent || 0) > 1024 * 1024) {
                downloading._lastSent = downloading.received;
                send('align:model-progress', { file: f, received: downloading.received, total });
              }
            }
            await new Promise((r) => out.end(r));
            done = true; break;
          } catch (e) { lastErr = e; try { await fs.unlink(part); } catch { /* noop */ } }
        }
        if (!done) throw lastErr || new Error(f + ' 下载失败');
        await fs.rename(part, dest);
      }
      send('align:model-progress', { done: true });
    } catch (e) {
      send('align:model-progress', { error: String(e?.message || e) });
    } finally { downloading = null; }
  })();
  return { ok: true, started: true };
}

export function registerAlignIPC(deps) {
  store = deps.store; sourceMgr = deps.sourceMgr; getWin = deps.getWin;
  ipcMain.handle('align:request', (_e, spec) => handleRequest(spec));
  ipcMain.handle('align:status', () => ({
    enabled: enabled(),
    engine: 'sherpa-onnx paraformer-zh',
    modelReady: modelState().ready,
    downloading: !!downloading,
    busy: !!recPromise
  }));
  ipcMain.handle('align:model-download', () => downloadModel());
  ipcMain.handle('align:cache-clear', async () => {
    try { await fs.rm(cacheDir(), { recursive: true, force: true }); } catch { /* noop */ }
    return { ok: true };
  });
}

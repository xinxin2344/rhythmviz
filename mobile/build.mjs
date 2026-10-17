/* 构建：esbuild 打包垫片/PoC + 同步桌面前端到 www/ 并注入移动端资源 */
import { build } from 'esbuild';
import { cpSync, mkdirSync, existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');                       // 音乐/
const WEB_SRC = join(ROOT, 'src');                        // 桌面渲染层
const WWW = join(__dirname, 'www');
const TMP = join(__dirname, '.tmp');
const POC = process.argv.includes('--poc');
const NODE_TEST = process.argv.includes('--node-test');

const POC_HTML = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
<title>RhythmViz PoC</title>
<style>
  body { background:#0b0f14; color:#dfe8f0; font:14px/1.5 system-ui,sans-serif; margin:0; padding:12px; }
  h2 { font-size:15px; margin:14px 0 6px; }
  button { background:#1e5eff; color:#fff; border:0; border-radius:8px; padding:9px 12px; margin:4px 6px 4px 0; font-size:13px; }
  #out { white-space:pre-wrap; word-break:break-all; background:#070a0e; border:1px solid #1c2735; border-radius:8px;
         padding:8px; height:38vh; overflow:auto; font:11px/1.5 ui-monospace,Consolas,monospace; }
  #qr { display:block; margin:8px auto; width:220px; height:220px; background:#fff; border-radius:8px; }
</style>
</head>
<body>
<h2>① 音源搜索（原生网络）</h2>
<div>
  <button id="search-ne">网易搜索</button>
  <button id="search-qq">QQ搜索</button>
</div>
<h2>② 播放地址（含换源）</h2>
<div>
  <button id="play-ne">网易播放地址</button>
  <button id="play-qq">QQ播放地址</button>
  <button id="bin">整曲二进制</button>
</div>
<h2>③ 扫码登录（用另一台设备扫）</h2>
<div>
  <button id="qr-ne">网易云出码</button>
  <button id="qr-qq">QQ音乐出码</button>
</div>
<img id="qr" />
<div id="out">PoC 就绪…</div>
<script src="js/vendor/qrcode.js"></script>
<script src="mobile/poc.js"></script>
</body>
</html>
`;

mkdirSync(WWW, { recursive: true });
mkdirSync(TMP, { recursive: true });

/* 根 package.json 是 type:module，但音源插件是 CJS（module.exports）；
   复制为 .cjs 副本并通过 onResolve 改写路径，强制 CJS 解析与 default interop */
const cjsDir = join(TMP, 'cjs');
mkdirSync(cjsDir, { recursive: true });
for (const name of ['qq', 'netease']) {
  copyFileSync(join(ROOT, 'sources/plugins', name + '.js'), join(cjsDir, name + '.cjs'));
}
const forceCjsPlugin = {
  name: 'force-cjs-source-plugins',
  setup(b) {
    b.onResolve({ filter: /[\\/]sources[\\/]plugins[\\/](qq|netease)\.js$/ }, (args) => {
      const m = /(qq|netease)\.js$/.exec(args.path.replace(/\\/g, '/'));
      return { path: join(cjsDir, m[1] + '.cjs') };
    });
  }
};

if (NODE_TEST) {
  const out = join(TMP, 'node-test.mjs');
  await build({
    entryPoints: [join(__dirname, 'src/poc/node-run.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    outfile: out,
    logLevel: 'info',
    plugins: [forceCjsPlugin]
  });
  execFileSync(process.execPath, [out], { stdio: 'inherit' });
  process.exit(0);
}

/* 1) 打包浏览器侧 bundle */
await build({
  entryPoints: {
    'mobile/bridge': join(__dirname, 'src/bridge.js'),
    'mobile/poc': join(__dirname, 'src/poc/poc.js')
  },
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome110'],
  outdir: WWW,
  logLevel: 'info',
  sourcemap: 'inline',
  plugins: [forceCjsPlugin]
});

/* 2) 同步桌面前端（css/js/assets/vendor） */
for (const name of ['css', 'js', 'assets']) {
  const from = join(WEB_SRC, name);
  if (existsSync(from)) cpSync(from, join(WWW, name), { recursive: true });
}
// 其他根目录静态资源（图标/字体等）
for (const f of ['favicon.ico', 'favicon.svg', 'icon.png']) {
  const from = join(WEB_SRC, f);
  if (existsSync(from)) copyFileSync(from, join(WWW, f));
}

/* 3) mobile.css */
mkdirSync(join(WWW, 'mobile'), { recursive: true });
copyFileSync(join(__dirname, 'mobile.css'), join(WWW, 'mobile/mobile.css'));

/* 4) index.html */
if (POC) {
  writeFileSync(join(WWW, 'index.html'), POC_HTML, 'utf8');
  console.log('[build] PoC 模式 index.html 已写入');
} else {
  let html = readFileSync(join(WEB_SRC, 'index.html'), 'utf8');
  // viewport
  const vp = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover" />';
  if (/<meta[^>]+name=["']viewport["'][^>]*>/i.test(html)) {
    html = html.replace(/<meta[^>]+name=["']viewport["'][^>]*>/i, vp);
  } else {
    html = html.replace(/<head[^>]*>/i, (m) => m + '\n  ' + vp);
  }
  // mobile.css
  if (!html.includes('mobile/mobile.css')) {
    html = html.replace(/<\/head>/i, '  <link rel="stylesheet" href="mobile/mobile.css" />\n</head>');
  }
  // bridge 必须在 qrcode.js / app.js 之前（普通脚本同步执行）
  if (!html.includes('mobile/bridge.js')) {
    const tag = '<script src="mobile/bridge.js"></script>';
    if (html.includes('js/vendor/qrcode.js')) {
      html = html.replace(/<script[^>]+js\/vendor\/qrcode\.js[^>]*><\/script>/,
        (m) => tag + '\n  ' + m);
    } else {
      html = html.replace(/<body[^>]*>/i, (m) => m + '\n  ' + tag);
    }
  }
  writeFileSync(join(WWW, 'index.html'), html, 'utf8');
  console.log('[build] 正式 index.html 已注入 bridge / mobile.css');
}

console.log('[build] 完成 →', WWW);

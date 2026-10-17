/* 网络层：
   - Android 原生走自定义 RhythmNet 插件（OkHttp + CookieStore，无 CORS、保留全部 Set-Cookie、重定向链 cookie 全收集）
   - Node（PoC）走全局 fetch，getSetCookie 兜底
   返回统一结构：{ status, headers(小写 map), headerList, bytes, cookies, finalUrl } */
import { Capacitor, registerPlugin } from '@capacitor/core';
import { b64encode, b64decode } from './buffer-poly.js';
import { parseSetCookie } from './jar.js';

let RhythmNet = null;
try { RhythmNet = registerPlugin('RhythmNet'); } catch { RhythmNet = null; }

const IS_NATIVE = Capacitor.isNativePlatform?.() ?? false;

function u8ToB64(u8) { return b64encode(u8); }
function b64ToU8(s) { return b64decode(s); }

function headersToList(h) {
  return Object.entries(h || {}).map(([name, value]) => ({ name, value: String(value) }));
}
function listToMap(list) {
  const out = {};
  for (const { name, value } of (list || [])) {
    const k = String(name).toLowerCase();
    if (k in out) out[k] += ', ' + value; else out[k] = value;
  }
  return out;
}

/* ---------------- 原生实现 ---------------- */
async function nativeRaw({ url, method, headers, text, bytes, followRedirects, timeoutMs }) {
  const args = {
    url,
    method: method || 'GET',
    headers: headersToList(headers),
    followRedirects: followRedirects !== false,
    timeoutMs: timeoutMs || 20000
  };
  if (text != null) args.bodyText = String(text);
  else if (bytes) args.bodyBase64 = u8ToB64(bytes);
  const res = await RhythmNet.request(args);
  const headerList = (res.headers || []).map((h) => ({ name: String(h.name), value: String(h.value) }));
  return {
    status: res.status || 0,
    headerList,
    headers: listToMap(headerList),
    bytes: res.bodyBase64 ? b64ToU8(res.bodyBase64) : new Uint8Array(0),
    cookies: Array.isArray(res.cookies) ? res.cookies : [],
    finalUrl: res.finalUrl || url
  };
}

/* ---------------- Node / 浏览器兜底（PoC 验证签名与解析） ---------------- */
async function nodeRaw({ url, method, headers, text, bytes, followRedirects, timeoutMs }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  let body;
  if (text != null) body = String(text);
  else if (bytes) body = bytes;
  try {
    const r = await fetch(url, {
      method: method || 'GET',
      headers: headers || {},
      body: (method === 'GET' || method === 'HEAD') ? undefined : body,
      redirect: followRedirects === false ? 'manual' : 'follow',
      signal: ctrl.signal
    });
    const ab = await r.arrayBuffer();
    const headerList = [];
    r.headers.forEach((value, name) => headerList.push({ name, value }));
    let setCookie = [];
    if (typeof r.headers.getSetCookie === 'function') setCookie = r.headers.getSetCookie();
    else {
      const sc = r.headers.get('set-cookie');
      if (sc) setCookie = sc.split(/,(?=[^;]+=)/);
    }
    const cookies = parseSetCookie(setCookie, url);
    return {
      status: r.status,
      headerList,
      headers: listToMap(headerList),
      bytes: new Uint8Array(ab),
      cookies,
      finalUrl: r.url || url
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isNative() { return IS_NATIVE; }

export async function rawRequest(opts) {
  return IS_NATIVE ? nativeRaw(opts) : nodeRaw(opts);
}

/** 音源插件 host.net.request 契约：encoding 'utf8' → body 字符串；'buffer' → Uint8Array */
export async function pluginRequest(opts = {}) {
  const r = await rawRequest({
    url: opts.url,
    method: opts.method || 'GET',
    headers: opts.headers || {},
    text: opts.body == null ? null : String(opts.body),
    followRedirects: opts.redirect !== 'manual',
    timeoutMs: opts.timeout || 15000
  });
  if (opts.encoding === 'buffer') return { status: r.status, headers: r.headers, body: r.bytes, _resp: r };
  const body = new TextDecoder('utf-8').decode(r.bytes);
  return { status: r.status, headers: r.headers, body, _resp: r };
}

/** 音频 / 封面 / 二维码整取（无 CORS、可带 Referer 防盗链），返回 { data:Uint8Array, contentType, finalUrl } */
export async function binaryFetch(url, headers = {}, timeoutMs = 30000) {
  const r = await rawRequest({ url, method: 'GET', headers, followRedirects: true, timeoutMs });
  if (r.status !== 200 && r.status !== 206) {
    throw Object.assign(new Error('HTTP ' + r.status), { code: 'E_HTTP', status: r.status });
  }
  return {
    data: r.bytes,
    contentType: r.headers['content-type'] || 'application/octet-stream',
    finalUrl: r.finalUrl,
    cookies: r.cookies
  };
}

/** dataURL 工具：bytes → image dataURL */
export function toDataUrl(u8, mime) {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  const b64 = (typeof btoa === 'function') ? btoa(bin) : u8ToB64(u8);
  return `data:${mime || 'image/png'};base64,${b64}`;
}

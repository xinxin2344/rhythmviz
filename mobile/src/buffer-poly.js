/* 最小 Buffer 实现：音源插件（netease weapi 签名等）依赖 Buffer.from()/toString('base64'|'hex') */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function b64encode(u8) {
  let out = '';
  for (let i = 0; i < u8.length; i += 3) {
    const b0 = u8[i], b1 = i + 1 < u8.length ? u8[i + 1] : 0, b2 = i + 2 < u8.length ? u8[i + 2] : 0;
    out += B64[b0 >> 2];
    out += B64[((b0 & 3) << 4) | (b1 >> 4)];
    out += i + 1 < u8.length ? B64[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    out += i + 2 < u8.length ? B64[b2 & 63] : '=';
  }
  return out;
}

function b64decode(str) {
  const clean = String(str).replace(/[^A-Za-z0-9+/=]/g, '');
  const bin = (typeof atob === 'function') ? atob(clean)
    : B64DecodeFallback(clean);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function B64DecodeFallback(clean) {
  let bin = '';
  for (let i = 0; i < clean.length; i += 4) {
    const n0 = B64.indexOf(clean[i]), n1 = B64.indexOf(clean[i + 1]);
    const n2 = B64.indexOf(clean[i + 2]), n3 = B64.indexOf(clean[i + 3]);
    bin += String.fromCharCode((n0 << 2) | (n1 >> 4));
    if (clean[i + 2] !== '=') bin += String.fromCharCode(((n1 & 15) << 4) | (n2 >> 2));
    if (clean[i + 3] !== '=') bin += String.fromCharCode(((n2 & 3) << 6) | n3);
  }
  return bin;
}

export class MiniBuffer extends Uint8Array {
  static from(input, enc) {
    if (input == null) return new MiniBuffer(0);
    if (typeof input === 'string') {
      if (enc === 'base64') return new MiniBuffer(b64decode(input));
      if (enc === 'hex') {
        const clean = input.replace(/[^0-9a-fA-F]/g, '');
        const u8 = new Uint8Array(clean.length >> 1);
        for (let i = 0; i < u8.length; i++) u8[i] = parseInt(clean.substr(i * 2, 2), 16);
        return new MiniBuffer(u8);
      }
      return new MiniBuffer(new TextEncoder().encode(input));
    }
    if (input instanceof ArrayBuffer) return new MiniBuffer(new Uint8Array(input));
    if (ArrayBuffer.isView(input)) {
      return new MiniBuffer(new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice());
    }
    if (Array.isArray(input)) return new MiniBuffer(input);
    return new MiniBuffer(new Uint8Array(input));
  }
  toString(enc) {
    if (enc === 'base64') return b64encode(this);
    if (enc === 'hex') {
      let s = '';
      for (let i = 0; i < this.length; i++) s += this[i].toString(16).padStart(2, '0');
      return s;
    }
    return new TextDecoder().decode(this);
  }
}

export function installGlobals() {
  if (typeof globalThis.Buffer === 'undefined') globalThis.Buffer = MiniBuffer;
  if (typeof globalThis.webcrypto === 'undefined' && globalThis.crypto) {
    globalThis.webcrypto = globalThis.crypto;
  }
}

export { b64encode, b64decode };

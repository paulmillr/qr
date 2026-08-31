/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Authenticated-encryption envelope helpers for QR payloads.
 * @module
 */

import type { DecodeOpts, Image } from './decode.ts';
import { decodeQR } from './decode.ts';
import type { Output, QrOpts, SvgQrOpts } from './index.ts';
import { encodeQR } from './index.ts';

/** Throws if `object` isn't a plain object; returns it otherwise. */
function validateObject<T>(object: T, title: string): T {
  if (object === null || typeof object !== 'object' || Array.isArray(object))
    throw new TypeError(`"${title}" expected object, got type=${typeof object}`);
  return object;
}

// Global symbols in both browsers and Node.js since v11.
// See https://github.com/microsoft/TypeScript/issues/31535
declare const TextEncoder: any;
declare const TextDecoder: any;

const MAGIC_0 = 0x51; // Q
const MAGIC_1 = 0x65; // e
const VERSION = 1;
const HEADER = /* @__PURE__ */ Uint8Array.from([MAGIC_0, MAGIC_1, VERSION]);
const HEADER_LENGTH = HEADER.length;
const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const OUTPUTS: readonly string[] = ['raw', 'ascii', 'term', 'gif', 'svg', 'data-url'];
const BASE64URL_VALUES = /* @__PURE__ */ (() => {
  const values = new Int16Array(128);
  values.fill(-1);
  for (let i = 0; i < BASE64URL.length; i++) values[BASE64URL.charCodeAt(i)] = i;
  return values;
})();
const noCipherMsg =
  'encrypted QR: no cipher configured — pass opts.encryption or call setCipher()';

export type AeadInstance = {
  encrypt(plaintext: Uint8Array): Uint8Array;
  decrypt(ciphertext: Uint8Array): Uint8Array;
};
export type AeadCipher = {
  (key: Uint8Array, nonce: Uint8Array, aad?: Uint8Array): AeadInstance;
  nonceLength: number;
  keyLength?: number;
};
export type QREncryption = { cipher: AeadCipher; key: Uint8Array };
export type EncryptedQrOpts = QrOpts & { encryption?: QREncryption };
export type DecryptedResult = { bytes: Uint8Array; text: () => string };

let defaultEncryption: QREncryption | undefined;
let utf8Decoder: any;

function validateBytes(bytes: unknown, title: string): Uint8Array {
  if (!(bytes instanceof Uint8Array))
    throw new TypeError(`"${title}" expected Uint8Array, got type=${typeof bytes}`);
  return bytes;
}

function validateEncryption(encryption: QREncryption): QREncryption {
  const opts = validateObject(encryption, 'encryption') as QREncryption;
  if (typeof opts.cipher !== 'function')
    throw new TypeError(`"encryption.cipher" expected function, got type=${typeof opts.cipher}`);
  const nonceLength = opts.cipher.nonceLength;
  if (!Number.isSafeInteger(nonceLength) || nonceLength < 8 || nonceLength > 32)
    throw new TypeError(
      `"encryption.cipher.nonceLength" expected integer in [8..32], got ${nonceLength}`
    );
  validateBytes(opts.key, 'encryption.key');
  const keyLength = opts.cipher.keyLength;
  if (keyLength !== undefined) {
    if (!Number.isSafeInteger(keyLength))
      throw new TypeError(`"encryption.cipher.keyLength" expected safe integer, got ${keyLength}`);
    if (opts.key.length !== keyLength)
      throw new TypeError(`"encryption.key" expected length=${keyLength}, got ${opts.key.length}`);
  }
  return opts;
}

function resolveEncryption(encryption?: QREncryption): QREncryption {
  const resolved = encryption !== undefined ? encryption : defaultEncryption;
  if (resolved === undefined) throw new Error(noCipherMsg);
  return validateEncryption(resolved);
}

function toBytes(data: string | Uint8Array): Uint8Array {
  if (typeof data === 'string') return new Uint8Array(new TextEncoder().encode(data));
  if (data instanceof Uint8Array) return data;
  throw new TypeError(`"data" expected string or Uint8Array, got type=${typeof data}`);
}

function randomBytes(length: number): Uint8Array {
  const crypto = (
    globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }
  ).crypto;
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function')
    throw new Error('encrypted QR: crypto.getRandomValues is unavailable');
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function aeadSeal(encryption: QREncryption, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const aead = encryption.cipher(encryption.key, nonce, HEADER);
  if (aead === null || typeof aead !== 'object' || typeof aead.encrypt !== 'function')
    throw new TypeError(`"encryption.cipher(...).encrypt" expected function`);
  const ciphertext = aead.encrypt(plaintext);
  return validateBytes(ciphertext, 'encryption.cipher(...).encrypt result');
}

function aeadOpen(
  encryption: QREncryption,
  nonce: Uint8Array,
  ciphertext: Uint8Array
): Uint8Array {
  const aead = encryption.cipher(encryption.key, nonce, HEADER);
  if (aead === null || typeof aead !== 'object' || typeof aead.decrypt !== 'function')
    throw new TypeError(`"encryption.cipher(...).decrypt" expected function`);
  let plaintext;
  try {
    plaintext = aead.decrypt(ciphertext);
  } catch (e) {
    throw new Error('encrypted QR: decryption failed');
  }
  return validateBytes(plaintext, 'encryption.cipher(...).decrypt result');
}

const base64url = {
  encode(bytes: Uint8Array): string {
    let out = '';
    let i = 0;
    for (; i + 2 < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out +=
        BASE64URL[n >>> 18] +
        BASE64URL[(n >>> 12) & 63] +
        BASE64URL[(n >>> 6) & 63] +
        BASE64URL[n & 63];
    }
    const left = bytes.length - i;
    if (left === 1) {
      const n = bytes[i] << 16;
      out += BASE64URL[n >>> 18] + BASE64URL[(n >>> 12) & 63];
    } else if (left === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += BASE64URL[n >>> 18] + BASE64URL[(n >>> 12) & 63] + BASE64URL[(n >>> 6) & 63];
    }
    return out;
  },

  decode(text: string): Uint8Array {
    if (typeof text !== 'string')
      throw new TypeError(`"envelope" expected string, got type=${typeof text}`);
    if (text.length % 4 === 1) throw new Error('encrypted QR: bad base64url envelope');
    const out = new Uint8Array((text.length * 3) >>> 2);
    let buffer = 0;
    let bits = 0;
    let pos = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      const value = c < BASE64URL_VALUES.length ? BASE64URL_VALUES[c] : -1;
      if (value === -1) throw new Error('encrypted QR: bad base64url envelope');
      buffer = (buffer << 6) | value;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[pos++] = (buffer >>> bits) & 0xff;
      }
    }
    if (pos !== out.length || base64url.encode(out) !== text)
      throw new Error('encrypted QR: bad base64url envelope');
    return out;
  },
};

function result(bytes: Uint8Array): DecryptedResult {
  let text: string | undefined;
  return {
    bytes,
    text: () => {
      if (text !== undefined) return text;
      // Match scure-base strict UTF-8: preserve an explicit BOM and reject malformed plaintext.
      const decoder =
        utf8Decoder || (utf8Decoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }));
      const decoded = decoder.decode(bytes) as string;
      text = decoded;
      return decoded;
    },
  };
}

/** Set a module-level default encryption used when opts.encryption is omitted. */
export function setCipher(encryption: QREncryption | null): void {
  if (encryption === null) {
    defaultEncryption = undefined;
    return;
  }
  defaultEncryption = validateEncryption(encryption);
}

/** Seal data into a binary AEAD envelope and return base64url without padding. */
export function sealEnvelope(data: string | Uint8Array, encryption?: QREncryption): string {
  const resolved = resolveEncryption(encryption);
  const nonce = randomBytes(resolved.cipher.nonceLength);
  const ciphertext = aeadSeal(resolved, nonce, toBytes(data));
  const envelope = new Uint8Array(HEADER_LENGTH + nonce.length + ciphertext.length);
  envelope.set(HEADER);
  envelope.set(nonce, HEADER_LENGTH);
  envelope.set(ciphertext, HEADER_LENGTH + nonce.length);
  return base64url.encode(envelope);
}

/** Open a base64url AEAD envelope and return decrypted bytes plus lazy UTF-8 text. */
export function openEnvelope(envelope: string, encryption?: QREncryption): DecryptedResult {
  const resolved = resolveEncryption(encryption);
  const bytes = base64url.decode(envelope);
  if (bytes.length < HEADER_LENGTH) throw new Error('encrypted QR: envelope too short');
  if (bytes[0] !== MAGIC_0 || bytes[1] !== MAGIC_1) throw new Error('encrypted QR: bad magic');
  if (bytes[2] !== VERSION) throw new Error(`encrypted QR: unsupported version ${bytes[2]}`);
  const start = HEADER_LENGTH;
  const end = start + resolved.cipher.nonceLength;
  if (bytes.length <= end) throw new Error('encrypted QR: envelope too short');
  const nonce = bytes.subarray(start, end);
  const ciphertext = bytes.subarray(end);
  return result(aeadOpen(resolved, nonce, ciphertext));
}

export function encodeEncryptedQR(
  data: string | Uint8Array,
  output: 'raw',
  opts?: EncryptedQrOpts
): boolean[][];
export function encodeEncryptedQR(
  data: string | Uint8Array,
  output: 'ascii' | 'term' | 'data-url',
  opts?: EncryptedQrOpts
): string;
export function encodeEncryptedQR(
  data: string | Uint8Array,
  output: 'svg',
  opts?: EncryptedQrOpts & SvgQrOpts
): string;
export function encodeEncryptedQR(
  data: string | Uint8Array,
  output: 'gif',
  opts?: EncryptedQrOpts
): Uint8Array<ArrayBuffer>;
export function encodeEncryptedQR(
  data: string | Uint8Array,
  output: Output = 'raw',
  opts: EncryptedQrOpts & SvgQrOpts = {}
) {
  const options = validateObject(opts, 'opts') as EncryptedQrOpts & SvgQrOpts;
  // Reject an invalid renderer before nonce generation or caller-provided cipher side effects.
  if (typeof output !== 'string') throw new Error(`invalid output=${output}`);
  if (!OUTPUTS.includes(output)) throw new Error(`Unknown output: ${output}`);
  const envelope = sealEnvelope(data, options.encryption);
  if (output === 'raw') return encodeQR(envelope, output, options);
  if (output === 'ascii' || output === 'term' || output === 'data-url')
    return encodeQR(envelope, output, options);
  if (output === 'svg') return encodeQR(envelope, output, options);
  if (output === 'gif') return encodeQR(envelope, output, options);
  return encodeQR(envelope, output, options);
}

/** Decode an encrypted QR image and return decrypted bytes plus lazy UTF-8 text. */
export function decodeEncryptedQR(
  img: Image,
  opts: DecodeOpts & { all?: false; encryption?: QREncryption } = {}
): DecryptedResult {
  const options = validateObject(opts, 'opts');
  // An encrypted envelope is one payload; decode-all arrays cannot be opened as one envelope.
  if (options.all) throw new TypeError(`invalid opts.all=${options.all} (${typeof options.all})`);
  return openEnvelope(decodeQR(img, options), options.encryption);
}

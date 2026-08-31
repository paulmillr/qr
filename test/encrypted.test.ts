import { should } from '@paulmillr/jsbt/test.js';
import { deepStrictEqual, throws } from 'node:assert';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { matrixToImage } from './utils.ts';
import {
  decodeEncryptedQR,
  encodeEncryptedQR,
  openEnvelope,
  sealEnvelope,
  setCipher,
  type AeadCipher,
  type QREncryption,
} from '../src/encrypted.ts';

const B64U = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NO_CIPHER = new Error(
  'encrypted QR: no cipher configured \u2014 pass opts.encryption or call setCipher()'
);

const key = (seed: number): Uint8Array =>
  Uint8Array.from({ length: 32 }, (_, i) => (seed + i * 17) & 255);
const encryption = (seed: number): QREncryption => ({ cipher: xchacha20poly1305, key: key(seed) });
const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

function b64url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const n = (bytes[i] << 16) | ((has1 ? bytes[i + 1] : 0) << 8) | (has2 ? bytes[i + 2] : 0);
    out += B64U[(n >>> 18) & 63] + B64U[(n >>> 12) & 63];
    if (has1) out += B64U[(n >>> 6) & 63];
    if (has2) out += B64U[n & 63];
  }
  return out;
}

function envelopeBytes(magic0: number, magic1: number, version: number, ciphertextLen = 1) {
  const bytes = new Uint8Array(3 + xchacha20poly1305.nonceLength + ciphertextLen);
  bytes[0] = magic0;
  bytes[1] = magic1;
  bytes[2] = version;
  return bytes;
}

function flipChar(s: string, pos: number): string {
  const next = s[pos] === 'A' ? 'B' : 'A';
  return s.slice(0, pos) + next + s.slice(pos + 1);
}

function qrImage(data: string | Uint8Array, enc: QREncryption) {
  const raw = encodeEncryptedQR(data, 'raw', { encryption: enc });
  return matrixToImage(raw, 4);
}

function throwsMessage(fn: () => unknown, ctor: new (...args: any[]) => Error, message: RegExp) {
  throws(fn, (e) => e instanceof ctor && message.test((e as Error).message));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function fakeTag(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, data: Uint8Array) {
  const tag = new Uint8Array(16);
  const mix = (bytes: Uint8Array, domain: number) => {
    for (let i = 0; i < bytes.length; i++) {
      const j = (i + domain) & 15;
      tag[j] = (tag[j] + bytes[i] + domain + i) & 255;
      tag[(j + 7) & 15] ^= (bytes[i] + domain) & 255;
    }
  };
  mix(key, 1);
  mix(nonce, 3);
  mix(aad, 5);
  mix(data, 7);
  return tag;
}

const fakeAead: AeadCipher = Object.assign(
  (fakeKey: Uint8Array, nonce: Uint8Array, aad: Uint8Array = new Uint8Array()) => ({
    encrypt(plaintext: Uint8Array) {
      const ciphertext = new Uint8Array(plaintext.length + 16);
      for (let i = 0; i < plaintext.length; i++)
        ciphertext[i] =
          plaintext[i] ^
          fakeKey[i % fakeKey.length] ^
          nonce[i % nonce.length] ^
          (aad.length ? aad[i % aad.length] : 0);
      ciphertext.set(
        fakeTag(fakeKey, nonce, aad, ciphertext.subarray(0, plaintext.length)),
        plaintext.length
      );
      return ciphertext;
    },
    decrypt(ciphertext: Uint8Array) {
      if (ciphertext.length < 16) throw new Error('fake AEAD: bad tag');
      const body = ciphertext.subarray(0, ciphertext.length - 16);
      const tag = ciphertext.subarray(ciphertext.length - 16);
      if (!bytesEqual(tag, fakeTag(fakeKey, nonce, aad, body)))
        throw new Error('fake AEAD: bad tag');
      const plaintext = new Uint8Array(body.length);
      for (let i = 0; i < body.length; i++)
        plaintext[i] =
          body[i] ^
          fakeKey[i % fakeKey.length] ^
          nonce[i % nonce.length] ^
          (aad.length ? aad[i % aad.length] : 0);
      return plaintext;
    },
  }),
  { nonceLength: 24, keyLength: 32 }
);

should('encrypted QR round-trips string data', () => {
  const enc = encryption(1);
  const text = 'hello encrypted QR \u{1f512}';
  const res = decodeEncryptedQR(qrImage(text, enc), { encryption: enc });
  deepStrictEqual(res.text(), text);
  deepStrictEqual(res.bytes, utf8(text));
});

should('encrypted string round-trip preserves a leading byte-order mark', () => {
  const text = '\uFEFFabc';
  const enc = encryption(13);
  const res = openEnvelope(sealEnvelope(text, enc), enc);
  deepStrictEqual(
    { bytes: Array.from(res.bytes), text: res.text() },
    { bytes: Array.from(utf8(text)), text }
  );
});

should('encrypted text decoding rejects malformed UTF-8', () => {
  const enc = encryption(14);
  const res = openEnvelope(sealEnvelope(Uint8Array.of(0xff), enc), enc);
  throws(() => res.text(), TypeError);
});

should('encrypted QR round-trips binary data', () => {
  const enc = encryption(2);
  const data = Uint8Array.from({ length: 256 }, (_, i) => i);
  const res = decodeEncryptedQR(qrImage(data, enc), { encryption: enc });
  deepStrictEqual(res.bytes, data);
});

should('encodeEncryptedQR rejects invalid output before invoking the cipher', () => {
  const calls = { factory: 0, encrypt: 0, decrypt: 0 };
  const cipher: AeadCipher = Object.assign(
    () => {
      calls.factory++;
      return {
        encrypt: (data: Uint8Array) => {
          calls.encrypt++;
          return new Uint8Array(data);
        },
        decrypt: (data: Uint8Array) => {
          calls.decrypt++;
          return new Uint8Array(data);
        },
      };
    },
    { nonceLength: 8, keyLength: 1 }
  );
  throws(
    () =>
      encodeEncryptedQR('x', 'bad' as never, { encryption: { cipher, key: Uint8Array.of(0) } }),
    new Error('Unknown output: bad')
  );
  deepStrictEqual(calls, { factory: 0, encrypt: 0, decrypt: 0 });
});

should('encrypted QR rejects decode-all mode', () => {
  const enc = encryption(2);
  throws(
    () =>
      decodeEncryptedQR(qrImage('single encrypted QR', enc), {
        all: true,
        encryption: enc,
      } as never),
    /invalid opts.all=true/
  );
});

should('encrypted QR rejects the wrong key', () => {
  const img = qrImage('wrong key check', encryption(3));
  throwsMessage(
    () => decodeEncryptedQR(img, { encryption: encryption(4) }),
    Error,
    /decryption failed/
  );
});

should('encrypted envelope rejects tampering', () => {
  const enc = encryption(5);
  const envelope = sealEnvelope('tamper detection', enc);
  throwsMessage(() => openEnvelope(flipChar(envelope, 40), enc), Error, /decryption failed/);
});

should('encrypted QR supports setCipher default', () => {
  const enc = encryption(6);
  try {
    setCipher(enc);
    const raw = encodeEncryptedQR('default cipher', 'raw');
    const img = matrixToImage(raw, 4);
    deepStrictEqual(decodeEncryptedQR(img).text(), 'default cipher');
    setCipher(null);
    throws(() => sealEnvelope('missing default'), NO_CIPHER);
  } finally {
    setCipher(null);
  }
});

should('encrypted QR per-call encryption overrides module default', () => {
  const defaultEnc = encryption(7);
  const overrideEnc = encryption(8);
  try {
    setCipher(defaultEnc);
    const raw = encodeEncryptedQR('override cipher', 'raw', { encryption: overrideEnc });
    const img = matrixToImage(raw, 4);
    throwsMessage(() => decodeEncryptedQR(img), Error, /decryption failed/);
    deepStrictEqual(decodeEncryptedQR(img, { encryption: overrideEnc }).text(), 'override cipher');
  } finally {
    setCipher(null);
  }
});

should('encrypted envelope helpers round-trip without QR images', () => {
  const enc = encryption(9);
  const data = 'envelope only';
  const a = sealEnvelope(data, enc);
  const b = sealEnvelope(data, enc);
  deepStrictEqual(/^[A-Za-z0-9_-]+$/.test(a), true);
  deepStrictEqual(a === b, false);
  deepStrictEqual(openEnvelope(a, enc).text(), data);
  deepStrictEqual(openEnvelope(b, enc).text(), data);
});

should('encrypted QR validates cipher configuration', () => {
  const missingNonceLength = (() => ({
    encrypt: (data: Uint8Array) => data,
    decrypt: (data: Uint8Array) => data,
  })) as never;
  throwsMessage(
    () => setCipher({ cipher: missingNonceLength, key: key(10) }),
    TypeError,
    /nonceLength/
  );
  throwsMessage(
    () => setCipher({ cipher: fakeAead, key: new Uint8Array(31) }),
    TypeError,
    /key.*32|32.*key/
  );
  throwsMessage(() => setCipher({ cipher: fakeAead, key: [] as never }), TypeError, /key/);
});

should('encrypted envelope reports distinct parse failure classes', () => {
  const enc = encryption(11);
  throwsMessage(() => openEnvelope('abcd*', enc), Error, /bad base64url/);
  throwsMessage(() => openEnvelope(b64url(envelopeBytes(0, 0x65, 1)), enc), Error, /bad magic/);
  throwsMessage(
    () => openEnvelope(b64url(envelopeBytes(0x51, 0x65, 2)), enc),
    Error,
    /unsupported version/
  );
  const tooShort = envelopeBytes(0x51, 0x65, 1);
  throwsMessage(
    () => openEnvelope(b64url(tooShort.subarray(0, tooShort.length - 2)), enc),
    Error,
    /envelope too short/
  );
});

should('encrypted envelope uses unique nonces', () => {
  const enc = encryption(12);
  const envelopes = new Set<string>();
  for (let i = 0; i < 100; i++) envelopes.add(sealEnvelope('nonce uniqueness', enc));
  deepStrictEqual(envelopes.size, 100);
});

should.runWhen(import.meta.url);

/*!
 * Copyright (c) 2023 Paul Miller (paulmillr.com)
 * SPDX-License-Identifier: MIT OR Apache-2.0
 */
/**
 * Minimal single-frame GIF reader producing the RGBA `Image` shape `decodeQR`
 * accepts. Handles GIF87a/89a, global and local color tables, full variable-width LZW
 * (code-width growth, the 4096-entry cap with deferred clear, the KwKwK
 * case), interlacing, extension-block skipping, and GCE transparency —
 * transparent pixels stay white, the QR quiet-zone color. First frame only;
 * later frames of an animation are ignored.
 * @module
 */
import type { Image } from '../../src/decode.ts';

/**
 * Decodes the first frame of a GIF into RGBA pixels.
 *
 * `scale` is an integer nearest-neighbor upscale factor. 1px-per-module
 * rasters — like this library's own `'gif'` output at the default
 * `scale: 1` — are too small for the QR decoder's run-length detection, so
 * pass 2+ when the source is a tiny clean raster rather than a photo:
 *
 * ```js
 * const text = decodeQR(decodeGIF(gifBytes, 4));
 * ```
 */
function decode(bytes: Uint8Array, scale: number, luma = false, output?: Uint8Array): Image {
  const b = bytes;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new Error('not a GIF');
  if (!Number.isSafeInteger(scale) || scale < 1 || scale > 1024)
    throw new RangeError(`invalid scale factor: ${scale}`);
  let p = 6;
  const u16 = () => b[p++] | (b[p++] << 8);
  const width = u16() * scale;
  const height = u16() * scale;
  const length = width * height;
  if (output && output.length !== length)
    throw new Error(`expected ${length} luma bytes, got ${output.length}`);
  const flags = b[p++];
  p += 2; // background color index, aspect ratio
  const readPalette = (bits: number) => {
    const pal = b.subarray(p, p + 3 * (2 << bits));
    p += pal.length;
    return pal;
  };
  const global = flags & 0x80 ? readPalette(flags & 7) : new Uint8Array(0);
  let transparent = -1;
  while (p < b.length) {
    const block = b[p++];
    if (block === 0x3b) break; // trailer
    if (block === 0x21) {
      // Extension: remember GCE transparency, skip everything else.
      if (b[p++] === 0xf9 && b[p + 1] & 1) transparent = b[p + 4];
      while (b[p] !== 0) p += b[p] + 1;
      p++;
      continue;
    }
    if (block !== 0x2c) throw new Error('unsupported GIF block');
    const left = u16();
    const top = u16();
    const w = u16();
    const h = u16();
    const iflags = b[p++];
    const pal = iflags & 0x80 ? readPalette(iflags & 7) : global;
    const minCode = b[p++];
    // LZW: codes start at minCode+1 bits; dictionary entries are
    // prefix-chain + suffix-byte pairs, emitted via an unwind stack. Reading
    // sub-blocks in place avoids concatenating the compressed stream.
    const clear = 1 << minCode;
    const prefix = new Uint16Array(4096);
    const suffix = new Uint8Array(4096);
    const stack = new Uint8Array(4097);
    let codeSize = minCode + 1;
    let next = clear + 2;
    let prev = -1;
    let first = 0;
    let acc = 0;
    let nbits = 0;
    let di = 0;
    let blockEnd = p;
    let ended = false;
    const nextByte = () => {
      if (p === blockEnd) {
        const size = b[p++];
        if (!size) {
          ended = true;
          return 0;
        }
        blockEnd = p + size;
      }
      return b[p++];
    };
    // Compose directly onto a white screen-sized canvas. Palette luma is
    // computed once per color, not once per repeated LZW output symbol.
    const data = luma ? output || new Uint8Array(length) : new Uint8Array(length * 4);
    data.fill(255);
    const light = luma ? new Uint8Array(pal.length / 3) : undefined;
    if (light)
      for (let i = 0; i < light.length; i++)
        light[i] = (pal[3 * i] + 2 * pal[3 * i + 1] + pal[3 * i + 2]) >>> 2;
    const starts = [0, 4, 2, 1];
    const steps = [8, 8, 4, 2];
    let x = 0;
    let pass = 0;
    let y = 0;
    const write = (idx: number) => {
      if (idx !== transparent) {
        for (let sy = 0; sy < scale; sy++) {
          let o = ((top + y) * scale + sy) * width + (left + x) * scale;
          if (!luma) o *= 4;
          for (let sx = 0; sx < scale; sx++) {
            if (luma) data[o++] = light![idx];
            else {
              data[o++] = pal[3 * idx];
              data[o++] = pal[3 * idx + 1];
              data[o++] = pal[3 * idx + 2];
              o++;
            }
          }
        }
      }
      if (++x !== w) return;
      x = 0;
      if (!(iflags & 0x40)) {
        y++;
        return;
      }
      y += steps[pass];
      while (y >= h && ++pass < 4) y = starts[pass];
    };
    while (di < w * h) {
      while (nbits < codeSize && !ended) {
        const value = nextByte();
        // A sub-block terminator is not an implicit zero byte for a partial code.
        if (ended) break;
        acc |= value << nbits;
        nbits += 8;
      }
      if (ended && nbits < codeSize) break; // truncated stream: keep what decoded
      const code = acc & ((1 << codeSize) - 1);
      acc >>= codeSize;
      nbits -= codeSize;
      if (code === clear) {
        codeSize = minCode + 1;
        next = clear + 2;
        prev = -1;
        continue;
      }
      if (code === clear + 1) break; // end of information
      let c = code;
      let sp = 0;
      if (c >= next) {
        // KwKwK: only `next` itself is valid — output prev + its first char.
        stack[sp++] = first;
        c = prev;
      }
      for (; c >= clear + 2; c = prefix[c]) stack[sp++] = suffix[c];
      stack[sp++] = first = c;
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev;
        suffix[next] = first;
        if (++next === 1 << codeSize && codeSize < 12) codeSize++;
      }
      prev = code;
      while (sp > 0 && di < w * h) {
        write(stack[--sp]);
        di++;
      }
    }
    return { width, height, data };
  }
  throw new Error('no image in GIF');
}

export function decodeGIF(bytes: Uint8Array, scale = 1): Image {
  return decode(bytes, scale);
}

/** Extracts first-frame luma directly from GIF LZW indices without materializing RGBA. */
export const decodeGIFLuma = (bytes: Uint8Array, data?: Uint8Array): Image =>
  decode(bytes, 1, true, data);

export default decodeGIF;

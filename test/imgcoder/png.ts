import * as P from 'micro-packed';

export { decodePNGLuma } from '../misc/png.ts';

// PNG starts with binary 0x89; a JS string would UTF-8 encode it as 0xc2, 0x89.
const Signature = P.magicBytes(Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10));

const Color = P.map(P.U8, {
  grayscale: 0,
  truecolor: 2,
  indexed: 3,
  'grayscale-alpha': 4,
  'truecolor-alpha': 6,
});

const Header = P.struct({
  width: P.U32BE,
  height: P.U32BE,
  bitDepth: P.U8,
  color: Color,
  compression: P.U8,
  filter: P.U8,
  interlace: P.U8,
});

type Chunk = { type: string; data: Uint8Array; crc: number };

const Chunk = P.wrap<Chunk>({
  encodeStream: (w, chunk) => {
    P.U32BE.encodeStream(w, chunk.data.length);
    P.string(4).encodeStream(w, chunk.type);
    w.bytes(chunk.data);
    P.U32BE.encodeStream(w, chunk.crc);
  },
  decodeStream: (r) => {
    const length = P.U32BE.decodeStream(r);
    const type = P.string(4).decodeStream(r);
    const data = r.bytes(length);
    const crc = P.U32BE.decodeStream(r);
    return { type, data, crc };
  },
});

type Header = P.UnwrapCoder<typeof Header>;
type PNG = {
  header: Header;
  palette?: Uint8Array;
  transparency?: Uint8Array;
  idat: Uint8Array[];
  chunks: Chunk[];
  luma: { kind: string; bits: number };
};

const lumaKind = (color: string) => {
  if (color === 'grayscale') return 'grayscale';
  if (color === 'grayscale-alpha') return 'grayscale-alpha';
  if (color === 'indexed') return 'indexed';
  return 'convert';
};

export const PNG = P.wrap<PNG>({
  encodeStream: (w, value) => {
    Signature.encodeStream(w, undefined);
    for (const chunk of value.chunks) Chunk.encodeStream(w, chunk);
  },
  decodeStream: (r) => {
    Signature.decodeStream(r);
    const chunks: Chunk[] = [];
    const idat: Uint8Array[] = [];
    let header: Header | undefined;
    let palette: Uint8Array | undefined;
    let transparency: Uint8Array | undefined;
    for (; !r.isEnd(); ) {
      const chunk = Chunk.decodeStream(r);
      chunks.push(chunk);
      if (chunk.type === 'IHDR') {
        if (header || chunks.length !== 1) throw r.err('expected one leading IHDR chunk');
        header = Header.decode(chunk.data);
      } else if (chunk.type === 'PLTE') palette = chunk.data;
      else if (chunk.type === 'tRNS') transparency = chunk.data;
      else if (chunk.type === 'IDAT') idat.push(chunk.data);
      else if (chunk.type === 'IEND' && !r.isEnd())
        throw r.err('expected IEND to be the last chunk');
    }
    if (!header) throw r.err('expected IHDR chunk');
    if (!chunks.length || chunks[chunks.length - 1].type !== 'IEND')
      throw r.err('expected trailing IEND chunk');
    return {
      header,
      palette,
      transparency,
      idat,
      chunks,
      luma: { kind: lumaKind(header.color), bits: header.bitDepth },
    };
  },
});

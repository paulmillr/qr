import * as P from 'micro-packed';

export { decodeJPEGLuma } from '../misc/jpg.ts';

const Quantization = P.wrap<Quantization[]>({
  encodeStream: (w, tables) => {
    for (const table of tables) {
      w.byte(((table.precision === 16 ? 1 : 0) << 4) | table.id);
      const coder = table.precision === 16 ? P.U16BE : P.U8;
      for (const value of table.values) coder.encodeStream(w, value);
    }
  },
  decodeStream: (r) => {
    const tables: Quantization[] = [];
    for (; !r.isEnd(); ) {
      const info = r.byte();
      const precision = info >>> 4;
      if (precision > 1) throw r.err(`expected 8-bit or 16-bit quantization, got ${precision}`);
      const coder = precision ? P.U16BE : P.U8;
      const values: number[] = [];
      for (let i = 0; i < 64; i++) values.push(coder.decodeStream(r));
      tables.push({ id: info & 15, precision: precision ? 16 : 8, values });
    }
    return tables;
  },
});

const Huffman = P.wrap<Huffman[]>({
  encodeStream: (w, tables) => {
    for (const table of tables) {
      w.byte(((table.class === 'ac' ? 1 : 0) << 4) | table.id);
      for (const count of table.counts) w.byte(count);
      for (const symbol of table.symbols) w.byte(symbol);
    }
  },
  decodeStream: (r) => {
    const tables: Huffman[] = [];
    for (; !r.isEnd(); ) {
      const info = r.byte();
      if (info >>> 4 > 1) throw r.err(`expected DC or AC Huffman class, got ${info >>> 4}`);
      const counts: number[] = [];
      let length = 0;
      for (let i = 0; i < 16; i++) {
        const count = r.byte();
        counts.push(count);
        length += count;
      }
      const symbols: number[] = [];
      for (let i = 0; i < length; i++) symbols.push(r.byte());
      tables.push({ class: info >>> 4 ? 'ac' : 'dc', id: info & 15, counts, symbols });
    }
    return tables;
  },
});

const Frame = P.struct({
  precision: P.U8,
  height: P.U16BE,
  width: P.U16BE,
  count: P.U8,
  components: P.array(
    'count',
    P.struct({
      id: P.U8,
      sampling: P.U8,
      quantization: P.U8,
    })
  ),
});

const Scan = P.struct({
  count: P.U8,
  components: P.array(
    'count',
    P.struct({
      id: P.U8,
      huffman: P.U8,
    })
  ),
  spectralStart: P.U8,
  spectralEnd: P.U8,
  successive: P.U8,
});

type Quantization = { id: number; precision: number; values: number[] };
type Huffman = { class: string; id: number; counts: number[]; symbols: number[] };
type Frame = {
  kind: string;
  precision: number;
  height: number;
  width: number;
  components: {
    id: number;
    horizontal: number;
    vertical: number;
    quantization: number;
  }[];
};
type Scan = {
  components: { id: number; dc: number; ac: number }[];
  spectralStart: number;
  spectralEnd: number;
  successiveHigh: number;
  successiveLow: number;
  entropy: Uint8Array;
};
type JPEG = {
  quantization: Quantization[];
  huffman: Huffman[];
  frames: Frame[];
  scans: Scan[];
  restartInterval?: number;
  metadata: { marker: number; data: Uint8Array }[];
  luma: { kind: string; component?: number };
};

const frames: Record<number, string> = {
  0xc0: 'baseline',
  0xc1: 'extended',
  0xc2: 'progressive',
  0xc3: 'lossless',
  0xc5: 'differential-sequential',
  0xc6: 'differential-progressive',
  0xc7: 'differential-lossless',
  0xc9: 'extended-arithmetic',
  0xca: 'progressive-arithmetic',
  0xcb: 'lossless-arithmetic',
  0xcd: 'differential-sequential-arithmetic',
  0xce: 'differential-progressive-arithmetic',
  0xcf: 'differential-lossless-arithmetic',
};

const marker = {
  read: (r: P.Reader) => {
    if (r.byte() !== 0xff) throw r.err('expected JPEG marker');
    let value = r.byte();
    for (; value === 0xff; ) value = r.byte();
    if (!value) throw r.err('unexpected stuffed marker outside entropy data');
    return value;
  },
  data: (r: P.Reader) => {
    const length = P.U16BE.decodeStream(r);
    if (length < 2) throw r.err(`expected JPEG segment length >= 2, got ${length}`);
    return r.bytes(length - 2);
  },
  entropy: (r: P.Reader) => {
    const bytes = r.bytes(r.leftBytes, true);
    for (let i = 0; i < bytes.length; ) {
      for (; i < bytes.length && bytes[i] !== 0xff; i++);
      if (i === bytes.length) break;
      let end = i + 1;
      for (; end < bytes.length && bytes[end] === 0xff; end++);
      if (end === bytes.length) break;
      const value = bytes[end];
      if (!value || (value >= 0xd0 && value <= 0xd7)) {
        i = end + 1;
        continue;
      }
      const entropy = r.bytes(i);
      r.bytes(end - i + 1);
      return { entropy, marker: value };
    }
    throw r.err('expected marker after JPEG entropy data');
  },
};

const frame = (kind: string, data: Uint8Array): Frame => {
  const value = Frame.decode(data);
  return {
    kind,
    precision: value.precision,
    height: value.height,
    width: value.width,
    components: value.components.map((component) => ({
      id: component.id,
      horizontal: component.sampling >>> 4,
      vertical: component.sampling & 15,
      quantization: component.quantization,
    })),
  };
};

const scan = (data: Uint8Array, entropy: Uint8Array): Scan => {
  const value = Scan.decode(data);
  return {
    components: value.components.map((component) => ({
      id: component.id,
      dc: component.huffman >>> 4,
      ac: component.huffman & 15,
    })),
    spectralStart: value.spectralStart,
    spectralEnd: value.spectralEnd,
    successiveHigh: value.successive >>> 4,
    successiveLow: value.successive & 15,
    entropy,
  };
};

const luma = (value: Frame | undefined) => {
  if (!value) return { kind: 'unknown' };
  if (value.components.length === 1)
    return { kind: 'grayscale', component: value.components[0].id };
  if (
    value.components.length === 3 &&
    value.components.every((component) => component.id >= 1 && component.id <= 3)
  )
    return { kind: 'ycbcr', component: 1 };
  return { kind: 'unknown' };
};

export const JPEG = P.wrap<JPEG>({
  // This preserves decoded internals, but not enough ordering to re-encode a JPEG.
  encodeStream: (w) => {
    throw w.err('JPEG structure is decode-only');
  },
  decodeStream: (r) => {
    P.magicBytes(Uint8Array.of(0xff, 0xd8)).decodeStream(r);
    const quantization: Quantization[] = [];
    const huffman: Huffman[] = [];
    const decodedFrames: Frame[] = [];
    const scans: Scan[] = [];
    const metadata: { marker: number; data: Uint8Array }[] = [];
    let restartInterval: number | undefined;
    let pending: number | undefined;
    let ended = false;
    for (; !ended; ) {
      const current = pending || marker.read(r);
      pending = undefined;
      if (current === 0xd9) {
        ended = true;
        continue;
      }
      if (current === 0x01 || (current >= 0xd0 && current <= 0xd7)) {
        metadata.push({ marker: current, data: new Uint8Array() });
        continue;
      }
      const data = marker.data(r);
      if (current === 0xdb) quantization.push(...Quantization.decode(data));
      else if (current === 0xc4) huffman.push(...Huffman.decode(data));
      else if (frames[current]) decodedFrames.push(frame(frames[current], data));
      else if (current === 0xdd) restartInterval = P.U16BE.decode(data);
      else if (current === 0xda) {
        const next = marker.entropy(r);
        scans.push(scan(data, next.entropy));
        pending = next.marker;
      } else metadata.push({ marker: current, data });
    }
    return {
      quantization,
      huffman,
      frames: decodedFrames,
      scans,
      restartInterval,
      metadata,
      luma: luma(decodedFrames[0]),
    };
  },
});

import * as P from 'micro-packed';

export { decodeGIFLuma } from '../misc/gif.ts';

const Screen = P.struct({
  width: P.U16LE,
  height: P.U16LE,
  globalPalette: P.bits(1),
  colorResolution: P.bits(3),
  sorted: P.bits(1),
  paletteSize: P.bits(3),
  background: P.U8,
  aspect: P.U8,
});

const Descriptor = P.struct({
  left: P.U16LE,
  top: P.U16LE,
  width: P.U16LE,
  height: P.U16LE,
  localPalette: P.bits(1),
  interlaced: P.bits(1),
  sorted: P.bits(1),
  reserved: P.bits(2),
  paletteSize: P.bits(3),
});

const Graphic = P.struct({
  reserved: P.bits(3),
  disposal: P.bits(3),
  userInput: P.bits(1),
  transparent: P.bits(1),
  delay: P.U16LE,
  transparentIndex: P.U8,
});

const SubBlocks = P.wrap<Uint8Array[]>({
  encodeStream: (w, blocks) => {
    for (const block of blocks) {
      if (!block.length || block.length > 255)
        throw w.err(`expected 1..255 byte block, got ${block.length}`);
      w.byte(block.length);
      w.bytes(block);
    }
    w.byte(0);
  },
  decodeStream: (r) => {
    const blocks: Uint8Array[] = [];
    for (;;) {
      const length = r.byte();
      if (!length) return blocks;
      blocks.push(r.bytes(length));
    }
  },
});

type Image = {
  type: 'image';
  left: number;
  top: number;
  width: number;
  height: number;
  interlaced: boolean;
  sorted: boolean;
  localPalette?: Uint8Array;
  lzwMinimumCodeSize: number;
  data: Uint8Array[];
};
type Graphic = {
  disposal: number;
  userInput: boolean;
  transparent: boolean;
  delay: number;
  transparentIndex: number;
};
type Extension = {
  type: 'extension';
  label: number;
  header?: Uint8Array;
  data: Uint8Array[];
  value?: Graphic;
};
type Block = Image | Extension;
type GIF = {
  version: string;
  screen: {
    width: number;
    height: number;
    colorResolution: number;
    sorted: boolean;
    background: number;
    aspect: number;
  };
  globalPalette?: Uint8Array;
  blocks: Block[];
  luma: { kind: 'indexed' };
};

const paletteBits = (palette: Uint8Array | undefined) => {
  if (!palette || palette.length % 3) throw new Error('expected an RGB palette');
  const colors = palette.length / 3;
  const bits = Math.log2(colors) - 1;
  if (!Number.isInteger(bits) || bits < 0 || bits > 7)
    throw new Error(`expected 2..256 power-of-two palette colors, got ${colors}`);
  return bits;
};

const extension = {
  encode: (w: P.Writer, block: Extension) => {
    w.byte(0x21);
    w.byte(block.label);
    if (block.value) {
      w.byte(4);
      Graphic.encodeStream(w, {
        reserved: 0,
        disposal: block.value.disposal,
        userInput: +block.value.userInput,
        transparent: +block.value.transparent,
        delay: block.value.delay,
        transparentIndex: block.value.transparentIndex,
      });
      w.byte(0);
      return;
    }
    if (block.header) {
      w.byte(block.header.length);
      w.bytes(block.header);
    }
    SubBlocks.encodeStream(w, block.data);
  },
  decode: (r: P.Reader, label: number): Extension => {
    if (label === 0xf9) {
      if (r.byte() !== 4) throw r.err('expected four-byte graphic control extension');
      const value = Graphic.decodeStream(r);
      if (value.reserved) throw r.err('expected zero graphic control reserved bits');
      if (r.byte() !== 0) throw r.err('expected graphic control terminator');
      return {
        type: 'extension',
        label,
        data: [],
        value: {
          disposal: value.disposal,
          userInput: !!value.userInput,
          transparent: !!value.transparent,
          delay: value.delay,
          transparentIndex: value.transparentIndex,
        },
      };
    }
    let header: Uint8Array | undefined;
    if (label === 0x01 || label === 0xff) header = r.bytes(r.byte());
    return { type: 'extension', label, header, data: SubBlocks.decodeStream(r) };
  },
};

const image = {
  encode: (w: P.Writer, block: Image) => {
    w.byte(0x2c);
    const bits = block.localPalette ? paletteBits(block.localPalette) : 0;
    Descriptor.encodeStream(w, {
      left: block.left,
      top: block.top,
      width: block.width,
      height: block.height,
      localPalette: +!!block.localPalette,
      interlaced: +block.interlaced,
      sorted: +block.sorted,
      reserved: 0,
      paletteSize: bits,
    });
    if (block.localPalette) w.bytes(block.localPalette);
    w.byte(block.lzwMinimumCodeSize);
    SubBlocks.encodeStream(w, block.data);
  },
  decode: (r: P.Reader): Image => {
    const value = Descriptor.decodeStream(r);
    if (value.reserved) throw r.err('expected zero image descriptor reserved bits');
    const localPalette = value.localPalette ? r.bytes(3 << (value.paletteSize + 1)) : undefined;
    return {
      type: 'image',
      left: value.left,
      top: value.top,
      width: value.width,
      height: value.height,
      interlaced: !!value.interlaced,
      sorted: !!value.sorted,
      localPalette,
      lzwMinimumCodeSize: r.byte(),
      data: SubBlocks.decodeStream(r),
    };
  },
};

export const GIF = P.wrap<GIF>({
  encodeStream: (w, value) => {
    P.magicBytes('GIF').encodeStream(w, undefined);
    P.string(3).encodeStream(w, value.version);
    const bits = value.globalPalette ? paletteBits(value.globalPalette) : 0;
    Screen.encodeStream(w, {
      width: value.screen.width,
      height: value.screen.height,
      globalPalette: +!!value.globalPalette,
      colorResolution: value.screen.colorResolution - 1,
      sorted: +value.screen.sorted,
      paletteSize: bits,
      background: value.screen.background,
      aspect: value.screen.aspect,
    });
    if (value.globalPalette) w.bytes(value.globalPalette);
    for (const block of value.blocks) {
      if (block.type === 'image') image.encode(w, block);
      else extension.encode(w, block);
    }
    w.byte(0x3b);
  },
  decodeStream: (r) => {
    P.magicBytes('GIF').decodeStream(r);
    const version = P.string(3).decodeStream(r);
    if (version !== '87a' && version !== '89a')
      throw r.err(`expected GIF87a or GIF89a, got GIF${version}`);
    const value = Screen.decodeStream(r);
    const globalPalette = value.globalPalette ? r.bytes(3 << (value.paletteSize + 1)) : undefined;
    const blocks: Block[] = [];
    for (;;) {
      const marker = r.byte();
      if (marker === 0x3b) break;
      if (marker === 0x2c) blocks.push(image.decode(r));
      else if (marker === 0x21) blocks.push(extension.decode(r, r.byte()));
      else throw r.err(`expected GIF block marker, got ${marker}`);
    }
    return {
      version,
      screen: {
        width: value.width,
        height: value.height,
        colorResolution: value.colorResolution + 1,
        sorted: !!value.sorted,
        background: value.background,
        aspect: value.aspect,
      },
      globalPalette,
      blocks,
      luma: { kind: 'indexed' },
    };
  },
});

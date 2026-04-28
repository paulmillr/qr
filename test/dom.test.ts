import { should } from '@paulmillr/jsbt/test.js';
import globalJsdom from 'global-jsdom';
import { deepStrictEqual } from 'node:assert';
import { getSize, QRCanvas, svgToPng, type QRCanvasOpts } from '../src/dom.ts';
import { encodeQR } from '../src/index.ts';

globalJsdom(undefined, { resources: 'usable' });

const textDecoderWithEci: Partial<QRCanvasOpts> = {
  textDecoder: (bytes, eci) => new TextDecoder().decode(bytes) + (eci?.toString() || ''),
};
const textDecoderWithoutEci: Partial<QRCanvasOpts> = {
  textDecoder: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
};
void textDecoderWithEci;
void textDecoderWithoutEci;

type PutImageCall = { imageData: FakeImageData; x: number; y: number };
type RectCall = [number, number, number, number];
class FakeImageData {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  constructor(data: Uint8ClampedArray, width: number, height: number) {
    this.data = data;
    this.width = width;
    this.height = height;
  }
}
class FakeContext {
  imageSmoothingEnabled = true;
  putImageDataCalls: PutImageCall[] = [];
  clearRectCalls: RectCall[] = [];
  fillRectCalls: RectCall[] = [];
  clearRect(x: number, y: number, width: number, height: number) {
    this.clearRectCalls.push([x, y, width, height]);
  }
  fillRect(x: number, y: number, width: number, height: number) {
    this.fillRectCalls.push([x, y, width, height]);
  }
  putImageData(imageData: FakeImageData, x: number, y: number) {
    this.putImageDataCalls.push({ imageData, x, y });
  }
}
class FakeCanvas {
  width = 0;
  height = 0;
  style = '';
  context = new FakeContext();
  getContext(kind: string) {
    return kind === '2d' ? this.context : undefined;
  }
}

should('getSize', () => {
  const body = document.querySelector('body');
  const elm = document.createElement('html');
  elm.style.width = '100px';
  elm.style.height = '200px';
  body.appendChild(elm);

  deepStrictEqual(getSize(elm), { width: 100, height: 200 });

  elm.remove();
});

should('QRCanvas.drawBitmap uses decode crop offset', () => {
  const prevImageData = globalThis.ImageData;
  const prevCreate = document.createElement.bind(document);
  const main = new FakeCanvas();
  document.createElement = (name: string) => (name === 'canvas' ? (main as any) : prevCreate(name));
  (globalThis as any).ImageData = FakeImageData;
  try {
    const bitmap = new FakeCanvas();
    bitmap.width = 641;
    bitmap.height = 480;
    const canvas = new QRCanvas({ bitmap: bitmap as any }, { cropToSquare: true }) as any;
    const img = { width: 480, height: 480, data: new Uint8Array(480 * 480 * 4).fill(7) };
    canvas.drawBitmap(img);
    deepStrictEqual(bitmap.context.putImageDataCalls, [
      {
        imageData: new FakeImageData(Uint8ClampedArray.from(img.data), 480, 480),
        x: 80,
        y: 0,
      },
    ]);
  } finally {
    document.createElement = prevCreate;
    globalThis.ImageData = prevImageData;
  }
});

should('QRCanvas.drawOverlay covers crop sidebars with odd remainders', () => {
  const prevCreate = document.createElement.bind(document);
  document.createElement = (name: string) =>
    name === 'canvas' ? (new FakeCanvas() as any) : prevCreate(name);
  try {
    const wide = new FakeCanvas();
    wide.width = 641;
    wide.height = 480;
    const wideCanvas = new QRCanvas({ overlay: wide as any }, { cropToSquare: true }) as any;
    wideCanvas.drawOverlay();
    deepStrictEqual(wide.context.clearRectCalls, [[80, 0, 480, 480]]);
    deepStrictEqual(wide.context.fillRectCalls, [
      [0, 0, 80, 480],
      [560, 0, 81, 480],
    ]);
    const tall = new FakeCanvas();
    tall.width = 480;
    tall.height = 641;
    const tallCanvas = new QRCanvas({ overlay: tall as any }, { cropToSquare: true }) as any;
    tallCanvas.drawOverlay();
    deepStrictEqual(tall.context.clearRectCalls, [[0, 80, 480, 480]]);
    deepStrictEqual(tall.context.fillRectCalls, [
      [0, 0, 480, 80],
      [0, 560, 480, 81],
    ]);
  } finally {
    document.createElement = prevCreate;
  }
});

should('svgToPng registers image handlers before assigning src', async () => {
  const prevDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const prevDOMParser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
  const prevXMLSerializer = Object.getOwnPropertyDescriptor(globalThis, 'XMLSerializer');
  const prevImage = Object.getOwnPropertyDescriptor(globalThis, 'Image');
  const svgElement = {
    firstChild: { nodeName: 'defs' },
    attrs: [] as [string, string][],
    inserted: undefined as unknown,
    setAttribute(name: string, value: string) {
      this.attrs.push([name, value]);
    },
    insertBefore(node: unknown, before: unknown) {
      this.inserted = { node, before };
    },
  };
  const rect = {
    attrs: [] as [string, string][],
    setAttribute(name: string, value: string) {
      this.attrs.push([name, value]);
    },
  };
  const doc = {
    documentElement: svgElement,
    createElementNS() {
      return rect;
    },
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext() {
      return { drawImage() {} };
    },
    toDataURL(type: string) {
      deepStrictEqual(type, 'image/png');
      return 'data:image/png;base64,AA==';
    },
  };
  class SyncImage {
    onload: (() => void) | undefined;
    set src(_value: string) {
      if (this.onload) this.onload();
    }
  }
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { createElement: () => canvas },
  });
  Object.defineProperty(globalThis, 'DOMParser', {
    configurable: true,
    value: class {
      parseFromString() {
        return doc;
      }
    },
  });
  Object.defineProperty(globalThis, 'XMLSerializer', {
    configurable: true,
    value: class {
      serializeToString() {
        return '<svg />';
      }
    },
  });
  Object.defineProperty(globalThis, 'Image', {
    configurable: true,
    value: SyncImage,
  });
  try {
    const res = await Promise.race([
      svgToPng('<svg xmlns="http://www.w3.org/2000/svg"/>', 8, 4).then(
        (value) => ({ state: 'resolved', value }),
        (error) => ({ state: 'rejected', error })
      ),
      new Promise((resolve) => setImmediate(() => resolve({ state: 'pending' }))),
    ]);
    deepStrictEqual(res, { state: 'resolved', value: 'data:image/png;base64,AA==' });
  } finally {
    if (prevDocument) Object.defineProperty(globalThis, 'document', prevDocument);
    if (prevDOMParser) Object.defineProperty(globalThis, 'DOMParser', prevDOMParser);
    if (prevXMLSerializer) Object.defineProperty(globalThis, 'XMLSerializer', prevXMLSerializer);
    if (prevImage) Object.defineProperty(globalThis, 'Image', prevImage);
  }
});

should('svgToPng', async () => {
  const svg = encodeQR('https://google.com/', 'svg');
  const size = 58; // Generated SVG viewport * 2
  const expected =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAADoAAAA6CAYAAADhu0ooAAAABm' +
    'JLR0QA/wD/AP+gvaeTAAABiElEQVRoge2awRLCMAhEjeP//3I9ccHZ2QUSdQp7axtJmlcIwa' +
    'zruq5HAz1/PYBvaV70bnr5G2utlCHv6t6OPbf76PrUePoSNanB2M84I8Tsot9nx2MaoiY0Q9' +
    'EZVn3y1HiGaFVs5pFvn9IQzYqthyyaniI7RE3V6MiIRaNwdjxDNOsrbN1E16rdrNoQXbsrDG' +
    'jXsqt9Vm2Iwv1oNpdlz/21mimp6y0aRxui0Eej0RN2EIyW1UpDe6JyzSiaw2Z9jNlF47L26H' +
    'd9iZqqhNBMo35YO9Se3TcNUZNKUvUVlSwjFM2g2hD9WEejtZ5snTbarvq8DVEadVE0ZBlSNH' +
    'dV20VjhmmIIqkkoz6djc5qlB6iJjZT6v6SidlH/alfTBuix2pG2Uynul4itSG6/QwDqwFFSe' +
    'yqYfUlaqqeGYhmPrv/WfcaoqZTM62uz1H746OnDEe/hKyvqpnYEK1K3c9WT5ih/ryGqKmaCk' +
    'f3r/7+rnEN0VNnGFT7u6qLpjZEt+9H/1VtiM6L3k1vLwCAogw5DNQAAAAASUVORK5CYII=';

  deepStrictEqual(await svgToPng(svg, size, size), expected);
});

should.runWhen(import.meta.url);

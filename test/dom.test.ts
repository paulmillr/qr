import { it } from '@paulmillr/jsbt/test.js';
import globalJsdom from 'global-jsdom';
import { deepStrictEqual } from 'node:assert';
import { createRequire } from 'node:module';
import { _QRScanner, type FinderPoints } from '../src/decode.ts';
import {
    frameLoop,
    getSize,
    QRCamera,
    QRCanvas,
    rearCamera,
    svgToPng,
    type QRCanvasOpts,
} from '../src/dom.ts';
import { encodeQR } from '../src/index.ts';
import { matrixToImage } from './utils.ts';

globalJsdom(undefined, { resources: 'usable' });

// The native `canvas` binding is unavailable when install scripts are blocked
// (CI runs `npm ci --ignore-scripts`; Bun and Deno block them by default).
// Without it jsdom cannot rasterize images, so Image `onload` never fires.
// Probed synchronously: top-level await makes Bun's test workers exit early.
const hasCanvas = (() => {
  try {
    createRequire(import.meta.url)('canvas');
    return true;
  } catch {
    return false;
  }
})();

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
  drawImageCalls: unknown[][] = [];
  moveToCalls: [number, number][] = [];
  lineToCalls: [number, number][] = [];
  quadraticCurveToCalls: [number, number, number, number][] = [];
  roundRectCalls: [number, number, number, number, number][] = [];
  fillRectStyles: string[] = [];
  fillStyles: string[] = [];
  strokes = 0;
  fills = 0;
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  clearRect(x: number, y: number, width: number, height: number) {
    this.clearRectCalls.push([x, y, width, height]);
  }
  fillRect(x: number, y: number, width: number, height: number) {
    this.fillRectCalls.push([x, y, width, height]);
    this.fillRectStyles.push(this.fillStyle);
  }
  drawImage(...args: unknown[]) {
    this.drawImageCalls.push(args);
  }
  beginPath() {}
  moveTo(x: number, y: number) {
    this.moveToCalls.push([x, y]);
  }
  lineTo(x: number, y: number) {
    this.lineToCalls.push([x, y]);
  }
  quadraticCurveTo(cpx: number, cpy: number, x: number, y: number) {
    this.quadraticCurveToCalls.push([cpx, cpy, x, y]);
  }
  roundRect(x: number, y: number, width: number, height: number, radius: number) {
    this.roundRectCalls.push([x, y, width, height, radius]);
  }
  stroke() {
    this.strokes++;
  }
  fill() {
    this.fills++;
    this.fillStyles.push(this.fillStyle);
  }
  closePath() {}
  getImageData(_x: number, _y: number, width: number, height: number) {
    return new FakeImageData(new Uint8ClampedArray(width * height * 4).fill(255), width, height);
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

const firstOutline = (context: FakeContext) => ({
  from: context.moveToCalls[1],
  through: context.lineToCalls.slice(3, 7),
  curves: context.quadraticCurveToCalls.slice(0, 4),
});

const videoFrameSource = (format: string, width: number, height: number, luma: Uint8Array) => {
  const packed = format === 'RGBA' || format === 'RGBX' || format === 'BGRA' || format === 'BGRX';
  const bits = format === 'I420P10' ? 10 : format === 'I420P12' ? 12 : 8;
  const bytes = packed ? 4 : bits === 8 ? 1 : 2;
  const offset = 5;
  const stride = width * bytes + 7;
  const data = new Uint8Array(offset + stride * height + 3).fill(19);
  for (let y = 0; y < height; y++) {
    let dst = offset + y * stride;
    for (let x = 0; x < width; x++) {
      const value = luma[y * width + x];
      if (packed) {
        const channel = value < 128 ? 60 : 130;
        data[dst] = channel;
        data[dst + 1] = channel;
        data[dst + 2] = channel;
        // Opposing alpha values would invert this deliberately low-contrast
        // symbol if the padding/alpha byte leaked into luma.
        data[dst + 3] = value < 128 ? 255 : 0;
      } else if (bits === 8) data[dst] = value;
      else {
        const sample = value << (bits - 8);
        data[dst] = sample & 255;
        data[dst + 1] = sample >>> 8;
      }
      dst += bytes;
    }
  }
  return { format, width, height, data, layout: { offset, stride }, luma };
};

it('getSize', () => {
  const body = document.querySelector('body');
  const elm = document.createElement('html');
  elm.style.width = '100px';
  elm.style.height = '200px';
  body.appendChild(elm);

  deepStrictEqual(getSize(elm), { width: 100, height: 200 });

  elm.remove();
});

it('frameLoop uses video callbacks with animation-frame fallback', () => {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const animation = new Map<number, FrameRequestCallback>();
  const video = new Map<number, VideoFrameRequestCallback>();
  const player = document.createElement('video');
  let animationId = 0;
  let videoId = 0;
  globalThis.requestAnimationFrame = (callback) => {
    animation.set(++animationId, callback);
    return animationId;
  };
  globalThis.cancelAnimationFrame = (handle) => animation.delete(handle);
  Object.defineProperties(player, {
    requestVideoFrameCallback: {
      configurable: true,
      value: (callback: VideoFrameRequestCallback) => {
        video.set(++videoId, callback);
        return videoId;
      },
    },
    cancelVideoFrameCallback: {
      configurable: true,
      value: (handle: number) => video.delete(handle),
    },
  });
  try {
    const calls: number[] = [];
    const cancelVideo = frameLoop((timestamp) => calls.push(timestamp), player);
    const firstVideo = video.entries().next().value;
    if (!firstVideo) throw new Error('expected video callback');
    video.delete(firstVideo[0]);
    firstVideo[1](10, {} as VideoFrameCallbackMetadata);
    cancelVideo();
    delete (player as { requestVideoFrameCallback?: unknown }).requestVideoFrameCallback;
    delete (player as { cancelVideoFrameCallback?: unknown }).cancelVideoFrameCallback;
    const cancelAnimation = frameLoop((timestamp) => calls.push(timestamp), player);
    const firstAnimation = animation.entries().next().value;
    if (!firstAnimation) throw new Error('expected animation callback fallback');
    animation.delete(firstAnimation[0]);
    firstAnimation[1](20);
    cancelAnimation();
    deepStrictEqual(
      { calls, video: [...video.keys()], animation: [...animation.keys()] },
      { calls: [10, 20], video: [], animation: [] }
    );
  } finally {
    if (previousRequest) globalThis.requestAnimationFrame = previousRequest;
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel;
    else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  }
});

it('frameLoop cancellation from its callback stops the loop', () => {
  const previousRequest = globalThis.requestAnimationFrame;
  const previousCancel = globalThis.cancelAnimationFrame;
  const scheduled = new Map<number, FrameRequestCallback>();
  let id = 0;
  globalThis.requestAnimationFrame = (callback) => {
    scheduled.set(++id, callback);
    return id;
  };
  globalThis.cancelAnimationFrame = (handle) => scheduled.delete(handle);
  try {
    let cancel = () => {};
    cancel = frameLoop(() => cancel());
    const first = scheduled.entries().next().value;
    if (!first) throw new Error('expected frameLoop to schedule its first frame');
    scheduled.delete(first[0]);
    first[1](0);
    deepStrictEqual([...scheduled.keys()], []);
  } finally {
    if (previousRequest) globalThis.requestAnimationFrame = previousRequest;
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    if (previousCancel) globalThis.cancelAnimationFrame = previousCancel;
    else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
  }
});

it(
  'concurrent setDevice keeps the latest request and stops the superseded stream',
  async () => {
    const previous = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
    const makeStream = (name: string) => {
      const track = {
        active: true,
        stop() {
          this.active = false;
        },
      };
      return { name, track, getTracks: () => [track] };
    };
    const initial = makeStream('initial');
    const a = makeStream('A');
    const b = makeStream('B');
    const pending = new Map<string, (stream: typeof a) => void>();
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: (opts: { video: { deviceId?: { exact: string } } }) => {
          const device = opts.video.deviceId?.exact;
          if (!device) return Promise.resolve(initial);
          return new Promise<typeof a>((resolve) => pending.set(device, resolve));
        },
        enumerateDevices: async () => [],
      },
    });
    const player = {
      srcObject: undefined as unknown,
      setAttribute() {},
      videoHeight: 0,
      videoWidth: 0,
    };
    let camera: QRCamera | undefined;
    try {
      camera = await rearCamera(player as never);
      const switchA = camera.setDevice('A');
      const switchB = camera.setDevice('B');
      pending.get('B')?.(b);
      await Promise.resolve();
      pending.get('A')?.(a);
      await Promise.all([switchA, switchB]);
      deepStrictEqual(
        {
          attached: (player.srcObject as typeof a).name,
          A: a.track.active,
          B: b.track.active,
        },
        { attached: 'B', A: false, B: true }
      );
    } finally {
      camera?.stop();
      if (previous) Object.defineProperty(navigator, 'mediaDevices', previous);
      else delete (navigator as { mediaDevices?: unknown }).mediaDevices;
    }
  }
);

it('QRCamera skips drawing while a video has no current frame yet', async () => {
  const previousCreate = document.createElement.bind(document);
  const player = previousCreate('video');
  Object.defineProperties(player, {
    readyState: { configurable: true, value: 0 },
    videoHeight: { configurable: true, value: 0 },
    videoWidth: { configurable: true, value: 0 },
  });
  // The readyState/videoWidth guard must return undefined before any canvas
  // draw; a real browser would throw InvalidStateError from drawImage here.
  let draws = 0;
  document.createElement = ((name: string) => {
    if (name !== 'canvas') return previousCreate(name);
    const canvas = new FakeCanvas();
    canvas.context.drawImage = () => {
      draws++;
    };
    return canvas as any;
  }) as typeof document.createElement;
  try {
    const camera = new QRCamera(player);
    const canvas = new QRCanvas();
    deepStrictEqual(
      { result: await camera.readFrame(canvas), draws },
      { result: undefined, draws: 0 }
    );
  } finally {
    document.createElement = previousCreate;
  }
});

it('QRCanvas decodes through its reusable _QRScanner', () => {
  const previousCreate = document.createElement.bind(document);
  const decode = _QRScanner.prototype.decode;
  const canvases: FakeCanvas[] = [];
  let calls = 0;
  document.createElement = ((name: string) => {
    if (name !== 'canvas') return previousCreate(name);
    const canvas = new FakeCanvas();
    canvases.push(canvas);
    return canvas as any;
  }) as typeof document.createElement;
  _QRScanner.prototype.decode = function () {
    calls++;
    return ['SCANNER'];
  };
  try {
    const canvas = new QRCanvas();
    deepStrictEqual(
      {
        results: [canvas.drawImage({} as CanvasImageSource, 4, 5), canvas.drawImage({}, 4, 5)],
        calls,
        canvases: canvases.length,
      },
      { results: ['SCANNER', 'SCANNER'], calls: 2, canvases: 1 }
    );
  } finally {
    _QRScanner.prototype.decode = decode;
    document.createElement = previousCreate;
  }
});

// Mock scanners advertise the real 4K capacity; contents are never read, so
// one shared plane avoids three ~59MB throwaway allocations.
const SHARED_SCANNER_LUMA = new Uint8Array(3840 * 3840 * 4);

it('QRCanvas accepts an internal reusable scanner constructor', () => {
  const previousCreate = document.createElement.bind(document);
  const calls: unknown[] = [];
  class Scanner {
    luma = SHARED_SCANNER_LUMA;
    constructor(opts: unknown) {
      calls.push(['constructor', opts]);
    }
    addImage(image: unknown, format: unknown) {
      calls.push(['addImage', image, format]);
    }
    processImage() {}
    decode(all = false) {
      calls.push(['decode', all]);
      return ['SCANNER'];
    }
    clean() {
      calls.push(['clean']);
    }
  }
  document.createElement = ((name: string) =>
    name === 'canvas'
      ? (new FakeCanvas() as any)
      : previousCreate(name)) as typeof document.createElement;
  try {
    const canvas = new QRCanvas({}, { effort: Infinity, timeLimit: Infinity }, Scanner);
    const result = canvas.drawImage({} as CanvasImageSource, 4, 5);
    canvas.clear();
    deepStrictEqual(
      {
        result,
        calls: calls.map((call) => {
          if (!Array.isArray(call) || call[0] !== 'constructor') return call;
          const opts = call[1] as {
            effort: number;
            maxSize: unknown;
            stride: number;
            timeLimit: number;
          };
          return [
            'constructor',
            {
              effort: opts.effort,
              maxSize: opts.maxSize,
              stride: opts.stride,
              timeLimit: opts.timeLimit,
            },
          ];
        }),
      },
      {
        result: 'SCANNER',
        calls: [
          [
            'constructor',
            {
              effort: Infinity,
              maxSize: { width: 3840, height: 3840 },
              stride: 4,
              timeLimit: Infinity,
            },
          ],
          ['addImage', new FakeImageData(new Uint8ClampedArray(64).fill(255), 4, 4), undefined],
          ['decode', false],
          ['clean'],
        ],
      }
    );
  } finally {
    document.createElement = previousCreate;
  }
});

it('QRCanvas routes optional async decoding through the reusable scanner', async () => {
  const previousCreate = document.createElement.bind(document);
  const calls: unknown[] = [];
  class Scanner {
    luma = SHARED_SCANNER_LUMA;
    constructor() {}
    addImage() {
      calls.push('addImage');
    }
    processImage() {}
    decode() {
      throw new Error('unexpected sync decode');
    }
    async decodeAsync(all = false) {
      calls.push(['decodeAsync', all]);
      return ['ASYNC CANVAS'];
    }
    clean() {}
  }
  document.createElement = ((name: string) =>
    name === 'canvas'
      ? (new FakeCanvas() as any)
      : previousCreate(name)) as typeof document.createElement;
  try {
    const canvas = new QRCanvas({}, { async: true }, Scanner);
    const result = await canvas.drawImage({} as CanvasImageSource, 4, 5);
    deepStrictEqual(
      { calls, result },
      {
        calls: ['addImage', ['decodeAsync', false]],
        result: 'ASYNC CANVAS',
      }
    );
  } finally {
    document.createElement = previousCreate;
  }
});

it('QRCanvas cleanup aborts its scheduler task before wiping the scanner', async () => {
  const previousCreate = document.createElement.bind(document);
  const host = globalThis as any;
  const previousScheduler = host.scheduler;
  const previousTaskController = host.TaskController;
  let signal: AbortSignal | undefined;
  let cleans = 0;
  class TaskController {
    private controller = new AbortController();
    signal = this.controller.signal;
    abort(reason?: unknown) {
      this.controller.abort(reason);
    }
  }
  host.TaskController = TaskController;
  host.scheduler = {
    postTask: (callback: () => Promise<unknown>, opts: { signal: AbortSignal }) =>
      new Promise((resolve, reject) => {
        signal = opts.signal;
        const abort = () => reject(opts.signal.reason);
        opts.signal.addEventListener('abort', abort, { once: true });
        void Promise.resolve(callback()).then(resolve, reject);
      }),
  };
  class Scanner {
    luma = SHARED_SCANNER_LUMA;
    constructor() {}
    addImage() {}
    processImage() {}
    decode() {
      throw new Error('unexpected sync decode');
    }
    decodeAsync() {
      return new Promise<(string | Error)[]>(() => {});
    }
    clean() {
      cleans++;
    }
  }
  document.createElement = ((name: string) =>
    name === 'canvas'
      ? (new FakeCanvas() as any)
      : previousCreate(name)) as typeof document.createElement;
  try {
    const canvas = new QRCanvas({}, { async: true }, Scanner) as any;
    const pending = canvas.drawImage({} as CanvasImageSource, 4, 5);
    canvas.reader.clean();
    const before = { aborted: signal?.aborted, cleans };
    await pending;
    deepStrictEqual({ before, after: cleans }, { before: { aborted: true, cleans: 0 }, after: 1 });
  } finally {
    document.createElement = previousCreate;
    if (previousScheduler === undefined) delete host.scheduler;
    else host.scheduler = previousScheduler;
    if (previousTaskController === undefined) delete host.TaskController;
    else host.TaskController = previousTaskController;
  }
});

it(
  'QRCamera crops and copies a requested VideoFrame format directly into scanner luma',
  async () => {
    const previousCreate = document.createElement.bind(document);
    const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
    const calls: unknown[] = [];
    let owned: Uint8Array;
    let rejectConverted = false;
    const copyOptions = (options: VideoFrameCopyToOptions) => ({
      ...options,
      layout: options.layout?.map(({ offset, stride }) => ({ offset, stride })),
      rect: options.rect ? { ...options.rect } : undefined,
    });
    class Scanner {
      luma = new Uint8Array(3840 * 4);
      constructor(opts: { stride?: number }) {
        owned = this.luma;
        calls.push(['constructor', opts.stride]);
      }
      addImage() {}
      processImage(size: unknown, format: unknown, layout: unknown) {
        calls.push(['processImage', size, format, layout]);
      }
      decode() {
        return ['DIRECT'];
      }
      clean() {}
    }
    document.createElement = ((name: string) =>
      name === 'canvas'
        ? (new FakeCanvas() as any)
        : previousCreate(name)) as typeof document.createElement;
    Object.defineProperty(globalThis, 'VideoFrame', {
      configurable: true,
      value: class {
        format = 'I420';
        displayWidth = 6;
        displayHeight = 4;
        visibleRect = { x: 0, y: 0, width: 6, height: 4 };
        allocationSize(options: VideoFrameCopyToOptions) {
          calls.push(['allocationSize', copyOptions(options)]);
          return 24;
        }
        async copyTo(destination: Uint8Array, options: VideoFrameCopyToOptions) {
          calls.push(['copyTo', destination === owned, copyOptions(options)]);
          if (rejectConverted && options.format) throw new Error('conversion unsupported');
          destination.fill(128, 0, 24);
          return options.layout || [];
        }
        close() {}
      },
    });
    try {
      const player = previousCreate('video');
      Object.defineProperties(player, {
        videoWidth: { configurable: true, value: 6 },
        videoHeight: { configurable: true, value: 4 },
      });
      const canvas = new QRCanvas({}, {}, Scanner);
      const camera = new QRCamera(player, { format: 'NV12' });
      deepStrictEqual(await camera.readFrame(canvas, true), 'DIRECT');
      const native = new QRCamera(player);
      deepStrictEqual(await native.readFrame(canvas, true), 'DIRECT');
      rejectConverted = true;
      const fallback = new QRCamera(player, { format: 'NV12' });
      deepStrictEqual(await fallback.readFrame(canvas, true), 'DIRECT');
      deepStrictEqual(await fallback.readFrame(canvas, true), 'DIRECT');
      deepStrictEqual(calls, [
        ['constructor', 4],
        [
          'allocationSize',
          {
            format: 'NV12',
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 4 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'copyTo',
          true,
          {
            format: 'NV12',
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 4 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        ['processImage', { width: 4, height: 4 }, 'NV12', { offset: 0, stride: 4 }],
        [
          'allocationSize',
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'copyTo',
          true,
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        ['processImage', { width: 4, height: 4 }, 'I420', { offset: 0, stride: 4 }],
        [
          'allocationSize',
          {
            format: 'NV12',
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 4 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'copyTo',
          true,
          {
            format: 'NV12',
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 4 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'allocationSize',
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'copyTo',
          true,
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        ['processImage', { width: 4, height: 4 }, 'I420', { offset: 0, stride: 4 }],
        [
          'allocationSize',
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        [
          'copyTo',
          true,
          {
            layout: [
              { offset: 0, stride: 4 },
              { offset: 16, stride: 2 },
              { offset: 20, stride: 2 },
            ],
            rect: { x: 0, y: 0, width: 4, height: 4 },
          },
        ],
        ['processImage', { width: 4, height: 4 }, 'I420', { offset: 0, stride: 4 }],
      ]);
    } finally {
      document.createElement = previousCreate;
      if (previousFrame) Object.defineProperty(globalThis, 'VideoFrame', previousFrame);
      else delete (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
    }
  }
);

it(
  'QRCanvas decodeAll accumulates successful overlays and optionally draws its terminal failure',
  () => {
    const previousCreate = document.createElement.bind(document);
    const failures = [new Error('finder'), new Error('timing'), new Error('data')];
    const batches = [['FIRST', 'SECOND', failures[0]], [failures[1]], ['THIRD', failures[2]]];
    const points = [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }, { id: 5 }, { id: 6 }];
    let point = 0;
    class Scanner {
      private opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void };
      constructor(opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void }) {
        this.opts = opts;
      }
      addImage() {}
      decode(all = false) {
        if (!all) throw new Error('expected decode-all flag');
        const batch = batches.shift() || [new Error('finder')];
        for (const result of batch) this.opts.pointsOnDetect?.(points[point++], result);
        return batch;
      }
      clean() {}
    }
    document.createElement = ((name: string) =>
      name === 'canvas'
        ? (new FakeCanvas() as any)
        : previousCreate(name)) as typeof document.createElement;
    try {
      const overlay = new FakeCanvas();
      const canvas = new QRCanvas(
        { overlay: overlay as any },
        { decodeAll: true },
        Scanner as never
      ) as any;
      const draws: unknown[] = [];
      canvas.drawOverlay = (value: unknown, append: boolean, failed: boolean) =>
        draws.push([value, append, failed]);
      const results = [
        canvas.drawImage({} as CanvasImageSource, 4, 5),
        canvas.drawImage({}, 4, 5),
      ];
      canvas.opts.drawFailed = true;
      results.push(canvas.drawImage({}, 4, 5));
      deepStrictEqual(
        {
          results: results.map((batch) =>
            batch?.map((result: string | Error) =>
              result instanceof Error ? result.message : result
            )
          ),
          draws,
        },
        {
          results: [['FIRST', 'SECOND', 'finder'], ['timing'], ['THIRD', 'data']],
          draws: [
            [{ id: 1 }, false, false],
            [{ id: 2 }, true, false],
            [{ id: 1 }, false, false],
            [{ id: 2 }, true, false],
            [{ id: 6 }, true, true],
          ],
        }
      );
    } finally {
      document.createElement = previousCreate;
    }
  }
);

it('QRCanvas stabilizes the complete decodeAll overlay set across frames', () => {
  const previousCreate = document.createElement.bind(document);
  const point = (id: string, x: number) => ({
    boundingBox: { height: 80, width: 80, x, y: 0 },
    id,
  });
  const a = point('a', 0);
  const a2 = point('a2', 2);
  const b = point('b', 400);
  const miss = new Error('finder');
  const frames = [
    [
      [a, 'A'],
      [b, 'B'],
    ],
    [
      [b, 'B'],
      [a2, 'A'],
    ],
    [],
    [],
    [],
    [[a, 'A']],
    [[a, 'A']],
    [[a, 'A']],
    [[a2, 'A']],
    [[b, 'B']],
  ] as const;
  class Scanner {
    private opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void };
    constructor(opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void }) {
      this.opts = opts;
    }
    addImage() {}
    decode(all = false) {
      if (!all) throw new Error('expected decode-all flag');
      const frame = frames.shift();
      if (!frame) throw new Error('expected overlay frame');
      const results: (string | Error)[] = [];
      for (const [points, result] of frame) {
        this.opts.pointsOnDetect?.(points, result);
        results.push(result);
      }
      this.opts.pointsOnDetect?.(point('miss', 800), miss);
      results.push(miss);
      return results;
    }
    clean() {}
  }
  document.createElement = ((name: string) =>
    name === 'canvas'
      ? (new FakeCanvas() as any)
      : previousCreate(name)) as typeof document.createElement;
  try {
    const canvas = new QRCanvas(
      { overlay: new FakeCanvas() as any },
      { decodeAll: true, overlayTimeout: 10_000 },
      Scanner as never
    ) as any;
    const draws: [string | undefined, boolean][] = [];
    canvas.drawOverlay = (points: { id: string } | undefined, append: boolean) =>
      draws.push([points?.id, append]);
    const results = Array.from({ length: 9 }, () => canvas.drawImage({}, 4, 5));
    canvas.lastDetect = 0;
    results.push(canvas.drawImage({}, 4, 5));
    canvas.clear();
    deepStrictEqual(
      {
        draws,
        results: results.map((batch) => batch?.filter((result) => typeof result === 'string')),
      },
      {
        draws: [
          ['a', false],
          ['b', true],
          ['a2', false],
          ['b', true],
          ['a', false],
          ['a2', false],
          ['b', false],
        ],
        results: [['A', 'B'], ['B', 'A'], [], [], [], ['A'], ['A'], ['A'], ['A'], ['B']],
      }
    );
  } finally {
    document.createElement = previousCreate;
  }
});

it('QRCanvas stabilizes single-result overlay identity across frames', async () => {
  const previousCreate = document.createElement.bind(document);
  const previousTimeout = globalThis.setTimeout;
  let timers = 0;
  let decoding = false;
  let timersDuringDecode = 0;
  globalThis.setTimeout = ((handler: TimerHandler, timeout?: number) => {
    timers++;
    if (decoding) timersDuringDecode++;
    return previousTimeout(handler, timeout);
  }) as typeof setTimeout;
  const point = (id: string, x: number) => ({
    boundingBox: { height: 80, width: 80, x, y: 0 },
    id,
  });
  const a = point('a', 0);
  const b = point('b', 400);
  const frames = [a, b, b, b, b, a, b];
  class Scanner {
    private opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void };
    constructor(opts: { pointsOnDetect?: (value: unknown, result: string | Error) => void }) {
      this.opts = opts;
    }
    addImage() {}
    decode(all = false) {
      if (all) throw new Error('unexpected decode-all flag');
      const points = frames.shift();
      if (!points) throw new Error('expected detection points');
      decoding = true;
      try {
        this.opts.pointsOnDetect?.(points, points.id);
        return [points.id];
      } finally {
        decoding = false;
      }
    }
    clean() {}
  }
  document.createElement = ((name: string) =>
    name === 'canvas'
      ? (new FakeCanvas() as any)
      : previousCreate(name)) as typeof document.createElement;
  try {
    const canvas = new QRCanvas(
      { overlay: new FakeCanvas() as any },
      { overlayTimeout: 10 },
      Scanner as never
    ) as any;
    const draws: string[] = [];
    canvas.drawOverlay = (points?: { id: string }) => draws.push(points?.id || 'clear');
    const results = Array.from({ length: 5 }, () => canvas.drawImage({}, 4, 5));
    canvas.clear();
    results.push(canvas.drawImage({}, 4, 5));
    canvas.lastDetect = 0;
    results.push(canvas.drawImage({}, 4, 5));
    const scheduledBeforeWait = timers;
    await new Promise((resolve) => previousTimeout(resolve, 30));
    deepStrictEqual(
      { draws, results, scheduledBeforeWait, timersDuringDecode },
      {
        draws: ['a', 'b', 'b', 'a', 'b', 'clear'],
        results: ['a', 'b', 'b', 'b', 'b', 'a', 'b'],
        scheduledBeforeWait: 2,
        timersDuringDecode: 0,
      }
    );
  } finally {
    globalThis.setTimeout = previousTimeout;
    document.createElement = previousCreate;
  }
});

it('QRCanvas.drawOverlay covers crop sidebars with odd remainders', () => {
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
    const portrait = new FakeCanvas();
    portrait.width = 1080;
    portrait.height = 1920;
    const rotated = new QRCanvas({ overlay: portrait as any }, { cropToSquare: true }) as any;
    rotated.rotate = true;
    rotated.sourceHeight = 1080;
    rotated.sourceX = 420;
    rotated.sourceY = 0;
    rotated.inputWidth = 1080;
    rotated.inputHeight = 1080;
    rotated.drawOverlay();
    deepStrictEqual(portrait.context.clearRectCalls, [[0, 420, 1080, 1080]]);
    deepStrictEqual(portrait.context.fillRectCalls, [
      [0, 0, 1080, 420],
      [0, 1500, 1080, 420],
    ]);
  } finally {
    document.createElement = prevCreate;
  }
});

it(
  'QRCanvas draws padded yellow bounds, green data, blue finders, and yellow aligners',
  () => {
    const prevCreate = document.createElement.bind(document);
    document.createElement = (name: string) =>
      name === 'canvas' ? (new FakeCanvas() as any) : prevCreate(name);
    try {
      const overlay = new FakeCanvas();
      overlay.width = overlay.height = 1920;
      const canvas = new QRCanvas({ overlay: overlay as any }) as any;
      const points = {
        tl: {
          x: 30,
          y: 30,
          moduleSize: 4,
          corners: [
            { x: 16, y: 16 },
            { x: 44, y: 16 },
            { x: 44, y: 44 },
            { x: 16, y: 44 },
          ],
        },
        tr: {
          x: 102,
          y: 30,
          moduleSize: 4,
          corners: [
            { x: 88, y: 16 },
            { x: 116, y: 16 },
            { x: 116, y: 44 },
            { x: 88, y: 44 },
          ],
        },
        br: { x: 102, y: 102 },
        bl: {
          x: 30,
          y: 102,
          moduleSize: 4,
          corners: [
            { x: 16, y: 88 },
            { x: 44, y: 88 },
            { x: 44, y: 116 },
            { x: 16, y: 116 },
          ],
        },
        aligners: [
          {
            x: 90,
            y: 90,
            moduleSize: 4,
            corners: [
              { x: 80, y: 80 },
              { x: 100, y: 80 },
              { x: 100, y: 100 },
              { x: 80, y: 100 },
            ],
          },
        ],
        bounds: [
          { x: 16, y: 16 },
          { x: 116, y: 16 },
          { x: 116, y: 116 },
          { x: 16, y: 116 },
        ],
        outline: [
          { x: 12, y: 12 },
          { x: 120, y: 12 },
          { x: 120, y: 120 },
          { x: 12, y: 120 },
        ],
        boundingBox: { x: 16, y: 16, width: 100, height: 100 },
      } satisfies FinderPoints;
      canvas.drawOverlay(points);
      deepStrictEqual(
        {
          rounded: overlay.context.roundRectCalls,
          curves: overlay.context.quadraticCurveToCalls,
          polygon: {
            from: overlay.context.moveToCalls,
            through: overlay.context.lineToCalls,
            colors: overlay.context.fillStyles,
          },
          stroke: {
            count: overlay.context.strokes,
            color: overlay.context.strokeStyle,
            width: overlay.context.lineWidth,
          },
          fills: overlay.context.fills,
          rects: overlay.context.fillRectCalls,
          colors: overlay.context.fillRectStyles,
        },
        {
          rounded: [],
          curves: [
            [120, 12, 120, 21],
            [120, 120, 111, 120],
            [12, 120, 12, 111],
            [12, 12, 21, 12],
          ],
          polygon: {
            from: [
              [30, 30],
              [21, 12],
              [16, 16],
              [88, 16],
              [16, 88],
              [80, 80],
            ],
            through: [
              [102, 30],
              [102, 102],
              [30, 102],
              [111, 12],
              [120, 111],
              [21, 120],
              [12, 21],
              [44, 16],
              [44, 44],
              [16, 44],
              [116, 16],
              [116, 44],
              [88, 44],
              [44, 88],
              [44, 116],
              [16, 116],
              [100, 80],
              [100, 100],
              [80, 100],
            ],
            colors: ['green', 'blue', 'blue', 'blue', 'yellow'],
          },
          stroke: { count: 1, color: 'yellow', width: 2 },
          fills: 5,
          rects: [],
          colors: [],
        }
      );
    } finally {
      document.createElement = prevCreate;
    }
  }
);

it('QRCanvas draws only a failed data region in red', () => {
  const prevCreate = document.createElement.bind(document);
  document.createElement = (name: string) =>
    name === 'canvas' ? (new FakeCanvas() as any) : prevCreate(name);
  try {
    const overlay = new FakeCanvas();
    const canvas = new QRCanvas({ overlay: overlay as any }) as any;
    const marker = (x: number, y: number) => ({
      x,
      y,
      moduleSize: 2,
      corners: [
        { x: x - 7, y: y - 7 },
        { x: x + 7, y: y - 7 },
        { x: x + 7, y: y + 7 },
        { x: x - 7, y: y + 7 },
      ],
    });
    const points = {
      tl: marker(20, 20),
      tr: marker(80, 20),
      br: { x: 80, y: 80 },
      bl: marker(20, 80),
      aligners: [marker(70, 70)],
      bounds: [
        { x: 10, y: 10 },
        { x: 90, y: 10 },
        { x: 90, y: 90 },
        { x: 10, y: 90 },
      ],
      outline: [
        { x: 8, y: 8 },
        { x: 92, y: 8 },
        { x: 92, y: 92 },
        { x: 8, y: 92 },
      ],
      boundingBox: { x: 10, y: 10, width: 80, height: 80 },
    } satisfies FinderPoints;
    canvas.drawOverlay(points, false, true);
    deepStrictEqual(overlay.context.fillStyles, ['red', 'blue', 'blue', 'blue', 'yellow']);
  } finally {
    document.createElement = prevCreate;
  }
});

it('QRCanvas draws decoder-projected marker corners under perspective', () => {
  const prevCreate = document.createElement.bind(document);
  document.createElement = (name: string) =>
    name === 'canvas' ? (new FakeCanvas() as any) : prevCreate(name);
  try {
    const overlay = new FakeCanvas();
    const canvas = new QRCanvas({ overlay: overlay as any }) as any;
    canvas.drawOverlay({
      tl: {
        x: 30,
        y: 30,
        moduleSize: 4,
        corners: [
          { x: 16, y: 16 },
          { x: 44, y: 16 },
          { x: 44, y: 44 },
          { x: 16, y: 44 },
        ],
      },
      tr: {
        x: 102,
        y: 30,
        moduleSize: 4,
        // Deliberately narrower than TL: perspective compresses this finder.
        corners: [
          { x: 94, y: 22 },
          { x: 110, y: 22 },
          { x: 110, y: 38 },
          { x: 94, y: 38 },
        ],
      },
      br: { x: 102, y: 174 },
      bl: {
        x: 30,
        y: 102,
        moduleSize: 4,
        corners: [
          { x: 18, y: 84 },
          { x: 42, y: 96 },
          { x: 42, y: 120 },
          { x: 18, y: 108 },
        ],
      },
      aligners: [],
      bounds: [
        { x: 16, y: 16 },
        { x: 116, y: 16 },
        { x: 110, y: 188 },
        { x: 12, y: 116 },
      ],
      outline: [
        { x: 12, y: 12 },
        { x: 120, y: 12 },
        { x: 114, y: 192 },
        { x: 8, y: 120 },
      ],
      boundingBox: { x: 16, y: 16, width: 100, height: 172 },
    } satisfies FinderPoints);
    // Engines differ in the last float bit (V8 vs JavaScriptCore); compare rounded.
    const round9 = (calls: number[][]) =>
      calls.map((call) => call.map((value) => Math.round(value * 1e9) / 1e9));
    deepStrictEqual(
      {
        from: overlay.context.moveToCalls,
        through: round9(overlay.context.lineToCalls),
        curves: round9(overlay.context.quadraticCurveToCalls),
        fills: overlay.context.fillStyles,
        rects: overlay.context.fillRectCalls,
      },
      {
        from: [
          [30, 30],
          [21, 12],
          [16, 16],
          [94, 22],
          [18, 84],
        ],
        through: [
          [102, 30],
          [102, 174],
          [30, 102],
          [111, 12],
          [114.299833472, 183.004995837],
          [15.444950221, 125.05694732],
          [11.666895055, 20.993833504],
          [44, 16],
          [44, 44],
          [16, 44],
          [110, 22],
          [110, 38],
          [94, 38],
          [42, 96],
          [42, 120],
          [18, 108],
        ],
        curves: [
          [120, 12, 119.700166528, 20.995004163],
          [114, 192, 106.555049779, 186.94305268],
          [8, 120, 8.333104945, 111.006166496],
          [12, 12, 21, 12],
        ],
        fills: ['green', 'blue', 'blue', 'blue'],
        rects: [],
      }
    );
  } finally {
    document.createElement = prevCreate;
  }
});

it('QRCanvas rotates only its optional bitmap presentation', () => {
  const previousCreate = document.createElement.bind(document);
  const previousImageData = Object.getOwnPropertyDescriptor(globalThis, 'ImageData');
  document.createElement = (name: string) =>
    name === 'canvas' ? (new FakeCanvas() as any) : previousCreate(name);
  Object.defineProperty(globalThis, 'ImageData', { configurable: true, value: FakeImageData });
  try {
    const bitmap = new FakeCanvas();
    const canvas = new QRCanvas({ bitmap: bitmap as any }) as any;
    canvas.rotate = true;
    canvas.drawBitmap({
      width: 2,
      height: 3,
      data: Uint8Array.of(
        1,
        1,
        1,
        255,
        2,
        2,
        2,
        255,
        3,
        3,
        3,
        255,
        4,
        4,
        4,
        255,
        5,
        5,
        5,
        255,
        6,
        6,
        6,
        255
      ),
    });
    deepStrictEqual(
      {
        width: bitmap.width,
        height: bitmap.height,
        calls: bitmap.context.putImageDataCalls,
      },
      {
        width: 3,
        height: 2,
        calls: [
          {
            imageData: new FakeImageData(
              Uint8ClampedArray.of(
                5,
                5,
                5,
                255,
                3,
                3,
                3,
                255,
                1,
                1,
                1,
                255,
                6,
                6,
                6,
                255,
                4,
                4,
                4,
                255,
                2,
                2,
                2,
                255
              ),
              3,
              2
            ),
            x: 0,
            y: 0,
          },
        ],
      }
    );
  } finally {
    document.createElement = previousCreate;
    if (previousImageData) Object.defineProperty(globalThis, 'ImageData', previousImageData);
    else delete (globalThis as { ImageData?: typeof ImageData }).ImageData;
  }
});

it('QRCamera decodes padded WebCodecs formats with reusable buffers', async () => {
  const previousCreate = document.createElement.bind(document);
  const previousMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  const canvases: FakeCanvas[] = [];
  const copies: Uint8Array[] = [];
  const reported: (VideoPixelFormat | null)[] = [];
  let source: ReturnType<typeof videoFrameSource>;
  let frames = 0;
  let closed = 0;
  let stopped = 0;
  let duringCopy: (() => void) | undefined;
  document.createElement = ((name: string) => {
    if (name !== 'canvas') return previousCreate(name);
    const canvas = new FakeCanvas();
    canvases.push(canvas);
    return canvas as any;
  }) as typeof document.createElement;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => stopped++ }] }),
    },
  });
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: class {
      format: VideoPixelFormat;
      displayWidth: number;
      displayHeight: number;
      visibleRect: DOMRectReadOnly;
      constructor() {
        frames++;
        this.format = source.format as VideoPixelFormat;
        this.displayWidth = source.width;
        this.displayHeight = source.height;
        this.visibleRect = {
          // copyTo() rebases a non-zero coded visible rectangle, so overlay
          // coordinates must not inherit this source-buffer offset.
          x: 11,
          y: 7,
          width: source.width,
          height: source.height,
        } as DOMRectReadOnly;
      }
      allocationSize(options: VideoFrameCopyToOptions) {
        const rect = options.rect || this.visibleRect;
        const layout = options.layout || [source.layout];
        const format = (options.format || source.format) as string;
        const packed = ['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(format);
        const bits = format === 'I420P10' ? 10 : format === 'I420P12' ? 12 : 8;
        const row = rect.width! * (packed ? 4 : bits === 8 ? 1 : 2);
        return Math.max(...layout.map((plane) => plane.offset + plane.stride * rect.height!), row);
      }
      async copyTo(destination: Uint8Array, options: VideoFrameCopyToOptions) {
        copies.push(destination);
        const rect = options.rect || this.visibleRect;
        const layout = options.layout || [source.layout];
        const format = (options.format || source.format) as string;
        const packed = ['RGBA', 'RGBX', 'BGRA', 'BGRX'].includes(format);
        const bits = format === 'I420P10' ? 10 : format === 'I420P12' ? 12 : 8;
        const width = rect.width!;
        const height = rect.height!;
        const sourceX = rect.x! - this.visibleRect.x;
        const sourceY = rect.y! - this.visibleRect.y;
        destination.fill(128, 0, this.allocationSize(options));
        for (let y = 0; y < height; y++) {
          let dst = layout[0].offset + y * layout[0].stride;
          for (let x = 0; x < width; x++) {
            const value = source.luma[(sourceY + y) * source.width + sourceX + x];
            if (packed) {
              const channel = value < 128 ? 60 : 130;
              destination[dst] = channel;
              destination[dst + 1] = channel;
              destination[dst + 2] = channel;
              destination[dst + 3] = 255;
              dst += 4;
            } else if (bits === 8) destination[dst++] = value;
            else {
              const sample = value << (bits - 8);
              destination[dst] = sample & 255;
              destination[dst + 1] = sample >>> 8;
              dst += 2;
            }
          }
        }
        await Promise.resolve();
        if (duringCopy) {
          const update = duringCopy;
          duringCopy = undefined;
          update();
        }
        return layout;
      }
      close() {
        closed++;
      }
    },
  });
  try {
    const payload = 'VIDEO FRAME';
    const border = 4;
    const scale = 4;
    const base = matrixToImage(
      encodeQR(payload, 'raw', { version: 1, ecc: 'low', border, mask: 0 }),
      scale
    );
    const pad = 18;
    const width = base.width + pad;
    const height = base.height;
    const offset = pad >> 1;
    const luma = new Uint8Array(width * height).fill(255);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < base.width; x++)
        luma[y * width + x + offset] = base.data[4 * (y * base.width + x)];
    const formats = [
      'I420',
      'I420A',
      'I422',
      'I444',
      'NV12',
      'I420P10',
      'I420P12',
      'RGBA',
      'RGBX',
      'BGRA',
      'BGRX',
    ];
    const actual = [];
    const inputs: string[] = [];
    let outline;
    for (const format of formats) {
      source = videoFrameSource(format, width, height, luma);
      const player = previousCreate('video');
      Object.defineProperties(player, {
        videoWidth: { configurable: true, value: width },
        videoHeight: { configurable: true, value: height },
      });
      const camera = await rearCamera(player);
      const overlay = new FakeCanvas();
      const canvas = new QRCanvas(
        { overlay: overlay as any },
        {
          cropToSquare: true,
          onVideoFrame: (frame) => reported.push(frame.format),
          onFrameSource: format === 'I420' ? (input) => inputs.push(input) : undefined,
        }
      );
      const copy = copies.length;
      const results = [await camera.readFrame(canvas, true), await camera.readFrame(canvas, true)];
      if (!outline) outline = firstOutline(overlay.context);
      const reused = copies[copy] === copies[copy + 1];
      camera.stop();
      actual.push({
        format,
        results,
        reused,
        zeroized: copies[copy]?.every((value) => value === 0),
      });
    }
    deepStrictEqual(
      actual,
      formats.map((format) => ({
        format,
        results: [payload, payload],
        reused: true,
        zeroized: true,
      }))
    );
    deepStrictEqual(
      {
        outline,
        frames,
        closed,
        stopped,
        reported,
        canvasDraws: canvases.flatMap((canvas) => canvas.context.drawImageCalls).length,
        inputs,
      },
      {
        outline: {
          from: [offset + 21, 12],
          through: [
            [offset + 95, 12],
            [offset + 104, 95],
            [offset + 21, 104],
            [offset + 12, 21],
          ],
          curves: [
            [offset + 104, 12, offset + 104, 21],
            [offset + 104, 104, offset + 95, 104],
            [offset + 12, 104, offset + 12, 95],
            [offset + 12, 12, offset + 21, 12],
          ],
        },
        frames: formats.length * 2,
        closed: formats.length * 2,
        stopped: formats.length,
        reported: formats,
        canvasDraws: 0,
        inputs: ['VideoFrame'],
      }
    );

    const before = {
      frames,
      closed,
      copies: copies.length,
      canvasDraws: canvases.flatMap((canvas) => canvas.context.drawImageCalls).length,
    };
    const portraitWidth = 120;
    const portraitHeight = 140;
    const portrait = new Uint8Array(portraitWidth * portraitHeight).fill(255);
    const portraitQr = matrixToImage(
      encodeQR(payload, 'raw', { version: 1, ecc: 'low', border, mask: 0 }),
      3
    );
    const qrX = 7;
    const qrY = 20;
    for (let y = 0; y < portraitQr.height; y++)
      for (let x = 0; x < portraitQr.width; x++)
        portrait[(y + qrY) * portraitWidth + x + qrX] =
          portraitQr.data[4 * (y * portraitQr.width + x)];
    const rawWidth = portraitHeight;
    const rawHeight = portraitWidth;
    const raw = new Uint8Array(rawWidth * rawHeight);
    // Browser NV12 is landscape even though the video presents these pixels clockwise in portrait.
    for (let y = 0; y < rawHeight; y++)
      for (let x = 0; x < rawWidth; x++)
        raw[y * rawWidth + x] = portrait[x * portraitWidth + rawHeight - 1 - y];
    source = videoFrameSource('NV12', rawWidth, rawHeight, raw);
    const player = previousCreate('video');
    Object.defineProperties(player, {
      // Unsupported presentation geometry below must exercise the ready canvas fallback.
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: portraitWidth },
      videoHeight: { configurable: true, value: portraitHeight },
    });
    const camera = await rearCamera(player);
    const overlay = new FakeCanvas();
    let reportedFrames = 0;
    const canvas = new QRCanvas(
      { overlay: overlay as any },
      { cropToSquare: true, onVideoFrame: () => reportedFrames++ }
    );
    const results = [await camera.readFrame(canvas, true), await camera.readFrame(canvas, true)];
    const rawCrop = new Uint8Array(rawHeight * rawHeight);
    const rawX = (rawWidth - rawHeight) >> 1;
    for (let y = 0; y < rawHeight; y++)
      rawCrop.set(
        raw.subarray(y * rawWidth + rawX, y * rawWidth + rawX + rawHeight),
        y * rawHeight
      );
    // Decoding is rotation-independent. Keep coded luma row-contiguous and
    // rotate only the few presentation coordinates used by the overlay.
    deepStrictEqual((canvas as any).scanner.luma.slice(0, rawCrop.length), rawCrop);
    const portraitSize = [overlay.width, overlay.height];
    duringCopy = () =>
      Object.defineProperties(player, {
        videoWidth: { configurable: true, value: rawWidth },
        videoHeight: { configurable: true, value: rawHeight },
      });
    results.push(await camera.readFrame(canvas, true));
    const staleSize = [overlay.width, overlay.height];
    results.push(await camera.readFrame(canvas, true));
    const changedSize = [overlay.width, overlay.height];
    Object.defineProperties(player, {
      videoWidth: { configurable: true, value: portraitWidth + 1 },
      videoHeight: { configurable: true, value: portraitHeight },
    });
    results.push(await camera.readFrame(canvas, true));
    const transientSize = [overlay.width, overlay.height];
    Object.defineProperties(player, {
      videoWidth: { configurable: true, value: rawWidth },
      videoHeight: { configurable: true, value: rawHeight },
    });
    results.push(await camera.readFrame(canvas, true));
    const landscapeSize = [overlay.width, overlay.height];
    Object.defineProperties(player, {
      videoWidth: { configurable: true, value: portraitWidth },
      videoHeight: { configurable: true, value: portraitHeight },
    });
    results.push(await camera.readFrame(canvas, true));
    camera.stop();
    deepStrictEqual(
      {
        results,
        frames: frames - before.frames,
        closed: closed - before.closed,
        copies: copies.length - before.copies,
        canvasDraws:
          canvases.flatMap((item) => item.context.drawImageCalls).length - before.canvasDraws,
        sizes: [
          portraitSize,
          staleSize,
          changedSize,
          transientSize,
          landscapeSize,
          [overlay.width, overlay.height],
        ],
        outline: firstOutline(overlay.context),
        reportedFrames,
      },
      {
        results: [payload, payload, undefined, payload, undefined, payload, payload],
        frames: 7,
        closed: 7,
        copies: 6,
        canvasDraws: 1,
        sizes: [
          [portraitWidth, portraitHeight],
          // Geometry changed during copyTo(), so stale scanner coordinates were not drawn.
          [portraitWidth, portraitHeight],
          [rawWidth, rawHeight],
          [portraitWidth + 1, portraitHeight],
          [rawWidth, rawHeight],
          [portraitWidth, portraitHeight],
        ],
        // These are the decoder-projected module boundaries after portrait
        // rotation, not an expansion of the integer finder bounding box.
        outline: {
          from: [24, 29],
          through: [
            [75, 29],
            [84, 89],
            [24, 98],
            [15, 38],
          ],
          curves: [
            [84, 29, 84, 38],
            [84, 98, 75, 98],
            [15, 98, 15, 89],
            [15, 29, 24, 29],
          ],
        },
        reportedFrames: 1,
      }
    );
    const videoDraws = canvases.flatMap((item) => item.context.drawImageCalls).length;
    const videoReader = new QRCamera(player);
    deepStrictEqual(
      {
        result: await videoReader.readFrame(canvas, true),
        canvasDraws: canvases.flatMap((item) => item.context.drawImageCalls).length - videoDraws,
        stopped,
      },
      { result: payload, canvasDraws: 0, stopped: formats.length + 1 }
    );
  } finally {
    document.createElement = previousCreate;
    if (previousMedia) Object.defineProperty(navigator, 'mediaDevices', previousMedia);
    else delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
    if (previousFrame) Object.defineProperty(globalThis, 'VideoFrame', previousFrame);
    else delete (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
  }
});

it('QRCamera caches VideoFrame failure until the camera source changes', async () => {
  const previousCreate = document.createElement.bind(document);
  const previousMedia = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  const previousFrame = Object.getOwnPropertyDescriptor(globalThis, 'VideoFrame');
  const canvases: FakeCanvas[] = [];
  let frames = 0;
  let copies = 0;
  let closed = 0;
  const stops = [0, 0];
  let streams = 0;
  const inputs: string[] = [];
  document.createElement = ((name: string) => {
    if (name !== 'canvas') return previousCreate(name);
    const canvas = new FakeCanvas();
    canvases.push(canvas);
    return canvas as any;
  }) as typeof document.createElement;
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        const stream = streams++;
        return { getTracks: () => [{ stop: () => stops[stream]++ }] };
      },
    },
  });
  Object.defineProperty(globalThis, 'VideoFrame', {
    configurable: true,
    value: class {
      format = 'I420';
      displayWidth = 4;
      displayHeight = 4;
      visibleRect = { x: 0, y: 0, width: 4, height: 4 };
      constructor() {
        frames++;
      }
      allocationSize() {
        return 24;
      }
      async copyTo() {
        copies++;
        throw new Error('copyTo unsupported');
      }
      close() {
        closed++;
      }
    },
  });
  try {
    const player = previousCreate('video');
    Object.defineProperties(player, {
      // This case exercises copyTo fallback; not-ready media is covered separately.
      readyState: { configurable: true, value: 2 },
      videoWidth: { configurable: true, value: 4 },
      videoHeight: { configurable: true, value: 4 },
    });
    const camera = await rearCamera(player);
    const canvas = new QRCanvas(
      {},
      { cropToSquare: true, onFrameSource: (input) => inputs.push(input) }
    );
    const results = [await camera.readFrame(canvas, true), await camera.readFrame(canvas, true)];
    await camera.setDevice('next');
    results.push(await camera.readFrame(canvas, true));
    camera.stop();
    deepStrictEqual(
      {
        results,
        frames,
        copies,
        closed,
        stops,
        canvasDraws: canvases.flatMap((value) => value.context.drawImageCalls).length,
        inputs,
      },
      {
        results: [undefined, undefined, undefined],
        frames: 2,
        copies: 2,
        closed: 2,
        stops: [1, 1],
        canvasDraws: 3,
        inputs: ['canvas'],
      }
    );
  } finally {
    document.createElement = previousCreate;
    if (previousMedia) Object.defineProperty(navigator, 'mediaDevices', previousMedia);
    else delete (navigator as { mediaDevices?: MediaDevices }).mediaDevices;
    if (previousFrame) Object.defineProperty(globalThis, 'VideoFrame', previousFrame);
    else delete (globalThis as { VideoFrame?: typeof VideoFrame }).VideoFrame;
  }
});

it('svgToPng registers image handlers before assigning src', async () => {
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

(hasCanvas ? it : it.skip)('svgToPng', async () => {
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

it.runWhen(import.meta.url);

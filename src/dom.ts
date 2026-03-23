/*!
Copyright (c) 2023 Paul Miller (paulmillr.com)
The library paulmillr-qr is dual-licensed under the Apache 2.0 OR MIT license.
You can select a license of your choice.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
/**
 * Optional DOM related utilities. Some utilities, useful to decode QR from camera:
 * - draw overlay: helps user to position QR code on camera
 * - draw bitmap: useful for debugging (what decoder sees)
 * - draw result: show scanned QR code
 * The code is fragile: it is easy to make subtle errors, which will break decoding.
 * @module
 */

import decodeQR, { type DecodeOpts, type FinderPoints } from './decode.ts';
import type { Image } from './index.ts';

/**
 * Read rendered element dimensions from computed CSS.
 * @param elm - Element whose computed width and height should be parsed.
 * @returns Pixel width and height parsed from computed styles.
 * @example
 * Read rendered element dimensions from computed CSS.
 * ```ts
 * import { getSize } from 'qr/dom.js';
 * const video = document.querySelector('video')!;
 * const { width, height } = getSize(video);
 * ```
 */
export const getSize = (
  elm: HTMLElement
): {
  width: number;
  height: number;
} => {
  const css = getComputedStyle(elm);
  const width = Math.floor(+css.width.split('px')[0]);
  const height = Math.floor(+css.height.split('px')[0]);
  return { width, height };
};

const setCanvasSize = (canvas: HTMLCanvasElement, height: number, width: number) => {
  // NOTE: setting canvas.width even to same size will clear & redraw it (flickering)
  if (canvas.height !== height) canvas.height = height;
  if (canvas.width !== width) canvas.width = width;
};

type CanvasWithContext = { canvas: HTMLCanvasElement; context: CanvasRenderingContext2D };
const getCanvasContext = (canvas: HTMLCanvasElement): CanvasWithContext => {
  const context = canvas.getContext('2d');
  if (context === null) throw new Error('Cannot get canvas context');
  return { canvas, context };
};

const clearCanvas = ({ canvas, context }: CanvasWithContext) => {
  context.clearRect(0, 0, canvas.width, canvas.height);
};

/** `QRCanvas` drawing and decode options. */
export type QRCanvasOpts = {
  /** Pixel scale used when painting the decoded QR preview. */
  resultBlockSize: number;
  /** Fill color for the detected QR quadrilateral. */
  overlayMainColor: string;
  /** Fill color for the detected finder patterns. */
  overlayFinderColor: string;
  /** Fill color for the cropped side bars around the preview. */
  overlaySideColor: string;
  /** Time in milliseconds to keep the overlay visible after the last detection. */
  overlayTimeout: number;
  /** Crop incoming frames to a centered square before decoding. */
  cropToSquare: boolean;
  /**
   * Custom byte-to-text decoder used for byte segments.
   * @param bytes - Byte segment to decode.
   * @returns Decoded text.
   */
  textDecoder?: (bytes: Uint8Array) => string;
};

/** Optional output canvases used by `QRCanvas`. */
export type QRCanvasElements = {
  /** Canvas used to draw the overlay polygon and finder boxes. */
  overlay?: HTMLCanvasElement;
  /** Canvas used to show the bitmap fed into the decoder. */
  bitmap?: HTMLCanvasElement;
  /** Canvas used to show the successfully decoded QR image. */
  resultQR?: HTMLCanvasElement;
};
/**
 * Handles canvases for QR code decoding.
 * @param elements - Optional output canvases used for overlays and previews. See {@link QRCanvasElements}.
 * @param opts - Drawing and decode options for the helper canvases. See {@link QRCanvasOpts}.
 * @example
 * Create a `QRCanvas` that paints overlay highlights onto a DOM canvas.
 * ```ts
 * import { QRCanvas } from 'qr/dom.js';
 * const overlay = document.createElement('canvas');
 * const canvas = new QRCanvas({ overlay });
 * ```
 */
export class QRCanvas {
  private opts: QRCanvasOpts;
  private lastDetect = 0;
  private main: CanvasWithContext;
  private overlay?: CanvasWithContext;
  private bitmap?: CanvasWithContext;
  private resultQR?: CanvasWithContext;

  constructor(elements: QRCanvasElements = {}, opts: Partial<QRCanvasOpts> = {}) {
    const { overlay, bitmap, resultQR } = elements;
    this.opts = {
      resultBlockSize: 8,
      overlayMainColor: 'green',
      overlayFinderColor: 'blue',
      overlaySideColor: 'black',
      overlayTimeout: 500,
      cropToSquare: true,
      ...opts,
    };
    // TODO: check https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas
    this.main = getCanvasContext(document.createElement('canvas'));
    if (overlay) this.overlay = getCanvasContext(overlay);
    if (bitmap) this.bitmap = getCanvasContext(bitmap);
    if (resultQR) {
      this.resultQR = getCanvasContext(resultQR);
      this.resultQR.context.imageSmoothingEnabled = false;
    }
  }
  private setSize(height: number, width: number) {
    setCanvasSize(this.main.canvas, height, width);
    if (this.overlay) setCanvasSize(this.overlay.canvas, height, width);
    if (this.bitmap) setCanvasSize(this.bitmap.canvas, height, width);
  }
  private drawBitmap({ data, height, width }: Image) {
    if (!this.bitmap) return;
    const imgData = new ImageData(Uint8ClampedArray.from(data), width, height);
    let offset = { x: 0, y: 0 };
    if (this.opts.cropToSquare) {
      offset = {
        x: Math.ceil((this.bitmap.canvas.width - width) / 2),
        y: Math.ceil((this.bitmap.canvas.height - height) / 2),
      };
    }
    this.bitmap.context.putImageData(imgData, offset.x, offset.y);
  }
  private drawResultQr({ data, height, width }: Image) {
    if (!this.resultQR) return;
    const blockSize = this.opts.resultBlockSize;
    setCanvasSize(this.resultQR.canvas, height, width);
    const imgData = new ImageData(Uint8ClampedArray.from(data), width, height);
    this.resultQR.context.putImageData(imgData, 0, 0);
    (this.resultQR.canvas as any).style = `image-rendering: pixelated; width: ${
      blockSize * width
    }px; height: ${blockSize * height}px`;
  }
  private drawOverlay(points?: FinderPoints) {
    if (!this.overlay) return;
    const ctx = this.overlay.context;
    const height = this.overlay.canvas.height;
    const width = this.overlay.canvas.width;
    // Sides
    if (this.opts.cropToSquare && height !== width) {
      const squareSize = Math.min(height, width);
      const offset = {
        x: Math.floor((width - squareSize) / 2),
        y: Math.floor((height - squareSize) / 2),
      };
      // Clear only central part (flickering)
      ctx.clearRect(offset.x, offset.y, squareSize, squareSize);
      ctx.fillStyle = this.opts.overlaySideColor;
      if (width > height) {
        ctx.fillRect(0, 0, offset.x, height); // left
        ctx.fillRect(width - offset.x, 0, offset.x, height); // right
      } else if (height > width) {
        ctx.fillRect(0, 0, width, offset.y); // top
        ctx.fillRect(0, height - offset.y, width, offset.y); // bottom
      }
    } else {
      ctx.clearRect(0, 0, width, height);
    }
    if (points) {
      const [tl, tr, br, bl] = points;
      // Main area
      ctx.fillStyle = this.opts.overlayMainColor;
      ctx.beginPath();
      ctx.moveTo(tl.x, tl.y);
      ctx.lineTo(tr.x, tr.y);
      ctx.lineTo(br.x, br.y);
      ctx.lineTo(bl.x, bl.y);
      ctx.fill();

      ctx.closePath();
      // Finders
      ctx.fillStyle = this.opts.overlayFinderColor;
      for (const p of points) {
        if (!('moduleSize' in p)) continue;
        const x = p.x - 3 * p.moduleSize;
        const y = p.y - 3 * p.moduleSize;
        const size = 7 * p.moduleSize;
        ctx.fillRect(x, y, size, size);
      }
    }
  }
  drawImage(image: CanvasImageSource, height: number, width: number): string | undefined {
    this.setSize(height, width);
    const { context } = this.main;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    const options: DecodeOpts = {
      cropToSquare: this.opts.cropToSquare,
      textDecoder: this.opts.textDecoder,
    };
    if (this.bitmap) options.imageOnBitmap = (img) => this.drawBitmap(img);
    if (this.overlay) options.pointsOnDetect = (points) => this.drawOverlay(points);
    if (this.resultQR) options.imageOnResult = (img) => this.drawResultQr(img);
    try {
      const res = decodeQR(data, options);
      this.lastDetect = Date.now();
      return res;
    } catch (e) {
      if (this.overlay && Date.now() - this.lastDetect > this.opts.overlayTimeout)
        this.drawOverlay();
    }
    return;
  }
  clear(): void {
    clearCanvas(this.main);
    if (this.overlay) clearCanvas(this.overlay);
    if (this.bitmap) clearCanvas(this.bitmap);
    if (this.resultQR) clearCanvas(this.resultQR);
  }
}

class QRCamera {
  private stream: MediaStream;
  private player: HTMLVideoElement;
  constructor(stream: MediaStream, player: HTMLVideoElement) {
    this.stream = stream;
    this.player = player;
    this.setStream(stream);
  }
  private setStream(stream: MediaStream) {
    this.stream = stream;
    const { player } = this;
    player.setAttribute('autoplay', '');
    player.setAttribute('muted', '');
    player.setAttribute('playsinline', '');
    player.srcObject = stream;
  }
  /**
   * Returns list of cameras
   * NOTE: available only after first getUserMedia request, so cannot be additional method
   */
  async listDevices(): Promise<
    {
      deviceId: string;
      label: string;
    }[]
  > {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices)
      throw new Error('Media Devices not supported');
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'videoinput')
      .map((i) => ({
        deviceId: i.deviceId,
        label: i.label || `Camera ${i.deviceId}`,
      }));
  }
  /**
   * Change stream to different camera
   * @param deviceId - devideId from '.listDevices'
   */
  async setDevice(deviceId: string): Promise<void> {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    });
    this.setStream(stream);
  }
  readFrame(canvas: QRCanvas, fullSize = false): string | undefined {
    const { player } = this;
    if (fullSize) return canvas.drawImage(player, player.videoHeight, player.videoWidth);
    const size = getSize(player);
    return canvas.drawImage(player, size.height, size.width);
  }
  stop(): void {
    for (const track of this.stream.getTracks()) track.stop();
  }
}
/**
 * Creates new QRCamera from frontal camera
 * @param player - HTML Video element
 * @returns Camera wrapper backed by the selected media stream.
 * @example
 * Create a camera helper and read frames into a `QRCanvas`.
 * ```ts
 * import { QRCanvas, frontalCamera } from 'qr/dom.js';
 * const player = document.querySelector('video')!;
 * const canvas = new QRCanvas();
 * const camera = await frontalCamera(player);
 * camera.readFrame(canvas);
 * camera.stop();
 * ```
 */
export async function frontalCamera(player: HTMLVideoElement): Promise<QRCamera> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      // Ask for screen resolution
      height: { ideal: window.screen.height },
      width: { ideal: window.screen.width },
      // prefer front-facing camera, but can use any other
      // NOTE: 'exact' will cause OverConstrained error if no frontal camera available
      facingMode: 'environment',
    },
  });
  return new QRCamera(stream, player);
}

/**
 * Run callback in a loop with requestAnimationFrame.
 * @param cb - Callback invoked for each requested animation frame.
 * @returns Canceller that stops the scheduled loop.
 * @example
 * Run a callback on every animation frame until cancelled.
 * ```ts
 * import { frameLoop } from 'qr/dom.js';
 * const cancel = frameLoop(() => {
 *   document.body.dataset.frame = '1';
 * });
 * cancel();
 * ```
 */
export function frameLoop(cb: FrameRequestCallback): () => void {
  let handle: number | undefined = undefined;
  function loop(ts: number) {
    cb(ts);
    handle = requestAnimationFrame(loop);
  }
  handle = requestAnimationFrame(loop);
  return (): void => {
    if (handle === undefined) return;
    cancelAnimationFrame(handle);
    handle = undefined;
  };
}

/**
 * Convert an SVG string into a PNG data URL in browser environments.
 * @param svgData - SVG markup to rasterize.
 * @param width - Output PNG width in pixels.
 * @param height - Output PNG height in pixels.
 * @returns Promise that resolves to a PNG `data:` URL.
 * @example
 * Convert an SVG string into a PNG data URL in browser environments.
 * ```ts
 * import { svgToPng } from 'qr/dom.js';
 * const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>';
 * const pngUrl = await svgToPng(svg, 256, 256);
 * ```
 */
export function svgToPng(svgData: string, width: number, height: number): Promise<string> {
  return new Promise((resolve, reject) => {
    if (
      !(
        Number.isSafeInteger(width) &&
        Number.isSafeInteger(height) &&
        width > 0 &&
        height > 0 &&
        width < 8192 &&
        height < 8192
      )
    )
      return reject(new Error('invalid width and height: ' + width + ' ' + height));
    const domparser = new DOMParser();
    const doc = domparser.parseFromString(svgData, 'image/svg+xml');

    const svgElement = doc.documentElement;
    svgElement.setAttribute('width', String(width));
    svgElement.setAttribute('height', String(height));
    const rect = doc.createElementNS('http://www.w3.org/2000/svg', 'rect');

    rect.setAttribute('width', '100%');
    rect.setAttribute('height', '100%');
    rect.setAttribute('fill', 'white');
    svgElement.insertBefore(rect, svgElement.firstChild);

    const serializer = new XMLSerializer();
    const source = serializer.serializeToString(doc);

    const img = new Image();
    img.src = 'data:image/svg+xml,' + encodeURIComponent(source);
    img.onload = function () {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) return reject(new Error('was not able to create 2d context'));
      ctx.drawImage(img, 0, 0, width, height);
      const dataUrl = canvas.toDataURL('image/png');
      resolve(dataUrl);
    };
    img.onerror = reject;
  });
}

/**
 * Convert GIF bytes into a PNG blob in browser environments.
 * @param gifBytes - GIF file contents.
 * @returns Promise that resolves to a PNG blob.
 * @throws If the browser cannot create an image bitmap or rendering context for the GIF. {@link Error}
 * @example
 * Convert GIF bytes into a PNG blob in browser environments.
 * ```ts
 * import { gifToPng } from 'qr/dom.js';
 * const gif = new Uint8Array(await (await fetch('/qr.gif')).arrayBuffer());
 * const png = await gifToPng(gif);
 * ```
 */
export async function gifToPng(gifBytes: Uint8Array): Promise<Blob> {
  const blob = new Blob([gifBytes as BufferSource], { type: 'image/gif' });
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('bitmaprenderer', { alpha: false });
    if (!ctx) throw new Error('was not able to create bitmaprenderer context');
    ctx.transferFromImageBitmap(bitmap);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    bitmap.close();
  }
}

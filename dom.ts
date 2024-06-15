/*
Optional DOM related utilities.

The code is not perfect, but it's useful to decode QR from camera.

Features:

- draw overlay: helps user to position QR code on camera
- draw bitmap: useful for debugging (what decoder sees)
- draw result: show scanned QR code

It is complicated and very easy to make subtle errors which will break decoding in some cases.
*/

import decodeQR, { DecodeOpts, FinderPoints } from './decode.js';
import type { Image } from './index.js';

export const getSize = (elm: HTMLElement) => ({
  width: Math.floor(+getComputedStyle(elm).width.split('px')[0]),
  height: Math.floor(+getComputedStyle(elm).height.split('px')[0]),
});

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

export type QRCanvasOpts = {
  resultBlockSize: number; // block size per pixel for resulting qr code image
  overlayMainColor: string;
  overlayFinderColor: string;
  overlaySideColor: string;
  overlayTimeout: number; // how must time from last detect until hide overlay stuff
  cropToSquare: boolean; // crop image to square
};

export type QRCanvasElements = {
  overlay?: HTMLCanvasElement; // Overlay
  bitmap?: HTMLCanvasElement; // What decoder see
  resultQR?: HTMLCanvasElement; // QR code on successful parse
};
/**
 * Handles canvases for QR code decoding
 */
export class QRCanvas {
  private opts: QRCanvasOpts;
  private lastDetect = 0;
  private main: CanvasWithContext;
  private overlay?: CanvasWithContext;
  private bitmap?: CanvasWithContext;
  private resultQR?: CanvasWithContext;

  constructor(
    { overlay, bitmap, resultQR }: QRCanvasElements = {},
    opts: Partial<QRCanvasOpts> = {}
  ) {
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
  drawImage(image: CanvasImageSource, height: number, width: number) {
    this.setSize(height, width);
    const { context } = this.main;
    context.drawImage(image, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height);
    const options: DecodeOpts = { cropToSquare: this.opts.cropToSquare };
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
  clear() {
    clearCanvas(this.main);
    if (this.overlay) clearCanvas(this.overlay);
    if (this.bitmap) clearCanvas(this.bitmap);
    if (this.resultQR) clearCanvas(this.resultQR);
  }
}

class QRCamera {
  constructor(
    private stream: MediaStream,
    private player: HTMLVideoElement
  ) {
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
  async listDevices() {
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
  async setDevice(deviceId: string) {
    this.stop();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
    });
    this.setStream(stream);
  }
  readFrame(canvas: QRCanvas, fullSize = false) {
    const { player } = this;
    if (fullSize) return canvas.drawImage(player, player.videoHeight, player.videoWidth);
    const size = getSize(player);
    return canvas.drawImage(player, size.height, size.width);
  }
  stop() {
    for (const track of this.stream.getTracks()) track.stop();
  }
}
/**
 * Creates new QRCamera from frontal camera
 * @param player - HTML Video element
 * @example
 * const canvas = new QRCanvas();
 * const camera = frontalCamera();
 * const devices = await camera.listDevices();
 * await camera.setDevice(devices[0].deviceId); // Change camera
 * const res = camera.readFrame(canvas);
 */
export async function frontalCamera(player: HTMLVideoElement) {
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
  console.log('TTT', stream);
  return new QRCamera(stream, player);
}

/**
 * Run callback in a loop with requestAnimationFrame
 * @param cb - callback
 * @example
 * const cancel = frameLoop((ns) => console.log(ns));
 * cancel();
 */
export function frameLoop(cb: FrameRequestCallback) {
  let handle: number | undefined = undefined;
  function loop(ts: number) {
    cb(ts);
    handle = requestAnimationFrame(loop);
  }
  handle = requestAnimationFrame(loop);
  return () => {
    if (handle === undefined) return;
    cancelAnimationFrame(handle);
    handle = undefined;
  };
}

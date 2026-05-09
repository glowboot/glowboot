/**
 * Webcam → Game Boy Camera sensor bridge.
 *
 * Pulls live frames from `getUserMedia`, downsamples to the M64282FP's
 * native 128×112 grid, runs the cart's exposure + ordered-dither
 * pipeline, and deposits the result as 2bpp tile bytes at cart RAM
 * bank 0 offset 0x100 — exactly where the Camera ROM expects the
 * sensor's output. The ROM polls register 0's busy bit (cleared
 * synchronously by `writeCamera`), then in its next frame reads
 * A100-AEFF as plain SRAM and blits the bytes into VRAM.
 *
 * Live-view is just "trigger every frame, blit cart RAM bank 0 to
 * the screen" — there is no separate streaming mode. When the user
 * presses Shutter the ROM does one more capture, then memcpys the
 * bank-0 buffer into a saved-photo slot via regular cart-RAM writes.
 */

import type { Cartridge } from "../../gb";

const SENSOR_W = 128;
const SENSOR_H = 112;
const TILE_W = SENSOR_W >> 3; // 16 tiles wide
const TILE_H = SENSOR_H >> 3; // 14 tiles tall
const BUFFER_BYTES = TILE_W * TILE_H * 16; // 3584 = 128 × 112 × 2 bpp / 8

let stream: MediaStream | null = null;
let video: HTMLVideoElement | null = null;
let scratch: HTMLCanvasElement | null = null;
let scratchCtx: CanvasRenderingContext2D | null = null;

export async function startWebcam(): Promise<MediaStream | null> {
  if (stream) return stream;
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("[Webcam] getUserMedia unavailable");
    return null;
  }
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 320 }, height: { ideal: 240 } },
      audio: false
    });
  } catch (err) {
    console.warn("[Webcam] permission denied or capture failed:", err);
    stream = null;
    return null;
  }
  video = document.createElement("video");
  video.srcObject = stream;
  // Required for iOS WKWebView — without it, play() launches the
  // system video player instead of streaming into the element.
  video.playsInline = true;
  video.muted = true;
  await video.play().catch(() => {
    /* element will start producing frames once the stream is live */
  });
  return stream;
}

export function stopWebcam(): void {
  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  video = null;
  scratch = null;
  scratchCtx = null;
}

/** Pull one webcam frame and run the M64282FP capture pipeline.
 *  Output lands at cart RAM bank 0 + 0x100 as 3584 bytes of 2bpp
 *  tile data. Called from `cart.onCameraCapture` (synchronous, in
 *  the ROM's bus-write path) and the 30 Hz live-view timer. */
export function captureToCartRam(cart: Cartridge): void {
  if (!video || video.videoWidth === 0 || video.videoHeight === 0) return;

  if (!scratch) {
    scratch = document.createElement("canvas");
    scratch.width = SENSOR_W;
    scratch.height = SENSOR_H;
    scratchCtx = scratch.getContext("2d", { willReadFrequently: true });
  }
  if (!scratchCtx) return;

  // Mirror horizontally so the user sees themself in the canonical
  // selfie orientation; the cart was always pointed at the user.
  scratchCtx.save();
  scratchCtx.scale(-1, 1);
  scratchCtx.drawImage(video, -SENSOR_W, 0, SENSOR_W, SENSOR_H);
  scratchCtx.restore();
  const px = scratchCtx.getImageData(0, 0, SENSOR_W, SENSOR_H).data;

  const regs = cart.cameraRegs;
  // Exposure is a 16-bit multiplier (regs 2-3, big-endian). The
  // Camera ROM normally writes values in the 0x0010..0x1000 range;
  // treat 0 as 0x100 (unity) to keep startup frames from coming out
  // pure black before the ROM configures exposure.
  const exposure = (regs[0x02]! << 8) | regs[0x03]! || 0x100;

  const buffer = new Uint8Array(BUFFER_BYTES);

  for (let y = 0; y < SENSOR_H; y++) {
    for (let x = 0; x < SENSOR_W; x++) {
      const i = (y * SENSOR_W + x) << 2;
      // Rec.601 luma in 8.8 fixed point: Y = 0.299R + 0.587G + 0.114B.
      let gray = (px[i]! * 77 + px[i + 1]! * 150 + px[i + 2]! * 29) >> 8;
      // Sensor exposure scale: gray = (gray + 1) * exposure / 256.
      gray = ((gray + 1) * exposure) >> 8;
      if (gray > 255) gray = 255;

      // 4×4 ordered dither — 16 cells × 3 thresholds at register 0x06.
      // Cell index = (x & 3) + (y & 3) * 4. Three monotone-increasing
      // thresholds per cell pick one of 4 output levels (3 = black,
      // 0 = white). The ROM rewrites this matrix early in init.
      const m = ((x & 3) + (y & 3) * 4) * 3 + 6;
      const t1 = regs[m]!;
      const t2 = regs[m + 1]!;
      const t3 = regs[m + 2]!;
      let level: number;
      if (gray < t1) level = 3;
      else if (gray < t2) level = 2;
      else if (gray < t3) level = 1;
      else level = 0;

      // GB 2bpp tile pack. Buffer is tile-row-major: tile (col, row)
      // sits at byte (row * 16 + col) * 16. Within a tile, row y
      // contributes to bytes 2*(y&7) (low plane) and 2*(y&7)+1 (high
      // plane). Pixel x contributes to bit (7 - (x&7)).
      const tileIdx = (y >> 3) * TILE_W + (x >> 3);
      const byteOff = tileIdx * 16 + (y & 7) * 2;
      const bit = 7 - (x & 7);
      buffer[byteOff]! |= (level & 1) << bit;
      buffer[byteOff + 1]! |= ((level >> 1) & 1) << bit;
    }
  }

  cart.writeCameraImage(buffer);
}

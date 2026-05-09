/**
 * Screen recording via `canvas.captureStream()` + `MediaRecorder`. Captures
 * whatever pixels the renderer is drawing (so integer scaling / smoothing
 * filters land in the file at whatever size the canvas currently has) and
 * muxes in the emulator audio graph via `AudioOutput.createRecordingTap()`.
 *
 * Output is whatever the browser supports — VP9 preferred, then VP8, then
 * whatever `MediaRecorder` picks by default. All modern Chromium/Firefox
 * builds yield WebM; Safari may fall back to MP4 since Safari 14.1.
 */

import { errorToast, toast } from "../hud/toast.js";
import { saveBlobNative } from "../save-blob.js";

/** Order candidates by what the host browser can both *record* and
 *  *play back*. WebM/VP9 is the smaller, sharper default on Chromium
 *  / Firefox; Safari falls through to MP4 since it advertises WebM
 *  support intermittently and refuses to play back its own output. */
function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];
  for (const t of candidates) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return "";
}

function extensionFor(mime: string): string {
  if (mime.startsWith("video/mp4")) return "mp4";
  return "webm";
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private filename = "";
  private mime = "";

  get active(): boolean {
    return this.rec !== null;
  }

  /** Begin recording. No-op if already recording or `MediaRecorder` is
   *  unavailable (returns false). */
  start(canvas: HTMLCanvasElement, audioStream: MediaStream | null, filenameStem: string): boolean {
    if (this.rec) return false;
    if (typeof MediaRecorder === "undefined") {
      console.warn("[Recorder] MediaRecorder is undefined on this platform");
      return false;
    }
    if (typeof canvas.captureStream !== "function") {
      console.warn("[Recorder] canvas.captureStream not available — required for video recording");
      return false;
    }
    const mime = pickMimeType();
    console.info(`[Recorder] starting; canvas=${canvas.width}x${canvas.height}, mime="${mime || "(default)"}"`);

    const videoStream = canvas.captureStream(60);
    const videoTracks = videoStream.getVideoTracks();
    if (videoTracks.length === 0) {
      console.warn(
        "[Recorder] captureStream returned no video tracks — iOS WKWebView is known to fail here on WebGL canvases"
      );
      return false;
    }
    const tracks = [...videoTracks];
    if (audioStream) tracks.push(...audioStream.getAudioTracks());
    const stream = new MediaStream(tracks);

    const options = mime ? { mimeType: mime } : undefined;
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, options);
    } catch (err) {
      console.warn("[Recorder] MediaRecorder construction failed:", err);
      return false;
    }

    this.chunks = [];
    this.mime = rec.mimeType || mime;
    this.filename = `${filenameStem}.${extensionFor(this.mime)}`;
    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onerror = (e) => {
      console.warn("[Recorder] MediaRecorder error:", e);
    };
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: this.mime || "video/webm" });
      console.info(`[Recorder] stopped; ${this.chunks.length} chunks, ${blob.size} bytes`);
      if (blob.size === 0) {
        console.warn("[Recorder] produced zero-byte blob — frames likely never reached the recorder");
        this.chunks = [];
        this.rec = null;
        void deliver(null, this.filename);
        return;
      }
      void deliver(blob, this.filename);
      this.chunks = [];
      this.rec = null;
    };
    // Timeslice of 1s keeps chunks small and bounds memory growth on long
    // recordings; the browser still produces a single seekable blob.
    rec.start(1000);
    this.rec = rec;
    return true;
  }

  stop(): void {
    if (!this.rec) return;
    if (this.rec.state !== "inactive") this.rec.stop();
  }
}

/** Hand the finished recording to the user. On phones this opens the
 *  OS share sheet via the Web Share API; on desktop it falls back to
 *  the classic invisible-anchor download. iOS Safari ignores
 *  `<a download>`, so the share-sheet path is the only thing that
 *  actually surfaces the file there.
 *
 *  Accepts `null` for the empty-recording case (zero-byte blob from a
 *  failed captureStream) so the caller can keep one delivery path. */
async function deliver(blob: Blob | null, filename: string): Promise<void> {
  if (!blob) {
    errorToast("Recording was empty — your browser may not support video recording from a WebGL canvas");
    return;
  }
  const handled = await saveBlobNative(blob, filename);
  if (handled) {
    toast("Recording ready to share");
    return;
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

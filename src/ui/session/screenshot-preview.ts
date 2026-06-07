/**
 * Screenshot preview + AI-enhance flow.
 *
 * Replaces the old "capture → straight to save dialog" behaviour with a
 * lightweight modal: the captured native frame is shown with a Download
 * (raw PNG) action and an "Enhance with AI" action. Enhancing runs the
 * Real-ESRGAN upscaler (see `upscale/upscaler.ts`) and swaps in a
 * draggable before/after split so the user can judge the 4× result, then
 * download the enhanced PNG (or share it on mobile).
 *
 * The native PPU framebuffer is the source — not the shader-displayed
 * canvas — so the "original" is a pixel-exact native-res shot and the
 * enhance input isn't double-processed by a display shader.
 *
 * One modal at a time; Escape / backdrop / ✕ all close and restore focus.
 */

import { toast } from "../hud/toast.js";
import { saveBlobNative } from "../save-blob.js";
import { hasWebGpu, isUpscaleSupported, upscaleFrame } from "../upscale/upscaler.js";

let activeOverlay: HTMLElement | null = null;
let lastFocus: HTMLElement | null = null;
/** Fired when the modal closes (any path: ✕, Esc, backdrop, or being
 *  replaced by a new capture). The caller uses it to resume gameplay it
 *  paused on open. */
let activeOnClose: (() => void) | null = null;

/** Paint an RGBA buffer into a fresh native-resolution canvas. */
function canvasFromRgba(rgba: Uint8ClampedArray, width: number, height: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = width;
  c.height = height;
  const ctx = c.getContext("2d")!;
  // The buffer may be a view over a larger frame; copy the exact slice.
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba.subarray(0, width * height * 4)), width, height), 0, 0);
  return c;
}

async function downloadCanvas(canvas: HTMLCanvasElement, filename: string): Promise<void> {
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), "image/png"));
  if (!blob) {
    toast("Couldn't export the image");
    return;
  }
  const handled = await saveBlobNative(blob, filename);
  if (handled === "shared" || handled === "cancelled") return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function close(): void {
  if (!activeOverlay) return;
  activeOverlay.remove();
  activeOverlay = null;
  document.removeEventListener("keydown", onKeydown, true);
  lastFocus?.focus?.();
  lastFocus = null;
  const cb = activeOnClose;
  activeOnClose = null;
  cb?.();
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  }
}

/** True while the preview modal is open. Lets the screenshot action
 *  ignore a repeat trigger (the game is paused under the modal, so
 *  re-entering would tangle the pause/resume bookkeeping). */
export function isScreenshotPreviewOpen(): boolean {
  return activeOverlay !== null;
}

/**
 * Open the preview for a freshly captured native frame.
 * @param rgba    native RGBA framebuffer (width*height*4)
 * @param width   native width (160 GB / 240 GBA)
 * @param height  native height (144 GB / 160 GBA)
 * @param stem    sanitized filename stem (no extension)
 * @param onClose fired when the modal closes — used to resume gameplay
 *                the caller paused on open.
 */
export function openScreenshotPreview(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  stem: string,
  onClose?: () => void
): void {
  close(); // single instance (fires the previous modal's onClose, if any)
  lastFocus = document.activeElement as HTMLElement | null;
  activeOnClose = onClose ?? null;

  const nativeCanvas = canvasFromRgba(rgba, width, height);

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay ss-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Screenshot");
  overlay.addEventListener("click", (e) => {
    if (e.target === overlay) close();
  });

  const panel = document.createElement("div");
  panel.className = "modal-panel ss-panel";
  panel.addEventListener("click", (e) => e.stopPropagation());

  const head = document.createElement("div");
  head.className = "ss-head";
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Screenshot";
  const closeBtn = document.createElement("button");
  closeBtn.className = "ss-close";
  closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  head.append(title, closeBtn);

  // Image stage — native frame shown pixelated, scaled up for visibility.
  const stage = document.createElement("div");
  stage.className = "ss-stage";
  stage.style.aspectRatio = `${width} / ${height}`;
  const baseImg = nativeCanvas;
  baseImg.className = "ss-img ss-img-native";
  stage.appendChild(baseImg);

  const dims = document.createElement("div");
  dims.className = "ss-dims";
  dims.textContent = `${width}×${height}`;

  const actions = document.createElement("div");
  actions.className = "ss-actions";

  const downloadBtn = document.createElement("button");
  downloadBtn.type = "button";
  downloadBtn.className = "modal-btn";
  downloadBtn.textContent = "Download";
  downloadBtn.addEventListener("click", () => void downloadCanvas(nativeCanvas, `${stem}.png`));

  const enhanceBtn = document.createElement("button");
  enhanceBtn.type = "button";
  enhanceBtn.className = "modal-btn modal-btn-primary ss-enhance";
  enhanceBtn.textContent = "✨ Enhance (AI)";
  if (!isUpscaleSupported()) {
    enhanceBtn.disabled = true;
    enhanceBtn.title = "AI enhance needs a modern browser with WebAssembly";
  }
  enhanceBtn.addEventListener(
    "click",
    () => void runEnhance({ overlay, panel, stage, dims, actions, nativeCanvas, width, height, stem, enhanceBtn })
  );

  actions.append(downloadBtn, enhanceBtn);
  panel.append(head, stage, dims, actions);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  document.addEventListener("keydown", onKeydown, true);
  enhanceBtn.focus();
}

interface EnhanceCtx {
  overlay: HTMLElement;
  panel: HTMLElement;
  stage: HTMLElement;
  dims: HTMLElement;
  actions: HTMLElement;
  nativeCanvas: HTMLCanvasElement;
  width: number;
  height: number;
  stem: string;
  enhanceBtn: HTMLButtonElement;
}

async function runEnhance(ctx: EnhanceCtx): Promise<void> {
  const { stage, dims, actions, nativeCanvas, width, height, stem, enhanceBtn } = ctx;
  enhanceBtn.disabled = true;

  // Progress note — the first run pulls the model + ORT runtime (~13 MB)
  // from cache/CDN, so set expectations rather than looking frozen.
  const note = document.createElement("div");
  note.className = "ss-note";
  note.textContent = hasWebGpu()
    ? "Enhancing… (first run downloads a one-time model)"
    : "Enhancing on CPU — this can take a few seconds…";
  actions.before(note);

  try {
    const result = await upscaleFrame(
      nativeCanvas.getContext("2d")!.getImageData(0, 0, width, height).data,
      width,
      height
    );
    const enhancedCanvas = canvasFromRgba(result.data, result.width, result.height);

    // Swap the stage into a before/after split.
    stage.innerHTML = "";
    stage.classList.add("ss-compare");
    const before = nativeCanvas;
    before.className = "ss-img ss-img-native";
    const after = enhancedCanvas;
    after.className = "ss-img ss-img-enhanced";
    const divider = document.createElement("div");
    divider.className = "ss-divider";
    const slider = document.createElement("input");
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = "50";
    slider.className = "ss-slider";
    slider.setAttribute("aria-label", "Reveal enhanced image");
    const setSplit = (pct: number): void => {
      stage.style.setProperty("--split", `${pct}%`);
    };
    setSplit(50);
    slider.addEventListener("input", () => setSplit(Number(slider.value)));
    stage.append(before, after, divider);
    // Slider lives below the stage (the stage only holds the layered,
    // absolutely-positioned images + divider).
    stage.after(slider);

    const beforeTag = document.createElement("span");
    beforeTag.className = "ss-tag ss-tag-before";
    beforeTag.textContent = "Original";
    const afterTag = document.createElement("span");
    afterTag.className = "ss-tag ss-tag-after";
    afterTag.textContent = "Enhanced 4×";
    stage.append(beforeTag, afterTag);

    dims.textContent = `${result.width}×${result.height}`;

    // Rebuild the action row: download original or enhanced.
    actions.innerHTML = "";
    note.remove();
    const dlOrig = document.createElement("button");
    dlOrig.type = "button";
    dlOrig.className = "modal-btn";
    dlOrig.textContent = "Download original";
    dlOrig.addEventListener("click", () => void downloadCanvas(nativeCanvas, `${stem}.png`));
    const dlEnh = document.createElement("button");
    dlEnh.type = "button";
    dlEnh.className = "modal-btn modal-btn-primary";
    dlEnh.textContent = "✨ Download enhanced";
    dlEnh.addEventListener("click", () => void downloadCanvas(enhancedCanvas, `${stem}-4x.png`));
    actions.append(dlOrig, dlEnh);
    dlEnh.focus();
  } catch (err) {
    console.warn("[Screenshot] enhance failed:", err);
    note.remove();
    enhanceBtn.disabled = false;
    toast("Couldn't enhance — download the original instead");
  }
}

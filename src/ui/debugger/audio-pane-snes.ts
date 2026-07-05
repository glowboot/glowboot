import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * SNES audio pane — eight live oscilloscope rows, one per DSP voice.
 *
 * Mirrors `./audio-pane-gba.ts` (which mirrors the GB pane): each row has a
 * label, a live sample readout, a peak-tracking envelope bar, and a scrolling
 * trace. Voice output is post-envelope (OUTX-level), recorded by the DSP into
 * per-voice rings as offset-128 bytes with 128 = silence — the same "ds"
 * convention as the GBA Direct Sound rows, so the trace is centred on the
 * midline.
 *
 * Engine surface consumed: `dsp.debugVoice[0..7]`, `dsp.debugBufferPos`,
 * `dsp.debugBufferSize`, `dsp.voiceEnvelope`, plus SRCN from the register
 * file for the row labels.
 */

const SCOPE_INITIAL_WIDTH = 360;
const SCOPE_HEIGHT = 56;
const SCOPE_SAMPLES = 1024;

const VOICE_COLORS = ["#6aa9ff", "#7fd2a8", "#ffba64", "#ff8cb4", "#a4d8ff", "#dca0ff", "#8ee8e0", "#ffd76a"] as const;

interface VoiceRow {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  labelEl: HTMLElement;
  valueEl: HTMLElement;
  envBar: HTMLElement;
  color: string;
}

let rows: VoiceRow[] | null = null;

function makeRow(label: string, color: string): { row: HTMLElement } & VoiceRow {
  const row = document.createElement("div");
  row.className = "audio-row";

  const lbl = document.createElement("div");
  lbl.className = "audio-row-label";
  lbl.textContent = label;
  row.appendChild(lbl);

  const valueEl = document.createElement("span");
  valueEl.className = "audio-row-value";
  valueEl.textContent = "—";
  row.appendChild(valueEl);

  const envWrap = document.createElement("div");
  envWrap.className = "audio-row-env-wrap";
  envWrap.title = "Peak-tracking envelope follower (0–1)";
  const envBar = document.createElement("div");
  envBar.className = "audio-row-env-bar";
  envBar.style.background = color;
  envWrap.appendChild(envBar);
  row.appendChild(envWrap);

  const canvas = document.createElement("canvas");
  canvas.width = SCOPE_INITIAL_WIDTH;
  canvas.height = SCOPE_HEIGHT;
  canvas.className = "audio-scope";
  const ctx = canvas.getContext("2d")!;
  row.appendChild(canvas);

  return { row, canvas, ctx, labelEl: lbl, valueEl, envBar, color };
}

export const audioPaneSnes: Pane = {
  id: "audio",
  label: "Audio",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-audio");

    const heading = document.createElement("div");
    heading.className = "audio-heading";
    heading.textContent = "Live voice traces (~32 ms window)";
    container.appendChild(heading);

    rows = [];
    for (let i = 0; i < 8; i++) {
      const r = makeRow(`V${i + 1}`, VOICE_COLORS[i]!);
      container.appendChild(r.row);
      rows.push(r);
    }
  },

  refresh(): void {
    if (!rows) return;
    const snes = state.snes;
    if (!snes) return;
    const dsp = snes.apu.dsp;
    const size = dsp.debugBufferSize;
    const pos = dsp.debugBufferPos;
    const first = (pos - SCOPE_SAMPLES + size) & (size - 1);

    for (let i = 0; i < 8; i++) {
      const row = rows[i]!;
      const cssW = Math.round(row.canvas.clientWidth);
      if (cssW > 0 && cssW !== row.canvas.width) row.canvas.width = cssW;
      const buf = dsp.debugVoice[i]!;
      drawScope(row.ctx, buf, first, SCOPE_SAMPLES, size, row.color);
      const current = (buf[(pos - 1 + size) & (size - 1)] ?? 128) - 128;
      row.valueEl.textContent = (current >= 0 ? "+" : "") + String(current).padStart(3, " ");
      row.envBar.style.width = `${Math.min(1, dsp.voiceEnvelope[i]!) * 100}%`;
      const srcn = dsp.reg((i << 4) | 0x04);
      const muted = dsp.muteChannel[i] ? " (muted)" : "";
      row.labelEl.textContent = `V${i + 1}  SRC $${srcn.toString(16).padStart(2, "0").toUpperCase()}${muted}`;
    }
  }
};

function drawScope(
  ctx: CanvasRenderingContext2D,
  buf: Uint8Array,
  startIdx: number,
  count: number,
  bufSize: number,
  color: string
): void {
  const w = ctx.canvas.width;
  const h = ctx.canvas.height;
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const xScale = w / count;
  for (let i = 0; i < count; i++) {
    const s = buf[(startIdx + i) & (bufSize - 1)]!;
    const norm = (s - 128) / 128;
    const y = h / 2 - norm * ((h - 4) / 2);
    const x = i * xScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

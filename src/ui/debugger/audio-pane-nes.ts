import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * Audio pane for the NES 2A03 APU — five live oscilloscope rows.
 *
 * Mirrors the Game Boy pane (`./audio-pane.ts`) row layout: each row is
 * [ label | current value | envelope bar | waveform scope ]. The APU
 * fills a per-channel raw-output ring buffer (one byte each) which this
 * pane reads to draw a scope trace ending at the ring's write head.
 *
 * Pulse 1/2, Triangle and Noise are 0-15; the DMC is its 0-127 DAC
 * level, so each row carries its own `max` for the scope's vertical
 * scaling and the envelope-bar normalisation.
 */

const SCOPE_INITIAL_WIDTH = 360;
const SCOPE_HEIGHT = 56;
const SCOPE_SAMPLES = 1024;

interface ChannelRow {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  valueEl: HTMLElement;
  envBar: HTMLElement;
  color: string;
  dataAccessor: () => { buf: Uint8Array; envelope: number };
  /** Full-scale output for this channel (15 for pulse/triangle/noise,
   *  127 for the DMC) — scales the scope trace and value padding. */
  max: number;
}

let rows: ChannelRow[] | null = null;

function makeRow(
  label: string,
  color: string
): {
  row: HTMLElement;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  valueEl: HTMLElement;
  envBar: HTMLElement;
} {
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

  return { row, canvas, ctx, valueEl, envBar };
}

export const audioPaneNes: Pane = {
  id: "audio",
  label: "Audio",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-audio");

    const heading = document.createElement("div");
    heading.className = "audio-heading";
    heading.textContent = "Live channel traces (~23 ms window)";
    container.appendChild(heading);

    // Colours differentiate the five channels at a glance — pulse pair
    // in cool tones, triangle warm, noise magenta, DMC amber.
    const r1 = makeRow("Pulse 1", "#6aa9ff");
    const r2 = makeRow("Pulse 2", "#7fd2a8");
    const r3 = makeRow("Triangle", "#ffba64");
    const r4 = makeRow("Noise", "#ff8cb4");
    const r5 = makeRow("DMC", "#d8b35a");

    container.append(r1.row, r2.row, r3.row, r4.row, r5.row);

    rows = [
      {
        canvas: r1.canvas,
        ctx: r1.ctx,
        valueEl: r1.valueEl,
        envBar: r1.envBar,
        color: "#6aa9ff",
        max: 15,
        dataAccessor: () => ({ buf: state.nes!.apu.debugPulse1, envelope: state.nes!.apu.pulse1Envelope })
      },
      {
        canvas: r2.canvas,
        ctx: r2.ctx,
        valueEl: r2.valueEl,
        envBar: r2.envBar,
        color: "#7fd2a8",
        max: 15,
        dataAccessor: () => ({ buf: state.nes!.apu.debugPulse2, envelope: state.nes!.apu.pulse2Envelope })
      },
      {
        canvas: r3.canvas,
        ctx: r3.ctx,
        valueEl: r3.valueEl,
        envBar: r3.envBar,
        color: "#ffba64",
        max: 15,
        dataAccessor: () => ({ buf: state.nes!.apu.debugTriangle, envelope: state.nes!.apu.triangleEnvelope })
      },
      {
        canvas: r4.canvas,
        ctx: r4.ctx,
        valueEl: r4.valueEl,
        envBar: r4.envBar,
        color: "#ff8cb4",
        max: 15,
        dataAccessor: () => ({ buf: state.nes!.apu.debugNoise, envelope: state.nes!.apu.noiseEnvelope })
      },
      {
        canvas: r5.canvas,
        ctx: r5.ctx,
        valueEl: r5.valueEl,
        envBar: r5.envBar,
        color: "#d8b35a",
        max: 127,
        dataAccessor: () => ({ buf: state.nes!.apu.debugDmc, envelope: state.nes!.apu.dmcEnvelope })
      }
    ];
  },

  refresh(): void {
    if (!rows) return;
    const nes = state.nes;
    if (!nes) return;
    const size = nes.apu.debugBufferSize;
    const pos = nes.apu.debugBufferPos;
    // The scope shows the N most recent samples — wrap-scan backwards
    // from the current write head.
    const first = (pos - SCOPE_SAMPLES + size) & (size - 1);

    for (const row of rows) {
      // Sync the canvas bitmap to its laid-out width so the waveform
      // draws sharp at whatever width the flex row settled on. Only
      // assign when it differs — every assignment clears the canvas.
      const cssW = Math.round(row.canvas.clientWidth);
      if (cssW > 0 && cssW !== row.canvas.width) row.canvas.width = cssW;
      const { buf, envelope } = row.dataAccessor();
      drawScope(row.ctx, buf, first, SCOPE_SAMPLES, size, row.color, row.max);
      const current = buf[(pos - 1 + size) & (size - 1)] ?? 0;
      row.valueEl.textContent = String(current).padStart(3, " ");
      row.envBar.style.width = `${Math.min(1, envelope) * 100}%`;
    }
  }
};

/** Render a scope trace. Clears the canvas, draws a midline grid, and
 *  plots the waveform as a polyline. Samples are 0..`max`; mapped to the
 *  full height with 0 at the bottom and `max` at the top. */
function drawScope(
  ctx: CanvasRenderingContext2D,
  buf: Uint8Array,
  startIdx: number,
  count: number,
  bufSize: number,
  color: string,
  max: number
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
    const y = h - 2 - (s / max) * (h - 4);
    const x = i * xScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

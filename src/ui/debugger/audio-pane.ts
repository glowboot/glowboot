import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * Audio pane — live oscilloscope + envelope bar per APU channel.
 *
 * The APU fills a 4096-sample ring buffer per channel (one byte each,
 * values 0..15 = raw pre-mix amplitude). The pane reads the last
 * ~window-width samples ending at the ring's write head and draws a
 * scope trace on a per-channel canvas. The envelope bar next to it
 * renders the peak-tracking follower exposed as `chNEnvelope` on the
 * APU — same value the audio-reactive rumble consumes.
 *
 * Channels are drawn in parallel rows; each row shows:
 *   [ label | current value | envelope bar | waveform scope ]
 */

/** Initial canvas buffer width — resized to `canvas.clientWidth` on
 *  every refresh so the scope fills the row's flex-grown width without
 *  bitmap stretching. 360 is just the starting point before CSS lays
 *  the row out. */
const SCOPE_INITIAL_WIDTH = 360;
const SCOPE_HEIGHT = 56;

/** How many of the buffered samples the scope renders. 1024 ≈ 23 ms at
 *  44.1 kHz — short enough for the waveform's shape to be readable
 *  even for the higher square-wave frequencies the Game Boy uses. */
const SCOPE_SAMPLES = 1024;

interface ChannelRow {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  valueEl: HTMLElement;
  envBar: HTMLElement;
  dataAccessor: () => { buf: Uint8Array; envelope: number };
  color: string;
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

export const audioPane: Pane = {
  id: "audio",
  label: "Audio",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-audio");

    const heading = document.createElement("div");
    heading.className = "audio-heading";
    heading.textContent = "Live channel traces (~23 ms window)";
    container.appendChild(heading);

    // Channel colours picked to differentiate the four scopes at a
    // glance — square pair in cool tones, wave warm, noise magenta.
    const r1 = makeRow("CH1  Square 1", "#6aa9ff");
    const r2 = makeRow("CH2  Square 2", "#7fd2a8");
    const r3 = makeRow("CH3  Wave", "#ffba64");
    const r4 = makeRow("CH4  Noise", "#ff8cb4");

    container.append(r1.row, r2.row, r3.row, r4.row);

    rows = [
      {
        canvas: r1.canvas,
        ctx: r1.ctx,
        valueEl: r1.valueEl,
        envBar: r1.envBar,
        color: "#6aa9ff",
        dataAccessor: () => ({ buf: state.gb!.apu.debugCh1, envelope: state.gb!.apu.ch1Envelope })
      },
      {
        canvas: r2.canvas,
        ctx: r2.ctx,
        valueEl: r2.valueEl,
        envBar: r2.envBar,
        color: "#7fd2a8",
        dataAccessor: () => ({ buf: state.gb!.apu.debugCh2, envelope: state.gb!.apu.ch2Envelope })
      },
      {
        canvas: r3.canvas,
        ctx: r3.ctx,
        valueEl: r3.valueEl,
        envBar: r3.envBar,
        color: "#ffba64",
        dataAccessor: () => ({ buf: state.gb!.apu.debugCh3, envelope: state.gb!.apu.ch3Envelope })
      },
      {
        canvas: r4.canvas,
        ctx: r4.ctx,
        valueEl: r4.valueEl,
        envBar: r4.envBar,
        color: "#ff8cb4",
        dataAccessor: () => ({ buf: state.gb!.apu.debugCh4, envelope: state.gb!.apu.ch4Envelope })
      }
    ];
  },

  refresh(): void {
    if (!rows) return;
    const gb = state.gb;
    if (!gb) return;
    const size = gb.apu.debugBufferSize;
    const pos = gb.apu.debugBufferPos;
    // The scope shows the N most recent samples — wrap-scan backwards
    // from the current write head.
    const first = (pos - SCOPE_SAMPLES + size) & (size - 1);

    for (const row of rows) {
      // Sync the canvas bitmap to its laid-out width so the waveform
      // draws sharp at whatever width the flex row settled on. Only
      // assign when it actually differs — every assignment clears the
      // canvas which would strobe if we did it unconditionally.
      const cssW = Math.round(row.canvas.clientWidth);
      if (cssW > 0 && cssW !== row.canvas.width) row.canvas.width = cssW;
      const { buf, envelope } = row.dataAccessor();
      drawScope(row.ctx, buf, first, SCOPE_SAMPLES, size, row.color);
      // Current instantaneous value — the sample just written. Gives
      // a quick "is this channel on right now?" readout next to the
      // scope trace.
      const current = buf[(pos - 1 + size) & (size - 1)] ?? 0;
      row.valueEl.textContent = String(current).padStart(2, " ");
      row.envBar.style.width = `${Math.min(1, envelope) * 100}%`;
    }
  }
};

/** Render a scope trace. Clears the canvas, draws a midline grid, and
 *  plots the waveform as a polyline. Samples are 0..15; map to full
 *  height with the inversion flipped so 15 is at the top. Uses the
 *  canvas's live width so the scope reflects whatever size the flex
 *  row settled on. */
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
  // Background + midline grid.
  ctx.fillStyle = "rgba(0, 0, 0, 0.35)";
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h / 2);
  ctx.lineTo(w, h / 2);
  ctx.stroke();

  // Waveform.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const xScale = w / count;
  for (let i = 0; i < count; i++) {
    const s = buf[(startIdx + i) & (bufSize - 1)]!;
    const y = h - 2 - (s / 15) * (h - 4);
    const x = i * xScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

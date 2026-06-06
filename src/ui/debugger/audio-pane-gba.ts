import { state } from "../state.js";
import type { Pane } from "./pane.js";

/**
 * GBA audio pane — six live oscilloscope rows.
 *
 * Mirrors `./audio-pane.ts` (GB) for the four PSG channels and adds
 * two Direct Sound rows (DSA, DSB). The PSG rows read 0..15 unsigned
 * raw samples; the DS rows read 0..255 with 128 as silence (signed
 * 8-bit shifted up so all six ring buffers can share Uint8Array).
 *
 * Engine surface added in this commit: `gba.mem.apu.debugCh1..4 +
 * debugDsa + debugDsb` ring buffers, `debugBufferPos` /
 * `debugBufferSize`, and per-channel envelope followers.
 */

const SCOPE_INITIAL_WIDTH = 360;
const SCOPE_HEIGHT = 56;
const SCOPE_SAMPLES = 1024;

interface ChannelRow {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  valueEl: HTMLElement;
  envBar: HTMLElement;
  dataAccessor: () => { buf: Uint8Array; envelope: number };
  color: string;
  /** "psg" rows have samples 0..15 with the trace anchored at the
   *  bottom; "ds" rows have samples 0..255 with 128 = silence and
   *  the trace centred on the midline. */
  kind: "psg" | "ds";
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

export const audioPaneGba: Pane = {
  id: "audio",
  label: "Audio",

  mount(container: HTMLElement): void {
    container.innerHTML = "";
    container.classList.add("debugger-pane", "debugger-pane-audio");

    const heading = document.createElement("div");
    heading.className = "audio-heading";
    heading.textContent = "Live channel traces (~23 ms window)";
    container.appendChild(heading);

    const r1 = makeRow("CH1  Square 1", "#6aa9ff");
    const r2 = makeRow("CH2  Square 2", "#7fd2a8");
    const r3 = makeRow("CH3  Wave", "#ffba64");
    const r4 = makeRow("CH4  Noise", "#ff8cb4");
    const ra = makeRow("DSA  Direct A", "#a4d8ff");
    const rb = makeRow("DSB  Direct B", "#dca0ff");

    container.append(r1.row, r2.row, r3.row, r4.row, ra.row, rb.row);

    rows = [
      {
        canvas: r1.canvas,
        ctx: r1.ctx,
        valueEl: r1.valueEl,
        envBar: r1.envBar,
        color: "#6aa9ff",
        kind: "psg",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugCh1, envelope: state.gba!.mem.apu.ch1Envelope })
      },
      {
        canvas: r2.canvas,
        ctx: r2.ctx,
        valueEl: r2.valueEl,
        envBar: r2.envBar,
        color: "#7fd2a8",
        kind: "psg",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugCh2, envelope: state.gba!.mem.apu.ch2Envelope })
      },
      {
        canvas: r3.canvas,
        ctx: r3.ctx,
        valueEl: r3.valueEl,
        envBar: r3.envBar,
        color: "#ffba64",
        kind: "psg",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugCh3, envelope: state.gba!.mem.apu.ch3Envelope })
      },
      {
        canvas: r4.canvas,
        ctx: r4.ctx,
        valueEl: r4.valueEl,
        envBar: r4.envBar,
        color: "#ff8cb4",
        kind: "psg",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugCh4, envelope: state.gba!.mem.apu.ch4Envelope })
      },
      {
        canvas: ra.canvas,
        ctx: ra.ctx,
        valueEl: ra.valueEl,
        envBar: ra.envBar,
        color: "#a4d8ff",
        kind: "ds",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugDsa, envelope: state.gba!.mem.apu.dsaEnvelope })
      },
      {
        canvas: rb.canvas,
        ctx: rb.ctx,
        valueEl: rb.valueEl,
        envBar: rb.envBar,
        color: "#dca0ff",
        kind: "ds",
        dataAccessor: () => ({ buf: state.gba!.mem.apu.debugDsb, envelope: state.gba!.mem.apu.dsbEnvelope })
      }
    ];
  },

  refresh(): void {
    if (!rows) return;
    const gba = state.gba;
    if (!gba) return;
    const size = gba.mem.apu.debugBufferSize;
    const pos = gba.mem.apu.debugBufferPos;
    const first = (pos - SCOPE_SAMPLES + size) & (size - 1);

    for (const row of rows) {
      const cssW = Math.round(row.canvas.clientWidth);
      if (cssW > 0 && cssW !== row.canvas.width) row.canvas.width = cssW;
      const { buf, envelope } = row.dataAccessor();
      drawScope(row.ctx, buf, first, SCOPE_SAMPLES, size, row.color, row.kind);
      const current = buf[(pos - 1 + size) & (size - 1)] ?? 0;
      if (row.kind === "ds") {
        // Pretty-print as signed value for DS so the "silence = 0"
        // mental model carries through to the live readout.
        const signed = current - 128;
        row.valueEl.textContent = (signed >= 0 ? "+" : "") + String(signed).padStart(3, " ");
      } else {
        row.valueEl.textContent = String(current).padStart(2, " ");
      }
      row.envBar.style.width = `${Math.min(1, envelope) * 100}%`;
    }
  }
};

function drawScope(
  ctx: CanvasRenderingContext2D,
  buf: Uint8Array,
  startIdx: number,
  count: number,
  bufSize: number,
  color: string,
  kind: "psg" | "ds"
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
    // PSG: 0..15 anchored at the bottom of the canvas.
    // DS: 0..255 centred on the midline (128 → middle).
    const norm = kind === "ds" ? (s - 128) / 128 : -1 + (s / 15) * 2;
    const y = h / 2 - norm * ((h - 4) / 2);
    const x = i * xScale;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();
}

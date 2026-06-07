/**
 * "Ask AI about this screen" overlay — a non-blocking panel (same docked,
 * pointer-events-through pattern as the translate overlay) showing the
 * captured frame, a question box + quick actions (Hint / Describe), and the
 * streamed answer. Reuses the Web Speech narrator for an optional read-aloud.
 */

import { makeDraggablePanel } from "../draggable.js";
import { confirmAction } from "../hud/modal.js";
import { hasVoiceFor, narrate, stopNarration } from "../ocr/narrate.js";
import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";
import { isAiPlaying, setAiGoal, setAiHint, startAiPlay, stopAiPlay } from "./ai-play.js";
import { askAssist, isAssistConfigured, preferredAnswerLang } from "./assist.js";

let activeOverlay: HTMLElement | null = null;
let lastFocus: HTMLElement | null = null;
let activeAbort: AbortController | null = null;

export function isAssistOverlayOpen(): boolean {
  return activeOverlay !== null;
}

function close(): void {
  if (!activeOverlay) return;
  activeAbort?.abort();
  activeAbort = null;
  stopAiPlay(); // closing the panel stops the agent loop
  stopNarration();
  activeOverlay.remove();
  activeOverlay = null;
  document.removeEventListener("keydown", onKeydown, true);
  window.removeEventListener("gb-rom-loaded", close);
  lastFocus?.focus?.();
  lastFocus = null;
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.stopPropagation();
    close();
  }
}

/**
 * Open the assist overlay for a captured native frame.
 * @param rgba      native RGBA framebuffer
 * @param width     native width (160 GB / 240 GBA)
 * @param height    native height (144 GB / 160 GBA)
 * @param gameTitle cart title, passed to the model for context
 */
export function openAssistOverlay(rgba: Uint8ClampedArray, width: number, height: number, gameTitle: string): void {
  close();
  lastFocus = document.activeElement as HTMLElement | null;

  const frame = document.createElement("canvas");
  frame.width = width;
  frame.height = height;
  frame
    .getContext("2d")!
    .putImageData(new ImageData(new Uint8ClampedArray(rgba.subarray(0, width * height * 4)), width, height), 0, 0);
  // `let` so AI-play can swap in the current frame on stop (the captured one
  // goes stale as the game advances); Q&A then asks about the fresh frame too.
  let imageDataUrl = frame.toDataURL("image/png");
  function setFrameImage(url: string): void {
    imageDataUrl = url;
    const img = new Image();
    img.onload = () => frame.getContext("2d")?.drawImage(img, 0, 0, frame.width, frame.height);
    img.src = url;
  }

  const overlay = document.createElement("div");
  overlay.className = "modal-overlay tr-overlay";
  overlay.setAttribute("role", "region");
  overlay.setAttribute("aria-label", "Ask AI");

  const panel = document.createElement("div");
  panel.className = "modal-panel tr-panel assist-panel";

  const head = document.createElement("div");
  head.className = "tr-head";
  const title = document.createElement("h2");
  title.className = "modal-title";
  title.textContent = "Ask AI about this screen";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "ss-close";
  closeBtn.setAttribute("aria-label", "Close");
  closeBtn.textContent = "✕";
  closeBtn.addEventListener("click", close);
  head.append(title, closeBtn);

  frame.className = "assist-frame";

  const answer = document.createElement("div");
  answer.className = "assist-answer";
  answer.hidden = true;

  const note = document.createElement("p");
  note.className = "tr-note";
  note.hidden = true;

  // Persistent objective for AI-play (shown only while playing). Distinct
  // from the one-shot hint box below.
  const goalInput = document.createElement("input");
  goalInput.type = "text";
  goalInput.className = "assist-input assist-goal";
  goalInput.placeholder = "🎯 Goal (optional, e.g. reach the flag)";
  goalInput.hidden = true;
  goalInput.addEventListener("change", () => setAiGoal(goalInput.value));

  const form = document.createElement("form");
  form.className = "assist-form";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "assist-input";
  input.placeholder = "Ask about this screen…";
  const askBtn = document.createElement("button");
  askBtn.type = "submit";
  askBtn.className = "modal-btn";
  askBtn.textContent = "Ask";
  form.append(input, askBtn);

  const quick = document.createElement("div");
  quick.className = "assist-quick";
  const hintBtn = document.createElement("button");
  hintBtn.type = "button";
  hintBtn.className = "modal-btn";
  hintBtn.textContent = "💡 Hint";
  const describeBtn = document.createElement("button");
  describeBtn.type = "button";
  describeBtn.className = "modal-btn";
  describeBtn.textContent = "👁 Describe";
  const playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "modal-btn";
  playBtn.textContent = "🎮 Let AI play";
  quick.append(hintBtn, describeBtn, playBtn);

  panel.append(head, frame, goalInput, form, quick, answer, note);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
  document.addEventListener("keydown", onKeydown, true);
  // Loading a new cart replaces the engine AI-play drives — dismiss this
  // (now-stale) window so it doesn't linger on the previous game.
  window.addEventListener("gb-rom-loaded", close);

  // Draggable by the header; position remembered (default = bottom-right,
  // clear of the centred game canvas). The close button isn't a drag target.
  makeDraggablePanel(panel, head, KEYS.ASSIST_PANEL_POS, closeBtn);

  function setBusy(busy: boolean): void {
    askBtn.disabled = busy;
    hintBtn.disabled = busy;
    describeBtn.disabled = busy;
    input.disabled = busy;
  }

  async function run(question: string): Promise<void> {
    if (!isAssistConfigured()) {
      note.hidden = false;
      note.textContent = "Set up an AI endpoint in Settings → AI assist first.";
      return;
    }
    activeAbort?.abort();
    stopNarration();
    const abort = new AbortController();
    activeAbort = abort;
    note.hidden = true;
    answer.hidden = false;
    answer.textContent = "…";
    setBusy(true);
    const lang = preferredAnswerLang(); // respect the "Translate screen to" setting
    let first = true;
    try {
      const text = await askAssist({
        imageDataUrl,
        question,
        gameTitle,
        responseLang: lang?.name,
        signal: abort.signal,
        onToken: (chunk) => {
          if (first) {
            answer.textContent = "";
            first = false;
          }
          answer.textContent += chunk;
        }
      });
      if (!text.trim()) answer.textContent = "(no answer)";
      addSpeak(text, lang?.code ?? "en");
    } catch (err) {
      if (!abort.signal.aborted) {
        console.warn("[Assist] failed:", err);
        answer.hidden = true;
        note.hidden = false;
        note.textContent =
          "Request failed — check your endpoint/key in Settings (and that it allows browser requests).";
      }
    } finally {
      if (activeAbort === abort) activeAbort = null;
      setBusy(false);
    }
  }

  let speakBtn: HTMLButtonElement | null = null;
  function addSpeak(text: string, lang: string): void {
    if (speakBtn || !text.trim() || !hasVoiceFor(lang)) return;
    speakBtn = document.createElement("button");
    speakBtn.type = "button";
    speakBtn.className = "tr-speak";
    speakBtn.textContent = "🔊 Speak";
    speakBtn.addEventListener("click", () => narrate(answer.textContent ?? "", lang));
    panel.appendChild(speakBtn);
  }

  // While the agent plays, the text box becomes a live hint channel; Q&A
  // quick actions are off, and the captured image is hidden.
  function setPlayMode(on: boolean): void {
    hintBtn.disabled = on;
    describeBtn.disabled = on;
    goalInput.hidden = !on;
    input.placeholder = on ? "Hint for the AI (e.g. go down the pipe)…" : "Ask about this screen…";
    askBtn.textContent = on ? "Send hint" : "Ask";
    playBtn.textContent = on ? "⏹ Stop AI" : "🎮 Let AI play";
    if (on) input.value = "";
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (isAiPlaying()) {
      // Live coaching — feed it into the agent's next decisions.
      setAiHint(q);
      input.value = "";
      note.hidden = false;
      note.textContent = `📌 Hint: ${q}`;
    } else {
      void run(q);
    }
  });
  hintBtn.addEventListener("click", () => void run("What should I do next here? Give one concrete next step."));
  describeBtn.addEventListener("click", () => void run("Briefly describe what's happening on this screen."));

  playBtn.addEventListener("click", async () => {
    if (isAiPlaying()) {
      stopAiPlay();
      return;
    }
    if (!isAssistConfigured()) {
      note.hidden = false;
      note.textContent = "Set up an AI endpoint in Settings → AI assist first.";
      return;
    }
    // One-time cost confirm: unlike one-click Q&A, AI play is an agentic
    // loop — a session can fire hundreds of requests on the user's key
    // without further clicks, which is easy to not anticipate.
    if (lsGet(KEYS.AI_PLAY_COST_ACK) !== "1") {
      const ok = await confirmAction({
        title: "Let AI play?",
        body:
          "AI play sends a frame to your endpoint for every move — a session " +
          "can use up to 300 requests on your API key. You can stop it at any time.",
        confirmLabel: "Let it play",
        cancelLabel: "Cancel",
        defaultCancel: true
      });
      if (!ok) return;
      lsSet(KEYS.AI_PLAY_COST_ACK, "1");
      // The panel may have been closed (Esc, ROM load) while the confirm
      // was up — don't start an agent whose status UI is gone.
      if (activeOverlay !== overlay) return;
    }
    activeAbort?.abort(); // cancel any in-flight Q&A
    stopNarration();
    note.hidden = true;
    answer.hidden = false;
    answer.textContent = "🎮 Starting…";
    // The live game animates on the main canvas, so the panel's static
    // capture is redundant (and overlaps it) — hide it while AI is playing.
    frame.hidden = true;
    setPlayMode(true);
    setAiGoal(goalInput.value); // sync the goal from the box at start
    void startAiPlay({
      onStep: ({ step, plan, appliedHint }) => {
        const moves = plan.steps.map((s) => `${s.button} ×${s.frames}`).join(", ");
        const mem = plan.memory ? `\n\n📝 ${plan.memory}` : "";
        answer.textContent = `🎮 Step ${step}: ${moves}\n${plan.reason}${mem}`;
        // The hint was taken into account this decision — clear the 📌 note.
        if (appliedHint) {
          note.hidden = true;
          note.textContent = "";
        }
      },
      onError: (m) => {
        note.hidden = false;
        note.textContent = m;
      },
      onStop: (frameUrl) => {
        setPlayMode(false);
        // Show where the game actually ended up, not the stale open-time
        // capture (and point Q&A at this current frame).
        if (frameUrl) setFrameImage(frameUrl);
        frame.hidden = false;
      }
    });
  });

  input.focus();
}

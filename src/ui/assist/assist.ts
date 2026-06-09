/**
 * "Ask AI about this screen" — sends the current frame + a question to a
 * vision-capable LLM via an OpenAI-compatible chat-completions endpoint,
 * and streams the answer back.
 *
 * Bring-your-own-endpoint: the user configures a base URL + API key +
 * model. That one shape covers OpenAI, OpenRouter, Groq, etc. — and local
 * servers (Ollama / LM Studio), so a privacy-minded user can keep it fully
 * on-device. Off by default; nothing is sent until the user configures it
 * and triggers a query. This is the one feature that talks to a network
 * service, so it's strictly opt-in and clearly labelled in the UI.
 */

import { languageName, READ_ORIGINAL } from "../ocr/languages.js";
import { KEYS, lsGet, lsSet } from "../persistence/local-storage.js";

/** The user's preferred answer language, from the shared "Translate screen
 *  to" setting — `null` for English (the "Don't translate" / unset case).
 *  Used so AI-assist answers and AI-play reasons come back in that language. */
export function preferredAnswerLang(): { code: string; name: string } | null {
  const code = (lsGet(KEYS.TRANSLATE_TARGET) ?? "").trim();
  if (!code || code === READ_ORIGINAL) return null;
  return { code, name: languageName(code) };
}

export interface AssistConfig {
  endpoint: string;
  key: string;
  model: string;
}

/** Read the saved config (empty strings when unset). */
export function getAssistConfig(): AssistConfig {
  return {
    endpoint: (lsGet(KEYS.ASSIST_ENDPOINT) ?? "").trim(),
    key: (lsGet(KEYS.ASSIST_KEY) ?? "").trim(),
    model: (lsGet(KEYS.ASSIST_MODEL) ?? "").trim()
  };
}

export function setAssistConfig(c: AssistConfig): void {
  lsSet(KEYS.ASSIST_ENDPOINT, c.endpoint.trim());
  lsSet(KEYS.ASSIST_KEY, c.key.trim());
  lsSet(KEYS.ASSIST_MODEL, c.model.trim());
}

/** Configured when an endpoint + model are set (a key may be blank for a
 *  local server that doesn't require one). */
export function isAssistConfigured(): boolean {
  const c = getAssistConfig();
  return c.endpoint !== "" && c.model !== "";
}

/** Normalise the base URL to the chat-completions endpoint. Accepts a base
 *  like ".../v1" (appends /chat/completions) or a full completions URL. */
function completionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/+$/, "");
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/** List the models the configured endpoint offers (OpenAI-compatible
 *  `GET /v1/models`), so the UI can present a dropdown instead of a
 *  free-text field. Returns sorted model ids; throws on HTTP/parse error
 *  (the endpoint may not allow browser requests or expose /models). */
export async function listModels(endpoint: string, key: string): Promise<string[]> {
  const base = endpoint.trim().replace(/\/+$/, "");
  if (!base) return [];
  const url = base.endsWith("/models") ? base : `${base}/models`;
  const headers: Record<string, string> = {};
  if (key.trim()) headers["Authorization"] = `Bearer ${key.trim()}`;
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`models request failed (${res.status})`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  return [...new Set((json.data ?? []).map((m) => m.id).filter((id): id is string => !!id))].sort();
}

const SYSTEM_PROMPT =
  "You are a concise, friendly assistant helping someone play a retro Game " +
  "Boy / Game Boy Color / Game Boy Advance game. You are shown the current " +
  "screen. Answer the user's question about it. If they ask what to do, give " +
  "the single most useful next step. Be brief and practical; never invent " +
  "UI that isn't visible. The screen is low-resolution pixel art.";

export interface AskOptions {
  /** data: URL of the captured frame (PNG). */
  imageDataUrl: string;
  /** The user's question (or a default like "What should I do next?"). */
  question: string;
  /** Cart title, for context. */
  gameTitle?: string;
  /** Language name to answer in (e.g. "German"); omit for English. */
  responseLang?: string;
  /** Called with each streamed text chunk. */
  onToken?: (chunk: string) => void;
  signal?: AbortSignal;
}

/** Ask the configured model about the frame. Streams via `onToken` and
 *  resolves with the full text. Throws on config/HTTP/stream errors. */
export async function askAssist(opts: AskOptions): Promise<string> {
  const cfg = getAssistConfig();
  if (!cfg.endpoint || !cfg.model) throw new Error("AI assist is not configured");

  const userText = opts.gameTitle ? `Game: ${opts.gameTitle}\n\n${opts.question}` : opts.question;
  const system = opts.responseLang
    ? `${SYSTEM_PROMPT} Always answer in ${opts.responseLang}, regardless of the language of the question.`
    : SYSTEM_PROMPT;
  const body = {
    model: cfg.model,
    stream: true,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: userText },
          { type: "image_url", image_url: { url: opts.imageDataUrl } }
        ]
      }
    ]
  };

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) headers["Authorization"] = `Bearer ${cfg.key}`;

  const res = await fetch(completionsUrl(cfg.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Assist request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }

  return readSseStream(res.body, opts.onToken);
}

// ─── AI-play (agentic) ────────────────────────────────────────────────────
// Closed-loop control: the model picks the next joypad input from the screen.
// EXPERIMENTAL — latency makes it a "watch the AI attempt to play" novelty,
// best on slow/turn-based games; twitch platformers will flail.

/** The joypad inputs the model may choose, plus "none" (do nothing) and
 *  "rewind" (undo recent moves — to recover from a death/mistake). */
export const PLAY_BUTTONS = [
  "up",
  "down",
  "left",
  "right",
  "a",
  "b",
  "l",
  "r",
  "start",
  "select",
  "none",
  "rewind"
] as const;
export type PlayButton = (typeof PLAY_BUTTONS)[number];

/** One input in a plan: a button held for `frames` frames (clamped 1–60). */
export interface PlayStep {
  button: PlayButton;
  frames: number;
}

/** A short sequence of inputs the model plans per decision (fewer model
 *  calls than one-input-at-a-time → faster + cheaper), plus its reason and
 *  updated scratchpad. */
export interface PlayPlan {
  steps: PlayStep[];
  reason: string;
  /** The model's updated scratchpad — running plan/notes carried forward. */
  memory: string;
}

const PLAY_MAX_STEPS = 5;
const PLAY_SYSTEM =
  "You are playing a retro Game Boy / Game Boy Color / Game Boy Advance game " +
  "by controlling its joypad. You are shown the current screen. Plan the " +
  `next 1-${PLAY_MAX_STEPS} inputs to make progress (toward the player's ` +
  "goal, if one is given). Reply with ONLY a JSON object — no prose, no " +
  'markdown fences — of the form {"steps": [{"button": B, "frames": N}, ...], ' +
  '"reason": R, "memory": M} where each B is one of [' +
  PLAY_BUTTONS.join(", ") +
  `], each N is an integer 1-60 (frames to hold), there are 1-${PLAY_MAX_STEPS} ` +
  "steps, R is a brief reason for the plan, and M is a short running " +
  "scratchpad (your plan and key facts to remember next turn — under ~300 " +
  "characters, updated as you learn). Use button 'none' to wait. If you can " +
  "see a recent move was a mistake — the character died, took a hit, fell, " +
  "or got stuck — return a single step with button 'rewind' to jump back " +
  "several seconds and re-plan; if still in a bad spot after rewinding, " +
  "rewind again. The screen is low-resolution pixel art.";

/** Ask the model for the next plan (a short input sequence) given the
 *  current frame. Non-streaming (we need the whole JSON). Falls back to a
 *  safe wait on parse failure. Throws only on HTTP/config errors. */
export async function askPlan(opts: {
  imageDataUrl: string;
  gameTitle?: string;
  history?: string[];
  /** Live guidance from the player to follow this turn. */
  hint?: string;
  /** Persistent objective the agent should work toward. */
  goal?: string;
  /** The model's scratchpad from the previous turn. */
  memory?: string;
  /** Language name for the `reason` text (e.g. "German"); omit for English. */
  responseLang?: string;
  signal?: AbortSignal;
}): Promise<PlayPlan> {
  const cfg = getAssistConfig();
  if (!cfg.endpoint || !cfg.model) throw new Error("AI assist is not configured");

  // The button value must stay English (parsing depends on it); only the
  // human-readable reason follows the player's language.
  const system = opts.responseLang
    ? `${PLAY_SYSTEM} Write the "reason" value in ${opts.responseLang}; keep "button" in English.`
    : PLAY_SYSTEM;

  const ctx = [
    opts.gameTitle ? `Game: ${opts.gameTitle}` : "",
    opts.goal ? `Your goal: ${opts.goal}` : "",
    opts.memory ? `Your notes so far: ${opts.memory}` : "",
    opts.hint ? `The player is telling you: "${opts.hint}". Follow this guidance.` : "",
    opts.history?.length ? `Recent inputs:\n${opts.history.join("\n")}` : "",
    "Choose the next input."
  ]
    .filter(Boolean)
    .join("\n\n");

  const body = {
    model: cfg.model,
    stream: false,
    messages: [
      { role: "system", content: system },
      {
        role: "user",
        content: [
          { type: "text", text: ctx },
          { type: "image_url", image_url: { url: opts.imageDataUrl } }
        ]
      }
    ]
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (cfg.key) headers["Authorization"] = `Bearer ${cfg.key}`;

  const res = await fetch(completionsUrl(cfg.endpoint), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: opts.signal
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`AI-play request failed (${res.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return parsePlan(json.choices?.[0]?.message?.content ?? "");
}

/** Extract + validate a PlayPlan from the model's text (tolerates markdown
 *  fences / surrounding prose). Returns a safe "wait" plan on any failure. */
function parsePlan(text: string): PlayPlan {
  const safe: PlayPlan = { steps: [{ button: "none", frames: 1 }], reason: "(unparseable response)", memory: "" };
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return safe;
  try {
    const obj = JSON.parse(match[0]) as {
      steps?: { button?: string; frames?: number }[];
      reason?: string;
      memory?: string;
    };
    const steps: PlayStep[] = (obj.steps ?? [])
      .map((s) => ({
        button: (PLAY_BUTTONS as readonly string[]).includes(s.button ?? "") ? (s.button as PlayButton) : "none",
        frames: Math.max(1, Math.min(60, Math.round(Number(s.frames) || 1)))
      }))
      .slice(0, PLAY_MAX_STEPS);
    if (steps.length === 0) steps.push({ button: "none", frames: 1 });
    return { steps, reason: (obj.reason ?? "").slice(0, 200), memory: (obj.memory ?? "").slice(0, 500) };
  } catch {
    return safe;
  }
}

/** Parse an OpenAI-style SSE stream, accumulating `choices[0].delta.content`. */
async function readSseStream(body: ReadableStream<Uint8Array>, onToken?: (chunk: string) => void): Promise<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") continue;
      try {
        const json = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
        const chunk = json.choices?.[0]?.delta?.content;
        if (chunk) {
          full += chunk;
          onToken?.(chunk);
        }
      } catch {
        /* ignore keep-alive / partial lines */
      }
    }
  }
  return full;
}

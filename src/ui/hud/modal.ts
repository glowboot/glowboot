/**
 * Themed replacements for the browser's native `prompt()` and
 * `confirm()` — both of which look out of place against the glass
 * aesthetic, block the main thread, and are untouchable by the focus /
 * Esc plumbing the popover system relies on.
 *
 * One shared overlay is lazily built on first use and reused for every
 * subsequent call; at most one modal can be visible at a time. Opening
 * a second modal while one is active resolves the first one as
 * cancelled — callers don't race each other.
 *
 * Escape, backdrop-click, and the Cancel button all resolve to
 * `null` / `false`. Enter inside the prompt input, or clicking the
 * confirm button, resolves to the value / `true`. Focus moves into
 * the modal on open and returns to the previously-focused element on
 * close.
 */

export interface PromptOpts {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
}

export interface ConfirmOpts {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;

  /** Renders the confirm button with the danger palette — use for
   *  destructive actions (delete, wipe, restart). */
  danger?: boolean;
}

let overlay: HTMLDivElement | null = null;
let activeResolver: ((value: unknown) => void) | null = null;
let previousFocus: HTMLElement | null = null;

function ensureOverlay(): HTMLDivElement {
  if (overlay) return overlay;
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.hidden = true;
  // stopPropagation on every click inside the overlay so a backdrop /
  // button click doesn't bubble to the popover-index document-click
  // handler, which would close an open popover underneath (e.g. the
  // Slots popover hosting the rename action that spawned the modal).
  overlay.addEventListener("click", (e) => {
    e.stopPropagation();
    if (e.target === overlay) dismiss(null);
  });
  document.body.appendChild(overlay);
  return overlay;
}

function dismiss(result: unknown): void {
  if (!overlay || !activeResolver) return;
  const resolver = activeResolver;
  activeResolver = null;
  overlay.hidden = true;
  overlay.innerHTML = "";
  document.removeEventListener("keydown", onKey, { capture: true });
  const prev = previousFocus;
  previousFocus = null;
  if (prev && document.body.contains(prev)) prev.focus();
  resolver(result);
}

function onKey(e: KeyboardEvent): void {
  if (!overlay || overlay.hidden) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    dismiss(null);
    return;
  }
  if (e.key !== "Tab") return;
  const focusables = Array.from(overlay.querySelectorAll<HTMLElement>("input, button")).filter(
    (el) => !el.hasAttribute("disabled")
  );
  if (focusables.length === 0) return;
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const current = document.activeElement;
  if (!overlay.contains(current)) {
    e.preventDefault();
    (e.shiftKey ? last : first).focus();
    return;
  }
  if (e.shiftKey && current === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && current === last) {
    e.preventDefault();
    first.focus();
  }
}

function show(initialFocus: HTMLElement): void {
  if (!overlay) return;
  previousFocus = document.activeElement as HTMLElement | null;
  overlay.hidden = false;
  document.addEventListener("keydown", onKey, { capture: true });
  // Wait a frame so layout settles before moving focus — avoids a
  // flash where the input is focused while still invisible.
  requestAnimationFrame(() => initialFocus.focus());
}

function makeButton(label: string, variant: "neutral" | "primary" | "danger"): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "modal-btn";
  if (variant === "primary") btn.classList.add("modal-btn-primary");
  if (variant === "danger") btn.classList.add("modal-btn-primary", "modal-btn-danger");
  btn.textContent = label;
  return btn;
}

export function promptText(opts: PromptOpts): Promise<string | null> {
  const el = ensureOverlay();
  // If a previous modal is still open, resolve it as cancelled so
  // callers never overlap their resolvers.
  if (activeResolver) dismiss(null);
  return new Promise<string | null>((resolve) => {
    activeResolver = resolve as (value: unknown) => void;
    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const title = document.createElement("h3");
    title.className = "modal-title";
    title.textContent = opts.title;
    panel.appendChild(title);

    if (opts.label) {
      const lab = document.createElement("div");
      lab.className = "modal-label";
      lab.textContent = opts.label;
      panel.appendChild(lab);
    }

    const input = document.createElement("input");
    input.type = "text";
    input.className = "modal-input";
    input.value = opts.value ?? "";
    input.autocomplete = "off";
    input.spellcheck = false;
    if (opts.placeholder) input.placeholder = opts.placeholder;
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        dismiss(input.value);
      }
    });
    panel.appendChild(input);

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = makeButton(opts.cancelLabel ?? "Cancel", "neutral");
    cancelBtn.addEventListener("click", () => dismiss(null));
    const confirmBtn = makeButton(opts.confirmLabel ?? "OK", "primary");
    confirmBtn.addEventListener("click", () => dismiss(input.value));
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    el.innerHTML = "";
    el.appendChild(panel);
    show(input);
    // Select the initial value so retyping replaces it — matches native
    // prompt() behaviour and is the 99% case for renames.
    requestAnimationFrame(() => input.select());
  });
}

export function confirmAction(opts: ConfirmOpts): Promise<boolean> {
  const el = ensureOverlay();
  if (activeResolver) dismiss(null);
  return new Promise<boolean>((resolve) => {
    activeResolver = resolve as (value: unknown) => void;
    const panel = document.createElement("div");
    panel.className = "modal-panel";

    const title = document.createElement("h3");
    title.className = "modal-title";
    title.textContent = opts.title;
    panel.appendChild(title);

    if (opts.body) {
      const body = document.createElement("p");
      body.className = "modal-body";
      body.textContent = opts.body;
      panel.appendChild(body);
    }

    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancelBtn = makeButton(opts.cancelLabel ?? "Cancel", "neutral");
    cancelBtn.addEventListener("click", () => dismiss(false));
    const confirmBtn = makeButton(opts.confirmLabel ?? "OK", opts.danger ? "danger" : "primary");
    confirmBtn.addEventListener("click", () => dismiss(true));
    actions.appendChild(cancelBtn);
    actions.appendChild(confirmBtn);
    panel.appendChild(actions);

    el.innerHTML = "";
    el.appendChild(panel);
    show(confirmBtn);
  });
}

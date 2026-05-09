/**
 * Shared contract for debugger panes.
 *
 * Every tab inside the debugger popover implements this interface.
 * `mount` is called once the first time the pane becomes active —
 * that's where it builds its DOM. `refresh` is called once per
 * rAF tick while the pane is the visible one, and should update
 * whatever fields change frame-to-frame without rebuilding the tree
 * (cheaper + preserves focus / scroll / caret position).
 *
 * Inactive panes are hidden via `container.hidden = true`, not
 * unmounted — so `mount` runs at most once per session.
 */
export interface Pane {
  /** Stable id used in the tab strip + sessionStorage. */
  readonly id: string;
  /** Display name shown on the tab. */
  readonly label: string;
  /** Build the initial DOM into `container`. Called once, when the
   *  user first opens this tab. */
  mount(container: HTMLElement): void;
  /** Update dynamic fields. Called ~60 times / sec while the pane is
   *  the visible one; should avoid rebuilding the DOM tree. No-op
   *  before `mount` has been called. */
  refresh(): void;
}

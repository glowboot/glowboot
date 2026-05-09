import { settingsPop, settingsTrigger } from "../dom.js";
import { createPopover } from "./helper.js";

/**
 * Settings popover open/close — the contents (palette / CRT / theme /
 * volume / mute / touch-mode, plus the Controls editor) are rendered by
 * the modules under `../settings/`. Both attach directly to elements
 * under #settings-pop so this file only owns the outer visibility
 * toggle. No render callback: the DOM is static and wired once at
 * module init by the panel files.
 */

export const { open: openSettings, close: closeSettings } = createPopover({
  trigger: settingsTrigger,
  pop: settingsPop
});

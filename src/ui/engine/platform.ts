/**
 * Platform descriptor — the per-console facts the browser shell branches on
 * (screen size, save-state file extension, ROM extensions, and which optional
 * features the engine supports). One data record per engine, looked up by id,
 * so adding a console (e.g. SNES) is a registry entry plus an adapter factory
 * rather than a new `if (gb) … else if (gba) …` arm at every dispatch site.
 */

export type EngineId = "gb" | "gba" | "nes" | "snes";

/** Which optional UI subsystems an engine participates in. The rom-loader gates
 *  header buttons and accessory wiring on these so an unwired feature shows a
 *  disabled control rather than a broken one. */
export interface EngineCapabilities {
  saveState: boolean;
  saveRam: boolean;
  rewind: boolean;
  library: boolean;
  cheats: boolean;
  debugger: boolean;
  /** GBA L/R shoulder buttons (GB/NES have none). */
  shoulders: boolean;
  /** Any link-cable support (GB serial / GBA SIO). */
  link: boolean;
}

export interface Platform {
  readonly id: EngineId;
  readonly displayName: string;
  readonly screen: { readonly width: number; readonly height: number };
  /** Save-state download extension — `.gbstate` / `.gbastate` / `.nesstate`. */
  readonly stateFileExt: string;
  readonly romExtensions: readonly string[];
  readonly capabilities: EngineCapabilities;
}

export const PLATFORMS: Record<EngineId, Platform> = {
  gb: {
    id: "gb",
    displayName: "Game Boy",
    screen: { width: 160, height: 144 },
    stateFileExt: "gbstate",
    romExtensions: ["gb", "gbc"],
    capabilities: {
      saveState: true,
      saveRam: true,
      rewind: true,
      library: true,
      cheats: true,
      debugger: true,
      shoulders: false,
      link: true
    }
  },
  gba: {
    id: "gba",
    displayName: "Game Boy Advance",
    screen: { width: 240, height: 160 },
    stateFileExt: "gbastate",
    romExtensions: ["gba"],
    capabilities: {
      saveState: true,
      saveRam: true,
      rewind: true,
      library: true,
      cheats: true,
      debugger: true,
      shoulders: true,
      link: true
    }
  },
  snes: {
    id: "snes",
    displayName: "Super Nintendo",
    screen: { width: 256, height: 224 },
    stateFileExt: "snesstate",
    romExtensions: ["sfc", "smc"],
    capabilities: {
      saveState: true,
      saveRam: true,
      rewind: true,
      library: true,
      cheats: true,
      debugger: true,
      shoulders: true,
      link: false
    }
  },
  nes: {
    id: "nes",
    displayName: "NES",
    screen: { width: 256, height: 240 },
    stateFileExt: "nesstate",
    romExtensions: ["nes"],
    capabilities: {
      saveState: true,
      saveRam: true,
      rewind: true,
      library: true,
      cheats: true,
      debugger: true,
      shoulders: false,
      link: false
    }
  }
};

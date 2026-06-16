import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// Absolute path to <project>/src/, computed without Node-only APIs so
// vite.config.ts typechecks without @types/node. URL.pathname strips
// the file:// scheme; this is fine on POSIX (the only supported dev
// platform here).
const SRC_DIR = new URL("./src/", import.meta.url).pathname;

export default defineConfig({
  // Single-page build with `pages/` as the conceptual web root so the
  // project root stays clean (only configs + src/ + pages/).
  //   pages/index.html   →  /   (the emulator)
  //   pages/public/      →  /   (static assets, default publicDir)
  // Deployed to glowboot.pages.dev. Source modules in ../src/ are
  // reached via the `/src/` alias below (HTMLs use absolute /src/...
  // URLs which Vite then redirects to SRC_DIR — relative paths break
  // because `..` from a `/`-served HTML normalises to `/`, which Vite
  // resolves under `root` not above it).
  root: "pages",
  resolve: {
    alias: {
      "/src/": SRC_DIR
    }
  },
  build: {
    // Output one level up so `dist/` ends up at the project root.
    outDir: "../dist",
    emptyOutDir: true
  },
  plugins: [
    VitePWA({
      // Refresh the service worker automatically when a new build is deployed.
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      // Override the dev-mode temp folder name so it sits next to
      // `dist` under a consistent `dist-*` prefix instead of the
      // plugin's default `dev-dist`. URL.pathname resolves relative
      // to this config file → project root.
      devOptions: {
        resolveTempFolder: async () => new URL("./dist-dev", import.meta.url).pathname
      },
      manifest: {
        name: "Glowboot",
        short_name: "Glowboot",
        description: "Glowboot — a Game Boy, Game Boy Color, and Game Boy Advance emulator that runs in your browser.",
        theme_color: "#1a0b3d",
        background_color: "#1a0b3d",
        display: "standalone",
        // Was "portrait" — locked installed PWAs to portrait so the
        // rotate-prompt was unreachable. Now "any": Settings → Controls
        // → Touch → Landscape layout picks the in-app behaviour, and
        // the rotate-prompt only shows when the user has explicitly
        // chosen "Force portrait".
        orientation: "any",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" }
        ],
        // OS-level file association: double-clicking a .gb / .gbc / .gba
        // launches the installed PWA which then receives the file via
        // launchQueue. Reuses an existing window when one is already open
        // (emulator is single-instance — a second ROM replaces the running
        // one).
        file_handlers: [
          {
            action: "/",
            accept: {
              "application/x-gameboy-rom": [".gb"],
              "application/x-gameboy-color-rom": [".gbc"],
              "application/x-gba-rom": [".gba"]
            }
          }
        ],
        launch_handler: { client_mode: "navigate-existing" }
      },
      workbox: {
        // Cache every asset Vite emits so the app runs fully offline after the
        // first visit. ROMs are loaded via the file picker so they aren't part
        // of the precache. No BIOS is shipped — GBA carts run through Glowboot's
        // HLE BIOS in the browser.
        globPatterns: ["**/*.{js,css,html,svg,png,ico,webmanifest}"],
        // The SPA navigation fallback serves index.html for any navigation it
        // can't match. Real files served from the site root aren't precached
        // (robots.txt / sitemap.xml are deliberately not in globPatterns), so
        // without this denylist a browser with the SW installed gets the app
        // shell when navigating to them instead of the file. Let those paths
        // fall through to the network. (Crawlers don't run the SW, so they
        // already fetch the real files.)
        navigateFallbackDenylist: [/^\/robots\.txt$/, /^\/sitemap\.xml$/]
      }
    })
  ]
});

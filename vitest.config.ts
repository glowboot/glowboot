import { defineConfig } from "vitest/config";

// Vitest reads `vite.config.ts` by default, which sets `root: "pages"`
// for the multi-page web build — that makes vitest scan only `pages/`
// for tests and find none. Override the root back to the project root
// so the existing `src/**/*.test.ts` files are discovered.
export default defineConfig({
  test: {
    root: "."
  }
});

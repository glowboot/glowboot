import prettier from "eslint-config-prettier/flat";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import tseslint from "typescript-eslint";

/**
 * Flat ESLint config (v9+). Four layers:
 *   1. typescript-eslint's `recommended` — sensible defaults for TS code.
 *   2. A small overrides block for project-specific preferences (underscore
 *      escape hatch for intentionally unused bindings, etc.).
 *   3. simple-import-sort — auto-orders imports into side-effects → externals
 *      → parent (deeper first) → same-dir groups; auto-fixable. Re-exports
 *      are deliberately NOT sorted so `gb/index.ts`'s topical section
 *      grouping (Cartridge / Display / Input / …) stays intact.
 *   4. eslint-config-prettier — last, disables any stylistic rules that
 *      would fight Prettier. Formatting is Prettier's job; ESLint only
 *      enforces correctness and project conventions.
 */
export default tseslint.config(
  {
    ignores: ["dist/**", "dist-dev/**", "node_modules/**", "public/**"]
  },
  ...tseslint.configs.recommended,
  {
    plugins: {
      "simple-import-sort": simpleImportSort
    },
    rules: {
      // The engine performs a lot of intentional discarded-return calls
      // (e.g. `this.cpu.step()` in constructor wiring); `_`-prefixed
      // identifiers are the project's established "I know this is unused"
      // signal, so exempt them from the unused-bindings check.
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_"
        }
      ],
      // Down-grade from error to warn — fine-grained typing of DOM event
      // payloads etc. isn't worth the churn here.
      "@typescript-eslint/no-explicit-any": "warn",
      "simple-import-sort/imports": "error"
    }
  },
  {
    // Ambient .d.ts files use `declare var` for global shims — that's the
    // canonical TS idiom (matches `lib.dom.d.ts` itself) and is required
    // for the shape to merge cleanly with built-in lib types when both
    // are visible. ESLint's `no-var` doesn't recognise this pattern.
    files: ["**/*.d.ts"],
    rules: {
      "no-var": "off"
    }
  },
  prettier
);

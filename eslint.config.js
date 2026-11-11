import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "dist-action/**", "dist-setup/**", "plugins/*/server/**", "coverage/**", "corpus/**", ".agent-artifacts/**", ".agent-test-workspaces/**", ".proof-tools/**", ".proof-build/**", "src/formal/generated/**"],
  },
  {
    files: ["scripts/*.mjs", "mcp/*.mjs", "test/setup/*.mjs", ".github/extensions/**/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries([
        "AbortSignal", "Buffer", "Headers", "URL", "URLSearchParams", "clearTimeout", "clearInterval", "console", "fetch", "process", "setTimeout", "setInterval",
      ].map((name) => [name, "readonly"])),
    },
  },
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }]
    }
  }
);

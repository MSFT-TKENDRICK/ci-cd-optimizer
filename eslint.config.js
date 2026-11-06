import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    ignores: ["dist/**", "dist-action/**", "dist-setup/**", "coverage/**", "corpus/**"],
  },
  {
    files: ["scripts/*.mjs", "mcp/*.mjs", "test/setup/*.mjs"],
    languageOptions: {
      globals: Object.fromEntries([
        "AbortSignal", "Buffer", "Headers", "URL", "URLSearchParams", "clearTimeout", "console", "fetch", "process", "setTimeout",
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

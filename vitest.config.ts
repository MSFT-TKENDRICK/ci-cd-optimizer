import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const setupUiSource = fileURLToPath(new URL("./ui/setup/src/", import.meta.url));

export default defineConfig({
  // The setup UI imports itself through the "@/" alias declared in ui/setup/tsconfig.json.
  resolve: { alias: [{ find: /^@\//, replacement: setupUiSource }] },
  oxc: { jsx: { runtime: "automatic" } },
  test: {
    projects: [
      { extends: true, test: { name: "service", exclude: [...configDefaults.exclude, "test/setup-ui/**"] } },
      {
        extends: true,
        test: {
          name: "setup-ui",
          include: ["test/setup-ui/**/*.test.{ts,tsx}"],
          environment: "jsdom",
          setupFiles: ["./test/setup-ui/setup.ts"],
        },
      },
    ],
  },
});

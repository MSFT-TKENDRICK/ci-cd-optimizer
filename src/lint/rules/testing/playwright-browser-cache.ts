import { defineRule, jobCommands, stepLine } from "../helpers.js";
import { cacheCovers } from "../caching/shared.js";
import { toolInvocation } from "./shared.js";

const PLAYWRIGHT = new Set(["playwright"]);
const PLAYWRIGHT_IMAGE = /(^|\/)mcr\.microsoft\.com\/playwright(\/|:|$)/i;

export default defineRule({
  meta: {
    id: "testing/playwright-browser-cache",
    ruleset: "testing",
    description: "Jobs that download Playwright browsers should cache them or run in the Playwright container image.",
    rationale:
      "`playwright install` downloads several hundred megabytes of browser builds on every run. Restoring ~/.cache/ms-playwright keyed on the Playwright version (or using the image that ships the browsers) turns that download into a cache hit.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: {},
    references: [
      "https://playwright.dev/docs/ci",
      "https://playwright.dev/docs/browsers#managing-browser-binaries",
      "https://github.com/actions/cache",
    ],
    impact: "medium",
    example: {
      bad: "- run: npm ci\n- run: npx playwright install --with-deps\n- run: npx playwright test",
      good:
        "- run: npm ci\n- uses: actions/cache@v4\n  with:\n    path: ~/.cache/ms-playwright\n    key: playwright-${{ runner.os }}-${{ hashFiles('package-lock.json') }}\n- run: npx playwright install --with-deps\n- run: npx playwright test",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const install = jobCommands(project, workflow, job).find((entry) => {
          const words = toolInvocation(entry.command, PLAYWRIGHT);
          return words?.[1] === "install" && !words.slice(2).some((word) => word === "--help" || word === "--dry-run");
        });
        if (!install) continue;
        const image = job.containerImage;
        if (image && (image.kind !== "literal" || PLAYWRIGHT_IMAGE.test(image.value))) continue;
        const all = project.expandedSteps(job);
        if (cacheCovers(all, /ms-playwright|playwright/i, /playwright/i)) continue;
        const browsersPath = [workflow.env, job.env, ...all.map((step) => step.env)].some((env) => "PLAYWRIGHT_BROWSERS_PATH" in env);
        if (browsersPath && cacheCovers(all, /./)) continue;
        if (all.some((step) => step.uses?.action.kind === "remote" && /playwright/i.test(step.uses.action.name ?? ""))) continue;
        report({
          path: workflow.path,
          line: install.direct ? install.line : stepLine(install.owner),
          key: `${job.key}:playwright-install`,
          message: "Playwright browsers are downloaded on every run without a cache.",
          suggestion:
            "Cache ~/.cache/ms-playwright (%USERPROFILE%\\AppData\\Local\\ms-playwright on Windows) with actions/cache keyed on the Playwright version and run `playwright install` (or only `install-deps` on a hit), or run the job in the mcr.microsoft.com/playwright container image.",
        });
      }
    }
  },
});

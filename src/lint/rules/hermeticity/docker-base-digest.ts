import { defineRule } from "../helpers.js";
import { imagePinProblem } from "./images.js";

export default defineRule({
  meta: {
    id: "hermeticity/docker-base-digest",
    ruleset: "hermeticity",
    description: "Dockerfile base images should use pinned versions (and digests when required).",
    rationale:
      "`FROM image` or `FROM image:latest` silently changes whenever upstream publishes, which breaks reproducibility and invalidates the layer cache for every following instruction. A version tag makes upgrades explicit; a digest makes builds fully reproducible.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { requireDigest: false },
    validateOptions: (options) =>
      "requireDigest" in options && typeof options.requireDigest !== "boolean" ? ["requireDigest must be a boolean"] : [],
    references: [
      "https://docs.docker.com/build/building/best-practices/#pin-base-image-versions",
      "https://docs.docker.com/reference/dockerfile/#from",
      "https://github.com/ossf/scorecard/blob/main/docs/checks.md#pinned-dependencies",
    ],
    impact: "medium",
    example: { bad: "FROM node", good: "FROM node:22.20-bookworm-slim" },
  },
  check({ project, options, report }) {
    for (const dockerfile of project.dockerfiles) {
      const stageNames = new Set<string>();
      for (const stage of dockerfile.stages) {
        const from = dockerfile.instructions.find((instruction) => instruction.keyword === "FROM" && instruction.line === stage.line);
        const reference = from?.args.split(/\s+/)[0] ?? "";
        const known = reference !== "" && !reference.includes("$") && reference.toLowerCase() !== "scratch" && !stageNames.has(reference.toLowerCase());
        if (stage.name) stageNames.add(stage.name.toLowerCase());
        if (!known) continue;
        const problem = imagePinProblem(reference, options.requireDigest, "Base image");
        if (!problem) continue;
        report({
          path: dockerfile.path,
          line: stage.line,
          key: `stage[${stage.index}]`,
          message: problem.message,
          suggestion: problem.suggestion,
        });
      }
    }
  },
});

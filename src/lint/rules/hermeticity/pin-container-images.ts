import type { Sourced } from "../../parsers/workflow.js";
import { defineRule } from "../helpers.js";
import { imagePinProblem } from "./images.js";

export default defineRule({
  meta: {
    id: "hermeticity/pin-container-images",
    ruleset: "hermeticity",
    description: "Job containers and service containers should use pinned image versions.",
    rationale:
      "Untagged and latest-tag images can change between runs when registry tags move. Version tags communicate upgrade intent but can also move. A digest pins the referenced image content; it does not establish reproducibility of the full job or of mutable external dependencies.",
    kind: "practice",
    defaultSeverity: "warn",
    presets: ["recommended", "agentic", "strict"],
    requires: [],
    defaultOptions: { requireDigest: false },
    validateOptions: (options) =>
      "requireDigest" in options && typeof options.requireDigest !== "boolean" ? ["requireDigest must be a boolean"] : [],
    references: [
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idcontainerimage",
      "https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idservicesservice_idimage",
      "https://docs.docker.com/reference/cli/docker/image/pull/#pull-an-image-by-digest-immutable-identifier",
    ],
    impact: "medium",
    example: {
      bad: "services:\n  db:\n    image: postgres",
      good: "services:\n  db:\n    image: postgres:17.6",
    },
  },
  check({ project, options, report }) {
    for (const workflow of project.workflows) {
      for (const job of workflow.jobs) {
        const images: Array<{ image: Sourced<string>; key: string; subject: string }> = [
          ...(job.containerImage ? [{ image: job.containerImage, key: `${job.key}.container`, subject: "Job container image" }] : []),
          ...job.services.map((service) => ({
            image: service.image,
            key: `${job.key}.services.${service.name}`,
            subject: `Service \`${service.name}\` image`,
          })),
        ];
        for (const { image, key, subject } of images) {
          if (image.kind !== "literal") continue;
          const reference = image.value.trim().replace(/^docker:\/\//, "");
          if (reference === "") continue;
          const problem = imagePinProblem(reference, options.requireDigest, subject);
          if (!problem) continue;
          report({ path: workflow.path, line: image.line, key, message: problem.message, suggestion: problem.suggestion });
        }
      }
    }
  },
});

import { isMap, isScalar, type Node, type Pair, type YAMLMap } from "yaml";
import { fix, lineStart, lineText } from "../../fix.js";
import { lineOfNode } from "../../parsers/yaml.js";
import type { WorkflowModel } from "../../parsers/workflow.js";
import type { SourceFile } from "../../types.js";
import { defineRule } from "../helpers.js";
import { isPositionIndependent, jobNode, nestedPair, rawScalar, stepNode } from "./shared.js";

interface Entry {
  /** The `env` map the pair lives in. */
  map: YAMLMap;
  /** The `env:` pair that holds the map. */
  owner: Pair | undefined;
  pair: Pair;
  raw: string;
  line: number;
}

function entry(workflow: WorkflowModel, file: SourceFile, parent: unknown, key: string): Entry | undefined {
  const found = nestedPair(parent, "env", key);
  if (!found || !isScalar(found.pair.value)) return undefined;
  const raw = rawScalar(file.content, found.pair.value);
  if (raw === undefined) return undefined;
  const owner = isMap(parent) ? parent.items.find((item) => item.value === found.map) : undefined;
  return { map: found.map, owner, pair: found.pair, raw, line: lineOfNode(workflow.source, found.pair.key as Node) };
}

/** Deletes a single-line `KEY: value` from a block map, plus the `env:` line when it was the only entry. */
function removal(workflow: WorkflowModel, file: SourceFile, inner: Entry) {
  if (inner.map.flow) return undefined;
  const value = inner.pair.value;
  if (!isScalar(value) || !value.range) return undefined;
  if (lineOfNode(workflow.source, value) !== inner.line) return undefined;
  const valueEnd = workflow.source.lineCounter.linePos(value.range[1]).line;
  if (valueEnd !== inner.line) return undefined;
  let start = lineStart(file.content, inner.line);
  if (inner.map.items.length === 1) {
    const ownerLine = inner.owner ? lineOfNode(workflow.source, inner.owner.key as Node) : 0;
    if (ownerLine !== inner.line - 1 || !/^\s*env:\s*(?:#.*)?$/.test(lineText(file.content, ownerLine))) return undefined;
    start = lineStart(file.content, ownerLine);
  }
  return fix(`Remove duplicate env ${String((inner.pair.key as { value?: unknown }).value)}`, {
    path: file.path,
    start,
    end: lineStart(file.content, inner.line + 1),
    text: "",
  });
}

export default defineRule({
  meta: {
    id: "redundancy/shadowed-env",
    ruleset: "redundancy",
    description: "A job or step should not redefine an environment variable to the value it already inherits.",
    rationale:
      "Workflow-level `env` is inherited by every job and step. Repeating the same `KEY: value` lower down adds noise and creates a second copy that must be changed in lockstep; when only one copy is updated, the inner one silently wins.",
    kind: "practice",
    defaultSeverity: "info",
    presets: ["recommended", "strict"],
    requires: [],
    defaultOptions: {},
    references: ["https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#env"],
    impact: "low",
    fixable: true,
    example: {
      bad: "env:\n  NODE_ENV: test\njobs:\n  test:\n    env:\n      NODE_ENV: test",
      good: "env:\n  NODE_ENV: test\njobs:\n  test:\n    runs-on: ubuntu-24.04",
    },
  },
  check({ project, report }) {
    for (const workflow of project.workflows) {
      const file = project.files.get(workflow.path);
      if (!file) continue;
      const root = workflow.source.doc.contents;
      const check = (outer: Entry | undefined, inner: Entry | undefined, scope: string, key: string, reportKey: string) => {
        if (!outer || !inner || outer.raw !== inner.raw) return;
        const edit = removal(workflow, file, inner);
        report({
          path: workflow.path,
          line: inner.line,
          key: reportKey,
          message: `${scope} sets ${key}=${inner.raw}, which it already inherits from line ${outer.line}.`,
          suggestion: `Remove the inner \`${key}\` entry and rely on the inherited value.`,
          related: [{ path: workflow.path, line: outer.line }],
          ...(edit ? { fix: edit } : {}),
        });
      };
      for (const job of workflow.jobs) {
        if (job.uses) continue;
        const node = jobNode(workflow, job);
        if (!node) continue;
        for (const [key, value] of Object.entries(job.env)) {
          if (!Object.hasOwn(workflow.env, key) || !isPositionIndependent(value)) continue;
          check(entry(workflow, file, root, key), entry(workflow, file, node, key), `Job "${job.id}"`, key, `${job.key}.env.${key}`);
        }
        let writesEnv = false;
        for (const step of job.steps) {
          if (!writesEnv) {
            const target = stepNode(workflow, step);
            for (const [key, value] of Object.entries(step.env)) {
              if (!isPositionIndependent(value)) continue;
              const outer = Object.hasOwn(job.env, key)
                ? entry(workflow, file, node, key)
                : Object.hasOwn(workflow.env, key)
                  ? entry(workflow, file, root, key)
                  : undefined;
              if (!outer || !target) continue;
              check(outer, entry(workflow, file, target, key), `Step ${step.index + 1} of job "${job.id}"`, key, `${step.key}.env.${key}`);
            }
          }
          // Earlier `$GITHUB_ENV` writes change the inherited value, so later step-level env may be deliberate.
          if (step.run && /GITHUB_ENV/.test(step.run.value)) writesEnv = true;
        }
      }
    }
  },
});

import { isSeq } from "yaml";
import type { SourceFile } from "../types.js";
import { entries, field, isMapNode, items, parseErrors, parseYaml, resolveNode, scalarValue, stringValue } from "./yaml.js";

export const ACTIONS_LOCK_PATH = ".github/workflows/actions.lock";

export interface ActionsLockIssue {
  line: number;
  message: string;
}

export interface ActionsLockModel {
  issues: ActionsLockIssue[];
  workflows: Map<string, { line: number; dependencies: Set<string> }>;
  dependencies: Set<string>;
}

function isPositiveId(value: unknown): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

export function normalizeActionRef(value: string): string {
  const separator = value.lastIndexOf("@");
  if (separator < 0) return value.toLowerCase();
  return `${value.slice(0, separator).toLowerCase()}@${value.slice(separator + 1)}`;
}

export function parseActionsLock(file: SourceFile): ActionsLockModel {
  const source = parseYaml(file.path, file.content);
  const issues: ActionsLockIssue[] = parseErrors(source);
  const workflows = new Map<string, { line: number; dependencies: Set<string> }>();
  const dependencies = new Set<string>();
  const root = source.doc.contents;

  if (issues.length > 0) return { issues, workflows, dependencies };
  if (!isMapNode(root)) {
    issues.push({ line: 1, message: "The actions lockfile must be a YAML mapping." });
    return { issues, workflows, dependencies };
  }

  if (!stringValue(field(source, root, "version")?.value)) {
    issues.push({ line: 1, message: "The actions lockfile must declare a non-empty `version`." });
  }

  const workflowField = field(source, root, "workflows");
  if (!workflowField || !isMapNode(workflowField.value)) {
    issues.push({ line: workflowField?.line ?? 1, message: "The actions lockfile must contain a `workflows` mapping." });
  } else {
    for (const entry of entries(source, workflowField.value)) {
      const sequence = resolveNode(source, entry.value).node;
      if (!isSeq(sequence)) {
        issues.push({ line: entry.line, message: `Lock entry for workflow \`${entry.key}\` must be a list of action references.` });
        continue;
      }

      const refs = new Set<string>();
      for (const item of items(source, sequence)) {
        const ref = stringValue(item);
        if (!ref) {
          issues.push({ line: entry.line, message: `Lock entry for workflow \`${entry.key}\` contains a non-string action reference.` });
          continue;
        }
        refs.add(normalizeActionRef(ref));
      }
      workflows.set(entry.key, { line: entry.line, dependencies: refs });
    }
  }

  const dependencyField = field(source, root, "dependencies");
  if (!dependencyField || !isMapNode(dependencyField.value)) {
    issues.push({ line: dependencyField?.line ?? 1, message: "The actions lockfile must contain a `dependencies` mapping." });
  } else {
    for (const entry of entries(source, dependencyField.value)) {
      if (!isMapNode(entry.value)) {
        issues.push({ line: entry.line, message: `Dependency \`${entry.key}\` must have a metadata mapping.` });
        continue;
      }

      const ref = stringValue(field(source, entry.value, "ref")?.value);
      const commit = stringValue(field(source, entry.value, "commit")?.value);
      const ownerId = scalarValue(field(source, entry.value, "owner_id")?.value);
      const repoId = scalarValue(field(source, entry.value, "repo_id")?.value);
      const separator = entry.key.lastIndexOf("@");
      if (
        separator <= 0 ||
        !ref ||
        entry.key.slice(separator + 1) !== ref ||
        !commit ||
        !/^sha1-[0-9a-f]{40}$/i.test(commit) ||
        !isPositiveId(ownerId) ||
        !isPositiveId(repoId)
      ) {
        issues.push({
          line: entry.line,
          message: `Dependency \`${entry.key}\` must include a ref, a sha1 commit, and positive owner_id/repo_id values.`,
        });
        continue;
      }
      dependencies.add(normalizeActionRef(entry.key));
    }
  }

  return { issues, workflows, dependencies };
}

export function isActionLockCovered(
  lock: ActionsLockModel | undefined,
  workflowPath: string,
  actionRef: string,
): boolean {
  if (!lock || lock.issues.length > 0) return false;
  const workflow = lock.workflows.get(workflowPath);
  const normalizedRef = normalizeActionRef(actionRef);
  return workflow?.dependencies.has(normalizedRef) === true && lock.dependencies.has(normalizedRef);
}

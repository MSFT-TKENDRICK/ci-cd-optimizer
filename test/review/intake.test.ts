import { describe, expect, it } from "vitest";
import {
  classifyPullFiles,
  INTAKE_ARTIFACT_MAX_BYTES,
  MAX_OPEN_SUBMISSIONS_PER_AUTHOR,
  parseIntakeArtifact,
  runIntake,
  serializeIntakeArtifact,
} from "../../src/review/intake.js";
import { BASE_SHA, HEAD_SHA, NEW_HEAD_SHA, PROJECT_PATH, PROJECT_YAML, pull, REGISTRY, REGISTRY_NAME, STRICT_PROJECT_YAML, submitted, TARGET_SHA, world } from "./fixtures.js";

describe("classifyPullFiles", () => {
  it("accepts exactly one added or modified project.yaml", () => {
    expect(classifyPullFiles([{ filename: PROJECT_PATH, status: "added" }], 1)).toEqual({ kind: "submission", name: "widget", path: PROJECT_PATH, status: "added" });
    expect(classifyPullFiles([{ filename: PROJECT_PATH, status: "modified" }])).toMatchObject({ kind: "submission", status: "modified" });
  });

  it("treats removing a project.yaml as an opt-out", () => {
    expect(classifyPullFiles([{ filename: PROJECT_PATH, status: "removed" }], 1)).toEqual({ kind: "opt-out", name: "widget", path: PROJECT_PATH });
  });

  it("ignores pull requests that do not touch project data", () => {
    expect(classifyPullFiles([{ filename: "src/index.ts", status: "modified" }], 1)).toEqual({ kind: "none" });
    expect(classifyPullFiles([{ filename: "projects/schema.json", status: "modified" }, { filename: "projects/README.md", status: "modified" }], 2)).toEqual({ kind: "none" });
  });

  it("refuses to decide when the file list was truncated", () => {
    const result = classifyPullFiles([{ filename: "src/index.ts", status: "modified" }], 3001);
    expect(result.kind).toBe("invalid");
    expect(JSON.stringify(result)).toContain("only 1 could be listed");
  });

  it.each([
    ["two projects", [{ filename: PROJECT_PATH, status: "added" }, { filename: "projects/gadget/project.yaml", status: "added" }], "must change exactly one file"],
    ["a file outside the project directory", [{ filename: PROJECT_PATH, status: "added" }, { filename: ".github/workflows/ci.yml", status: "modified" }], "must change exactly one file"],
    ["a hidden extra file", [{ filename: PROJECT_PATH, status: "added" }], "must change exactly one file", 2],
    ["path traversal", [{ filename: "projects/../.github/workflows/project.yaml", status: "added" }], "is not a valid submission path"],
    ["a nested directory", [{ filename: "projects/widget/sub/project.yaml", status: "added" }], "is not a valid submission path"],
    ["another file in a project", [{ filename: "projects/widget/build.sh", status: "added" }], "is not a valid submission path"],
    ["a project.yml spelling", [{ filename: "projects/widget/project.yml", status: "added" }], "is not a valid submission path"],
    ["an uppercase name", [{ filename: "projects/Widget/project.yaml", status: "added" }], "is not a valid submission path"],
    ["an uppercase registry directory", [{ filename: "Projects/widget/project.yaml", status: "added" }], "is not a valid submission path"],
    ["a file at the projects root", [{ filename: "projects/evil.yaml", status: "added" }], "is not a valid submission path"],
    ["a rename", [{ filename: PROJECT_PATH, status: "renamed", previous_filename: "projects/old/project.yaml" }], "Renaming a project is not supported"],
    ["a rename into the registry", [{ filename: PROJECT_PATH, status: "renamed", previous_filename: "notes.yaml" }], "Renaming a project is not supported"],
    ["a rename out of the registry", [{ filename: "notes.yaml", status: "renamed", previous_filename: PROJECT_PATH }], "is not a valid submission path"],
    ["a copy", [{ filename: PROJECT_PATH, status: "copied" }], "Unsupported change type"],
  ])("rejects %s", (_label, files, expected, changedFiles?: number) => {
    const result = classifyPullFiles(files, changedFiles);
    expect(result.kind).toBe("invalid");
    expect(result.kind === "invalid" && result.problems.join("\n")).toContain(expected);
  });
});

describe("intake artifact", () => {
  const good = serializeIntakeArtifact({ pr_number: 7, head_sha: HEAD_SHA });

  it("round-trips the canonical record", () => {
    expect(good).toBe(`{"pr_number":7,"head_sha":"${HEAD_SHA}"}`);
    expect(parseIntakeArtifact(`${good}\n`, HEAD_SHA)).toEqual({ artifact: { pr_number: 7, head_sha: HEAD_SHA }, problems: [] });
  });

  it.each([
    ["oversize", `${good}${" ".repeat(INTAKE_ARTIFACT_MAX_BYTES)}`, HEAD_SHA, `larger than ${INTAKE_ARTIFACT_MAX_BYTES} bytes`],
    ["a bad expected SHA", good, "HEAD", "expected head SHA must be 40 lowercase hex"],
    ["invalid JSON", "{pr_number: 7}", HEAD_SHA, "not valid JSON"],
    ["an array", "[7]", HEAD_SHA, "must be a JSON object"],
    ["null", "null", HEAD_SHA, "must be a JSON object"],
    ["extra keys", `{"pr_number":7,"head_sha":"${HEAD_SHA}","cmd":"x"}`, HEAD_SHA, "exactly pr_number and head_sha"],
    ["a missing key", `{"pr_number":7}`, HEAD_SHA, "exactly pr_number and head_sha"],
    ["a string pr_number", `{"pr_number":"7","head_sha":"${HEAD_SHA}"}`, HEAD_SHA, "pr_number must be a positive integer"],
    ["a zero pr_number", `{"pr_number":0,"head_sha":"${HEAD_SHA}"}`, HEAD_SHA, "pr_number must be a positive integer"],
    ["a fractional pr_number", `{"pr_number":7.5,"head_sha":"${HEAD_SHA}"}`, HEAD_SHA, "pr_number must be a positive integer"],
    ["an unsafe pr_number", `{"pr_number":9007199254740993,"head_sha":"${HEAD_SHA}"}`, HEAD_SHA, "pr_number must be a positive integer"],
    ["a non-hex SHA", `{"pr_number":7,"head_sha":"${"g".repeat(40)}"}`, HEAD_SHA, "head_sha must be 40 lowercase hex"],
    ["an uppercase SHA", `{"pr_number":7,"head_sha":"${"A".repeat(40)}"}`, HEAD_SHA, "head_sha must be 40 lowercase hex"],
    ["a short SHA", `{"pr_number":7,"head_sha":"${HEAD_SHA.slice(0, 7)}"}`, HEAD_SHA, "head_sha must be 40 lowercase hex"],
    ["a non-canonical record", `{"head_sha":"${HEAD_SHA}","pr_number":7}`, HEAD_SHA, "not in canonical form"],
    ["an exponent pr_number", `{"pr_number":7e0,"head_sha":"${HEAD_SHA}"}`, HEAD_SHA, "not in canonical form"],
    ["a SHA mismatch", good, NEW_HEAD_SHA, "names a different commit"],
  ])("rejects %s", (_label, text, expected, message) => {
    const result = parseIntakeArtifact(text, expected);
    expect(result.artifact).toBeUndefined();
    expect(result.problems.join("\n")).toContain(message);
  });
});

const intake = (spec: Parameters<typeof world>[0] = {}, options: { headSha?: string; maxOpenPerAuthor?: number } = {}) => {
  const client = world({ registryFiles: submitted(), ...spec });
  return { client, result: runIntake(client, REGISTRY, { pr: 7, registry: REGISTRY_NAME, ...options }) };
};

describe("runIntake", () => {
  it("reviews a valid submission in public mode and hands off a canonical artifact", async () => {
    const { client, result } = intake({ registryFiles: submitted(STRICT_PROJECT_YAML) }, { headSha: HEAD_SHA });
    const outcome = await result;
    expect(outcome).toMatchObject({ kind: "submission", name: "widget", author: "octocat", exitCode: 0, artifact: { pr_number: 7, head_sha: HEAD_SHA } });
    expect(outcome.report?.status).toBe("ok");
    expect(outcome.report?.redacted.rules).toContain("hermeticity/pin-actions");
    expect(outcome.report?.findings.some((finding) => finding.ruleId === "hermeticity/pin-actions")).toBe(false);
    expect(outcome.report?.findings.length).toBeGreaterThan(0);
    expect(outcome.markdown).toContain("<!-- ci-cd-optimizer-review:widget -->");
    expect(outcome.markdown).not.toContain("actions/checkout");
    const projectRead = client.calls.find((call) => call.parameters.path === PROJECT_PATH && call.parameters.ref === HEAD_SHA);
    expect(projectRead?.parameters).toMatchObject({ owner: REGISTRY.owner, repo: REGISTRY.repo });
    expect(client.calls.filter((call) => call.route === "GET /repos/{owner}/{repo}/pulls/{pull_number}")).toHaveLength(2);
    // Every write is explicit: intake itself never comments.
    expect(client.calls.some((call) => !call.route.startsWith("GET "))).toBe(false);
  });

  it("falls back to the fork for the head blob", async () => {
    const { result } = intake({ registryFiles: { [`${HEAD_SHA}:${PROJECT_PATH}`]: PROJECT_YAML } });
    await expect(result).resolves.toMatchObject({ kind: "submission", exitCode: 0 });
  });

  it("rejects a run whose head moved before it started", async () => {
    const outcome = await intake({}, { headSha: NEW_HEAD_SHA }).result;
    expect(outcome).toMatchObject({ kind: "invalid", exitCode: 1 });
    expect(outcome.markdown).toContain(`moved to ${HEAD_SHA.slice(0, 12)}`);
    expect(outcome.artifact).toBeUndefined();
  });

  it("rejects a head that moves while the file list is read", async () => {
    const outcome = await intake({ pulls: [pull(), pull({ head: { sha: NEW_HEAD_SHA } })] }).result;
    expect(outcome).toMatchObject({ kind: "invalid", exitCode: 1, headSha: NEW_HEAD_SHA });
    expect(outcome.markdown).toContain("moved to");
  });

  it("rejects incomplete pull request metadata", async () => {
    const outcome = await intake({ pulls: [pull({ head: { sha: "nope" } })] }).result;
    expect(outcome).toMatchObject({ exitCode: 1, markdown: "Pull request metadata is incomplete.\n" });
  });

  it("does nothing for ordinary pull requests", async () => {
    const outcome = await intake({ pullFiles: [{ filename: "src/index.ts", status: "modified" }] }).result;
    expect(outcome).toMatchObject({ kind: "none", exitCode: 0 });
  });

  it("explains invalid file lists", async () => {
    const outcome = await intake({ pullFiles: [{ filename: PROJECT_PATH, status: "added" }, { filename: "README.md", status: "modified" }], pulls: [pull({ changed_files: 2 })] }).result;
    expect(outcome).toMatchObject({ kind: "invalid", exitCode: 1, name: "widget" });
    expect(outcome.markdown).toContain("must change exactly one file");
  });

  it("refuses submissions from bots and organizations", async () => {
    const outcome = await intake({ pulls: [pull({ user: { login: "octocat", type: "Bot" } })] }).result;
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.problems.join("\n")).toContain("must be opened by a GitHub user account");
  });

  it("caps open submissions per author", async () => {
    const openPulls = [11, 12, 13].map((number) => pull({ number, user: { login: "OctoCat", type: "User" } }));
    const otherPullFiles = Object.fromEntries([11, 12, 13].map((number) => [number, [{ filename: `projects/p${number}/project.yaml`, status: "added" }]]));
    const outcome = await intake({ openPulls: [pull(), ...openPulls, pull({ number: 14, user: { login: "someone", type: "User" } })], otherPullFiles }).result;
    expect(MAX_OPEN_SUBMISSIONS_PER_AUTHOR).toBe(3);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.report?.problems.join("\n")).toContain("already has 3 other open submission pull requests; the limit is 3");
  });

  it("does not count the author's unrelated pull requests", async () => {
    const openPulls = [11, 12, 13].map((number) => pull({ number }));
    const outcome = await intake({ openPulls, otherPullFiles: { 11: [{ filename: "src/a.ts", status: "modified" }] } }).result;
    expect(outcome.exitCode).toBe(0);
  });

  it("reports a project file missing at the head", async () => {
    const outcome = await intake({ registryFiles: {} }).result;
    expect(outcome.report?.problems.join("\n")).toContain("was not found at the pull request head");
  });

  it("reports schema problems in the submitted file", async () => {
    const outcome = await intake({ registryFiles: submitted("name: widget\nmain_repo: http://github.com/octo-org/widget\n") }).result;
    expect(outcome).toMatchObject({ exitCode: 1 });
    expect(outcome.report?.status).toBe("invalid");
    expect(outcome.report?.problems.join("\n")).toContain("main_repo must be exactly");
  });

  it("rejects a submitter who is not a consent contact", async () => {
    const outcome = await intake({ pulls: [pull({ user: { login: "mallory", type: "User" } })] }).result;
    expect(outcome.report?.status).toBe("consent-failed");
    expect(outcome.report?.findings).toEqual([]);
    expect(outcome.exitCode).toBe(1);
  });

  describe("changes to an existing project", () => {
    const base = { [`${BASE_SHA}:${PROJECT_PATH}`]: PROJECT_YAML };

    it("keeps repository_id immutable", async () => {
      const changed = PROJECT_YAML.replace("repository_id: 4242", "repository_id: 4243");
      const outcome = await intake({ pullFiles: [{ filename: PROJECT_PATH, status: "modified" }], registryFiles: { ...base, ...submitted(changed) } }).result;
      expect(outcome.report?.problems.join("\n")).toContain("repository_id is immutable");
    });

    it("lets only current contacts change it", async () => {
      const changed = PROJECT_YAML.replace("primary_contact: octocat", "primary_contact: mallory").replace("[hubot]", "[octocat]");
      const outcome = await intake({
        pulls: [pull({ user: { login: "mallory", type: "User" } })],
        pullFiles: [{ filename: PROJECT_PATH, status: "modified" }],
        registryFiles: { ...base, ...submitted(changed) },
      }).result;
      expect(outcome.report?.problems.join("\n")).toContain("Only the project's current primary_contact or auto_ccs may change");
    });

    it("accepts a change by an auto_cc", async () => {
      const changed = `${PROJECT_YAML}language: typescript\n`;
      const outcome = await intake({
        pulls: [pull({ user: { login: "HUBOT", type: "User" } })],
        pullFiles: [{ filename: PROJECT_PATH, status: "modified" }],
        registryFiles: { ...base, ...submitted(changed) },
      }).result;
      expect(outcome).toMatchObject({ kind: "submission", exitCode: 0 });
    });

    it("accepts an opt-out from a contact without reviewing the target", async () => {
      const { client, result } = intake({ pullFiles: [{ filename: PROJECT_PATH, status: "removed" }], registryFiles: base });
      const outcome = await result;
      expect(outcome).toMatchObject({ kind: "opt-out", exitCode: 0 });
      expect(outcome.markdown).toContain("Opt-out request");
      expect(outcome.report?.notes.join("\n")).toContain("opts the project out");
      expect(client.calls.some((call) => call.route === "GET /repositories/{repository_id}")).toBe(false);
      expect(client.calls.some((call) => call.parameters.ref === TARGET_SHA)).toBe(false);
    });

    it("rejects an opt-out from someone else", async () => {
      const outcome = await intake({
        pulls: [pull({ user: { login: "mallory", type: "User" } })],
        pullFiles: [{ filename: PROJECT_PATH, status: "removed" }],
        registryFiles: base,
      }).result;
      expect(outcome).toMatchObject({ kind: "opt-out", exitCode: 1 });
      expect(outcome.report?.problems.join("\n")).toContain("Only the project's primary_contact or auto_ccs may remove it");
    });
  });
});

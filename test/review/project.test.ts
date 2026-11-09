import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseMainRepo, parseProjectText, parseStrictYaml, PROJECT_MAX_BYTES } from "../../src/review/project.js";
import { PROJECT_YAML } from "./fixtures.js";

const problemsOf = (text: string, directory = "widget") => parseProjectText(text, directory).problems.join("\n");

describe("project.yaml parsing", () => {
  it("accepts a valid project and normalizes optional fields", () => {
    const parsed = parseProjectText(`${PROJECT_YAML}security_contact: security@octo.example\nlanguage: c++\npreset: strict\npaused: false\n`, "widget");
    expect(parsed.problems).toEqual([]);
    expect(parsed.project).toMatchObject({
      name: "widget",
      mainRepo: { owner: "octo-org", repo: "widget", fullName: "octo-org/widget" },
      repositoryId: 4242,
      primaryContact: "octocat",
      autoCcs: ["hubot"],
      preset: "strict",
      paused: false,
    });
  });

  it("rejects alias bombs without expanding them", () => {
    const lines = ['a: &a ["x","x","x","x","x","x","x","x","x"]'];
    for (let i = 1; i < 9; i++) lines.push(`${String.fromCharCode(97 + i)}: &${String.fromCharCode(97 + i)} [*${String.fromCharCode(96 + i)},*${String.fromCharCode(96 + i)},*${String.fromCharCode(96 + i)}]`);
    const problems = problemsOf(`${PROJECT_YAML}${lines.join("\n")}\n`);
    expect(problems).toContain("must not use YAML aliases");
    expect(problems).toContain("must not use YAML anchors");
  });

  it("rejects anchors, merge keys, and tags", () => {
    expect(problemsOf(`${PROJECT_YAML}language: &lang go\n`)).toContain("must not use YAML anchors (&name)");
    expect(problemsOf(`${PROJECT_YAML}<<: {paused: true}\n`)).toContain("must not use YAML merge keys (<<)");
    expect(problemsOf(`${PROJECT_YAML}language: !!str go\n`)).toContain("must not use YAML tags");
    expect(problemsOf(`${PROJECT_YAML}language: !custom go\n`)).toContain("must not use YAML tags");
    expect(problemsOf(`${PROJECT_YAML}language: !<tag:yaml.org,2002:js/function> go\n`)).toContain("must not use YAML tags");
  });

  it("rejects unknown keys, non-string keys, and non-mapping documents", () => {
    expect(problemsOf(`${PROJECT_YAML}homepage: https://example.com\n`)).toContain('Unknown key "homepage"');
    expect(problemsOf(`${PROJECT_YAML}? [a, b]\n: c\n`)).toContain("keys must be plain strings");
    expect(problemsOf(`${PROJECT_YAML}1: one\n`)).toContain("keys must be plain strings");
    expect(problemsOf("- name: widget\n")).toContain("must be a YAML mapping at the top level");
    expect(problemsOf("just text\n")).toContain("must be a YAML mapping at the top level");
  });

  it("rejects oversized files before parsing", () => {
    const text = `${PROJECT_YAML}# ${"x".repeat(PROJECT_MAX_BYTES)}\n`;
    expect(problemsOf(text)).toMatch(/is \d+ bytes; the limit is 8192 bytes/);
    // Multi-byte characters are counted as bytes, not UTF-16 units.
    expect(problemsOf(`${PROJECT_YAML}# ${"é".repeat(PROJECT_MAX_BYTES / 2)}\n`)).toContain("the limit is 8192 bytes");
  });

  it("rejects multiple documents, directives, and duplicate keys", () => {
    expect(problemsOf(`${PROJECT_YAML}---\nname: other\n`)).toContain("exactly one YAML document");
    expect(problemsOf("")).toContain("exactly one YAML document");
    expect(problemsOf(`%YAML 1.1\n---\n${PROJECT_YAML}`)).toContain("must not contain YAML directives");
    expect(problemsOf(`${PROJECT_YAML}name: widget\n`)).toMatch(/is not valid YAML: DUPLICATE_KEY at line \d+/);
    expect(problemsOf(`${PROJECT_YAML}paused: [unterminated\n`)).toContain("is not valid YAML");
  });

  it("validates the name against the pattern and the directory", () => {
    expect(problemsOf(PROJECT_YAML.replace("name: widget", "name: Widget"), "Widget")).toContain("name is required and must match");
    expect(problemsOf(PROJECT_YAML.replace("name: widget", "name: -widget"), "-widget")).toContain("name is required and must match");
    expect(problemsOf(PROJECT_YAML.replace("name: widget", `name: ${"a".repeat(64)}`), "a".repeat(64))).toContain("name is required and must match");
    expect(problemsOf(PROJECT_YAML.replace("name: widget", "name: ../widget"), "widget")).toContain("name is required and must match");
    expect(problemsOf(PROJECT_YAML, "gadget")).toContain('name "widget" must equal its directory name "gadget"');
  });

  it("validates ids, contacts, and optional fields", () => {
    expect(problemsOf(PROJECT_YAML.replace("repository_id: 4242", "repository_id: -1"))).toContain("repository_id is required");
    expect(problemsOf(PROJECT_YAML.replace("repository_id: 4242", 'repository_id: "4242"'))).toContain("repository_id is required");
    expect(problemsOf(PROJECT_YAML.replace("repository_id: 4242", "repository_id: 9007199254740993"))).toContain("repository_id is required");
    expect(problemsOf(PROJECT_YAML.replace("primary_contact: octocat", "primary_contact: octo--cat"))).toContain("primary_contact is required");
    expect(problemsOf(PROJECT_YAML.replace("primary_contact: octocat", "primary_contact: '@octocat'"))).toContain("primary_contact is required");
    const many = Array.from({ length: 11 }, (_, i) => `u${i}`).join(", ");
    expect(problemsOf(PROJECT_YAML.replace("auto_ccs: [hubot]", `auto_ccs: [${many}]`))).toContain("auto_ccs must be a list of at most 10");
    expect(problemsOf(PROJECT_YAML.replace("auto_ccs: [hubot]", "auto_ccs: [hubot, HUBOT]"))).toContain("auto_ccs must not contain duplicates");
    expect(problemsOf(`${PROJECT_YAML}security_contact: http://example.com/security\n`)).toContain("security_contact must be");
    expect(problemsOf(`${PROJECT_YAML}security_contact: https://user:pw@example.com/\n`)).toContain("security_contact must be");
    expect(problemsOf(`${PROJECT_YAML}language: Go Lang\n`)).toContain("language must match");
    expect(problemsOf(`${PROJECT_YAML}preset: everything\n`)).toContain("preset must be one of");
    expect(problemsOf(`${PROJECT_YAML}paused: "yes"\n`)).toContain("paused must be true or false");
  });

  it("escapes values quoted in problems", () => {
    const problems = problemsOf(PROJECT_YAML.replace("main_repo: https://github.com/octo-org/widget", 'main_repo: "evil\\n@here\\u202E"'));
    expect(problems).toContain("main_repo must be exactly");
    expect(problems).not.toContain("\n@here");
    expect(problems).not.toContain("\u202E");
  });

  it("parseStrictYaml reports every hardening violation with its label", () => {
    expect(parseStrictYaml("a: *x\n", 100, "file.yml").problems.join()).toContain("file.yml");
  });
});

const accepted = ["https://github.com/octo-org/widget", "https://github.com/a/b.c_d-e", "https://github.com/octo-org/.github"];

describe("main_repo URLs", () => {
  it.each(accepted)("accepts %s", (url) => {
    expect(parseMainRepo(url)).toBeDefined();
  });

  const rejected = [
    "https://gitlab.com/octo-org/widget",
    "https://github.com.evil.example/octo-org/widget",
    "https://evil.example/github.com/octo-org/widget",
    "http://github.com/octo-org/widget",
    "HTTPS://github.com/octo-org/widget",
    "https://GitHub.com/octo-org/widget",
    "https://user@github.com/octo-org/widget",
    "https://user:pass@github.com/octo-org/widget",
    "https://github.com:443/octo-org/widget",
    "https://140.82.112.3/octo-org/widget",
    "https://github.com/octo-org/widget?tab=readme",
    "https://github.com/octo-org/widget#readme",
    "https://github.com/octo-org/widget.git",
    "https://github.com/octo-org/widget.GIT",
    "https://github.com/octo-org/widget/",
    "https://github.com/octo-org/widget/tree/main",
    "https://github.com/octo-org",
    "https://github.com//widget",
    "https://github.com/octo-org/..",
    "https://github.com/octo-org/.",
    "https://github.com/-octo/widget",
    "https://github.com/octo--org/widget",
    "https://github.com/octo-org/wid get",
    "https://github.com/octo-org/wid%67et",
    "https://gіthub.com/octo-org/widget",
    "https://github.com/octo-оrg/widget",
    "https://github.com/octo-org/widget\u200B",
    " https://github.com/octo-org/widget",
    "github.com/octo-org/widget",
    "git@github.com:octo-org/widget.git",
    `https://github.com/${"a".repeat(40)}/widget`,
    `https://github.com/octo-org/${"a".repeat(101)}`,
  ];
  it.each(rejected)("rejects %j", (url) => {
    expect(parseMainRepo(url)).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(parseMainRepo(42)).toBeUndefined();
    expect(parseMainRepo(["https://github.com/octo-org/widget"])).toBeUndefined();
    expect(parseMainRepo(undefined)).toBeUndefined();
  });
});

describe("registered projects", () => {
  it("this repository's own project file is valid", async () => {
    const text = await readFile("projects/ci-cd-optimizer/project.yaml", "utf8");
    const parsed = parseProjectText(text, "ci-cd-optimizer");
    expect(parsed.problems).toEqual([]);
    expect(parsed.project).toMatchObject({ repositoryId: 1444815201, primaryContact: "MSFT-TKENDRICK", mainRepo: { fullName: "MSFT-TKENDRICK/ci-cd-optimizer" } });
  });

  it("the JSON Schema mirrors the validator's keys and patterns", async () => {
    const schema = JSON.parse(await readFile("projects/schema.json", "utf8")) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { pattern?: string }>;
    };
    expect(schema.additionalProperties).toBe(false);
    expect(new Set(schema.required)).toEqual(new Set(["name", "main_repo", "repository_id", "primary_contact"]));
    expect(Object.keys(schema.properties).sort()).toEqual(["auto_ccs", "language", "main_repo", "name", "paused", "preset", "primary_contact", "repository_id", "security_contact"]);
    expect(schema.properties.name?.pattern).toBe("^[a-z0-9][a-z0-9-]{0,62}$");
    const mainRepo = new RegExp(schema.properties.main_repo?.pattern ?? "^$");
    for (const url of accepted) expect(mainRepo.test(url)).toBe(true);
    for (const url of ["https://github.com/octo-org/widget.git", "https://github.com/octo-org/widget/", "http://github.com/a/b", "https://github.com/a/.."]) {
      expect(mainRepo.test(url)).toBe(false);
    }
  });
});

import { describe, expect, it } from "vitest";
import { assessSsdf, renderSsdfMarkdown } from "../../src/compliance/ssdf.js";
import { DEFAULT_CONFIG } from "../../src/lint/config.js";
import { lint } from "../../src/lint/engine.js";
import { allRules } from "../../src/lint/rules/index.js";
import type { AnalysisInput } from "../../src/lint/types.js";

describe("SSDF repository evidence report", () => {
  it("covers the complete 42-task SSDF v1.1 catalog and distinguishes evidence from attestation", () => {
    const input: AnalysisInput = {
      mode: "repository",
      inventoryComplete: true,
      files: [
        { path: "SECURITY.md", content: "Report vulnerabilities here." },
        {
          path: ".github/workflows/release.yml",
          content: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - run: docker push ghcr.io/example/app:latest\n",
        },
      ],
    };
    const config = { ...structuredClone(DEFAULT_CONFIG), extends: ["ssdf" as const] };
    const result = lint(input, { config, rules: allRules });
    const report = assessSsdf(input, result);

    expect(report.tasks).toHaveLength(42);
    expect(new Set(report.tasks.map((task) => task.id)).size).toBe(42);
    expect(report.tasks.find((task) => task.id === "RV.1.3")?.status).toBe("unknown");
    expect(report.tasks.find((task) => task.id === "PS.2.1")?.status).toBe("gap");
    expect(report.tasks.find((task) => task.id === "PO.2.2")?.status).toBe("requires-attestation");
    expect(report.disclaimer).toContain("not a compliance determination");
    expect(renderSsdfMarkdown(report)).toContain("Tasks: **42**");
  });

  it.each(["", "# Project overview\nHow to build this project."])("does not mistake a SECURITY.md path for a disclosure policy", (content) => {
    const input: AnalysisInput = {
      mode: "repository", inventoryComplete: true, files: [{ path: ".github/SECURITY.md", content }],
    };
    const config = { ...structuredClone(DEFAULT_CONFIG), extends: ["ssdf" as const] };
    const report = assessSsdf(input, lint(input, { config, rules: allRules }));
    const task = report.tasks.find((task) => task.id === "RV.1.3");

    expect(task?.status).toBe("unknown");
    expect(task?.evidence.join(" ")).toContain(".github/SECURITY.md");
    expect(task?.evidence.join(" ")).toContain("contents and operation have not been assessed");
  });

  it("reports an SBOM gap when a publishing job only scans for vulnerabilities", () => {
    const input: AnalysisInput = {
      mode: "repository",
      inventoryComplete: true,
      files: [{
        path: ".github/workflows/release.yml",
        content: "on: push\njobs:\n  release:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: anchore/scan-action@0123456789012345678901234567890123456789\n      - run: docker push ghcr.io/example/app:latest\n",
      }],
    };
    const config = { ...structuredClone(DEFAULT_CONFIG), extends: ["ssdf" as const] };
    const report = assessSsdf(input, lint(input, { config, rules: allRules }));

    expect(report.tasks.find((task) => task.id === "PS.3.2")?.status).toBe("gap");
  });

  it("does not turn absent evidence into a compliance failure when the inventory is incomplete", () => {
    const input: AnalysisInput = { mode: "repository", inventoryComplete: false, files: [] };
    const config = { ...structuredClone(DEFAULT_CONFIG), extends: ["ssdf" as const] };
    const report = assessSsdf(input, lint(input, { config, rules: allRules }));

    expect(report.tasks.find((task) => task.id === "RV.1.3")?.status).toBe("unknown");
    expect(report.tasks.find((task) => task.id === "RV.1.3")?.evidence[0]).toContain("inventory is incomplete");
  });
});

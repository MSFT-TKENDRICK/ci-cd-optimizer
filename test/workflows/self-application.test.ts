import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

interface Step {
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string | boolean>;
}
interface Workflow {
  name: string;
  on: { pull_request?: { types?: string[] }; workflow_run?: { workflows: string[] } };
  concurrency?: { "cancel-in-progress"?: boolean; queue?: string };
  jobs: Record<string, { if?: string; steps?: Step[] }>;
}

async function workflow(name: string): Promise<Workflow> {
  return parse(await readFile(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8")) as Workflow;
}

describe("self-application workflow contracts", () => {
  it.each([
    ["experiment-generator.lock.yml", "create_experiment"],
    ["experiment-grader.lock.yml", "grade_experiments"],
  ])("mints the publisher token outside inference in %s", async (file, jobName) => {
    const data = await workflow(file);
    const publisher = data.jobs[jobName!]?.steps ?? [];
    const mint = publisher.find((step) => step.id === "app-token");
    expect(mint?.with).toMatchObject({
      "client-id": "${{ vars.CICD_OPTIMIZER_APP_ID }}",
      "private-key": "${{ secrets.CICD_OPTIMIZER_APP_PRIVATE_KEY }}",
      repositories: "${{ github.event.repository.name }}",
      "permission-actions": "read",
      "permission-pull-requests": "write",
    });
    const execution = publisher.find((step) => step.run?.includes("node dist-action/index.js experiments"));
    expect(execution?.env?.GITHUB_TOKEN).toBe("${{ steps.app-token.outputs.token || secrets.CICD_OPTIMIZER_TOKEN || github.token }}");
    expect(execution?.env?.CICD_OPTIMIZER_DISPATCH_TOKEN).toBe("${{ github.token }}");
    expect(JSON.stringify(data.jobs.agent)).not.toContain("CICD_OPTIMIZER_APP_PRIVATE_KEY");
    expect(JSON.stringify(data.jobs.agent)).not.toContain("create-github-app-token");
  });

  it("uses the compiler-managed scoped App token for arm publication", async () => {
    const data = await workflow("experiment-arm.lock.yml");
    const publisher = data.jobs.safe_outputs?.steps ?? [];
    const mint = publisher.find((step) => step.id === "safe-outputs-app-token");
    expect(mint?.with?.["client-id"]).toBe("${{ vars.CICD_OPTIMIZER_APP_ID }}");
    expect(mint?.with?.["permission-workflows"]).toBe("write");
    expect(mint?.with?.repositories).toBeTruthy();
    expect(JSON.stringify(publisher)).toContain("steps.safe-outputs-app-token.outputs.token");
    expect(JSON.stringify(data.jobs.agent)).not.toContain("CICD_OPTIMIZER_APP_PRIVATE_KEY");
  });

  it.each(["experiment-generator.lock.yml", "experiment-grader.lock.yml"])(
    "skips empty/full inference without failing the counting step in %s", async (file) => {
      const data = await workflow(file);
      const steps = data.jobs.pre_activation?.steps ?? [];
      const count = steps.find((step) => step.id === "count");
      const gate = steps.find((step) => step.id === "check");
      expect(count?.run).toContain("node dist-action/index.js experiments capacity");
      expect(count?.run).toContain('>> "$GITHUB_OUTPUT"');
      expect(count?.run).not.toContain("--limit 200");
      expect(gate?.if).toContain("fromJSON(steps.count.outputs.running)");
      if (file === "experiment-generator.lock.yml") expect(gate?.if).toContain("fromJSON(steps.count.outputs.limit)");
      expect(data.jobs.activation?.if).toContain("check_result == 'success'");
    },
  );

  it.each(["recipe-publish.yml", "recipe-rollout.yml"])("uses the same explicit credential for git and PR writes in %s", async (file) => {
    const data = await workflow(file);
    const steps = Object.values(data.jobs).flatMap((job) => job.steps ?? []);
    expect(steps.find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(false);
    const publication = steps.find((step) => step.run?.includes("gh pr create"));
    expect(publication?.env?.GH_TOKEN).toContain("outputs.token");
    expect(publication?.run).toContain("credential.helper=!gh auth git-credential");
    expect(publication?.run).toContain('--force-with-lease=refs/heads/$branch:$expected');
    expect(publication?.run).not.toContain("|| true");
  });

  it("runs the expensive build on ready-for-review and on merge-queue events", async () => {
    const data = await workflow("ci.yml");
    expect(data.on.pull_request?.types).toContain("ready_for_review");
    expect(data.on).toHaveProperty("merge_group");
    expect(data.jobs.build?.if).toBe("github.event_name != 'pull_request' || !github.event.pull_request.draft");
  });

  it("queues telemetry for the daily caller without recursively subscribing to itself", async () => {
    const daily = await workflow("cicd-optimizer-daily.yml");
    const telemetry = await workflow("cicd-optimizer-telemetry.yml");
    expect(telemetry.on.workflow_run?.workflows).toContain(daily.name);
    expect(telemetry.on.workflow_run?.workflows).not.toContain(telemetry.name);
    expect(telemetry.concurrency).toMatchObject({ "cancel-in-progress": false, queue: "max" });
  });
});

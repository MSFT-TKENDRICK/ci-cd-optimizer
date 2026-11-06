import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SETUP_STEP_IDS, type SetupState } from "@/lib/types";
import { deferred, fakeTransport, makeState } from "./fixtures";
import { FAST, heading, mount, step } from "./mount";

const RUNNING: SetupState["installation"] = { status: "running", run: null };

describe("Stepper", () => {
  it("lists every step in order and says where the user is", () => {
    mount(fakeTransport(), makeState("install"));

    const items = within(screen.getByRole("list", { name: "Setup steps" })).getAllByRole("listitem");
    expect(items.map((item) => item.getAttribute("data-step"))).toEqual([...SETUP_STEP_IDS]);
    expect(items.map((item) => within(item).getByText(/^(Complete|Current step|Upcoming)$/).textContent)).toEqual([
      "Complete",
      "Complete",
      "Current step",
      "Upcoming",
      "Upcoming",
    ]);
    expect(items.filter((item) => item.hasAttribute("aria-current")).map((item) => item.getAttribute("data-step"))).toEqual(["install"]);
    expect(items[2]).toHaveAttribute("aria-current", "step");
  });

  it("names each step by its title alone, keeping the status text out of the heading", () => {
    mount(fakeTransport(), makeState("install"));

    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual([
      "Register the App",
      "Store the key",
      "Install and verify",
      "Authorize the coding agent",
      "Run the first scan",
    ]);
  });

  it("marks nothing as current once every step is done", () => {
    mount(fakeTransport(), makeState(null));

    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(screen.getAllByText("Complete")).toHaveLength(SETUP_STEP_IDS.length);
  });

  it("summarises finished steps, previews upcoming ones, and keeps the current step uncluttered", () => {
    mount(fakeTransport(), makeState("install"));

    expect(within(step("register")).getByText("App ci-cd-optimizer-acme (ID 123) registered.")).toBeInTheDocument();
    expect(within(step("credentials")).getByText("Saved CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID.")).toBeInTheDocument();
    expect(within(step("authorize")).getByText("Provide a scoped token so GitHub can start coding agents.")).toBeInTheDocument();
    expect(within(step("scan")).getByText("Run the scan once the steps above are done.")).toBeInTheDocument();

    expect(within(step("install")).queryByText("Install the App on this repository only, then verify its access.")).not.toBeInTheDocument();
    expect(within(step("install")).queryByText("Installation and repository-scoped token verified.")).not.toBeInTheDocument();
  });

  it("shows controls only on the current step", () => {
    mount(fakeTransport({ kind: "http" }), makeState("install"));

    expect(within(step("install")).getByRole("button", { name: "Verify installation" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save credentials to this repository" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Assignment token")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Run scan and assign pending findings" })).not.toBeInTheDocument();
  });

  it.each([
    [false, "App ci-cd-optimizer-acme (ID 123) registered."],
    [true, "Using the saved App ci-cd-optimizer-acme (ID 123)."],
  ])("describes the App it registered when resumed is %s", (resumed, summary) => {
    mount(fakeTransport(), makeState("credentials", { resumed }));

    expect(within(step("register")).getByText(summary)).toBeInTheDocument();
  });

  it("falls back to a plain summary when the snapshot carries no App", () => {
    mount(fakeTransport(), makeState("credentials", { app: null }));

    expect(within(step("register")).getByText("App registered.")).toBeInTheDocument();
  });

  it("says nothing was replaced when it resumed from saved settings", () => {
    mount(fakeTransport(), makeState("install", { resumed: true }));

    expect(within(step("credentials")).getByText("Resumed from repository settings. The private key stays in GitHub; nothing was replaced.")).toBeInTheDocument();
  });

  it.each([
    { where: "a finished step", current: "scan", failed: "credentials", title: "Could not save the credentials" },
    { where: "the current step", current: "install", failed: "install", title: "Verification failed" },
    { where: "an upcoming step", current: "credentials", failed: "authorize", title: "Could not authorize the coding agent" },
  ] as const)("puts a recorded failure on $where and nowhere else", ({ current, failed, title }) => {
    mount(fakeTransport(), makeState(current, { error: { step: failed, message: "gh exited with status 1" } }));

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    const alert = screen.getByRole("alert");
    expect(within(step(failed)).getByRole("alert")).toBe(alert);
    expect(within(alert).getByText(title)).toBeInTheDocument();
    expect(within(alert).getByText("gh exited with status 1")).toBeInTheDocument();
  });

  it("keeps the current step's controls beside its failure so the user can retry", () => {
    mount(fakeTransport(), makeState("install", { error: { step: "install", message: "The App is not installed." } }));

    expect(within(step("install")).getByRole("button", { name: "Verify installation" })).toBeEnabled();
  });
});

describe("Stepper focus", () => {
  it("does not move focus on first render", () => {
    mount(fakeTransport(), makeState("install"));

    expect(document.body).toHaveFocus();
  });

  it("moves focus to the next step when the current one finishes and focus was lost", async () => {
    const transport = fakeTransport({ state: makeState("authorize") });
    mount(transport, makeState("install", { installation: RUNNING }), FAST);

    await waitFor(() => expect(heading("authorize")).toHaveFocus());
    expect(step("authorize")).toHaveAttribute("aria-current", "step");
  });

  it("leaves focus alone when the user is working in another control", async () => {
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("authorize") });
    transport.getState.mockReturnValueOnce(gate.promise);
    mount(transport, makeState("install", { installation: RUNNING }), FAST);
    await waitFor(() => expect(transport.getState).toHaveBeenCalled());

    const copy = screen.getByRole("button", { name: "Copy command" });
    copy.focus();
    await act(async () => {
      gate.resolve(makeState("authorize"));
    });

    await waitFor(() => expect(step("authorize")).toHaveAttribute("aria-current", "step"));
    expect(copy).toHaveFocus();
  });

  it("does not pull focus to the current step when a poll changes nothing about which step it is", async () => {
    const transport = fakeTransport({ state: makeState("install", { installation: RUNNING, message: "Still waiting for GitHub." }) });
    mount(transport, makeState("install", { installation: RUNNING }), FAST);

    expect(await screen.findByText("Still waiting for GitHub.")).toBeInTheDocument();
    expect(document.body).toHaveFocus();
  });

  it("does not look for a next step once everything is done", async () => {
    const transport = fakeTransport({ state: makeState(null) });
    mount(transport, makeState("scan"), FAST);

    await waitFor(() => expect(screen.getByRole("progressbar", { name: "Setup progress" })).toHaveAttribute("aria-valuenow", "100"));
    expect(document.body).toHaveFocus();
  });
});

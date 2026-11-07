import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SETUP_STEP_IDS, type SetupState } from "@/lib/types";
import { deferred, fakeTransport, makeState } from "./fixtures";
import { FAST, heading, mount, panel, step } from "./mount";

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

  it("shows one step at a time, headed by its title alone", () => {
    mount(fakeTransport(), makeState("install"));

    expect(document.querySelectorAll("[data-step-panel]")).toHaveLength(1);
    expect(screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent)).toEqual(["Install and verify"]);
    expect(heading("install")).toBe(screen.getByRole("heading", { level: 2 }));
    expect(within(panel("install")).getByText("Step 3 of 5")).toBeInTheDocument();
  });

  it("lets the user open finished and current steps from the list, but not upcoming ones", () => {
    mount(fakeTransport(), makeState("install"));

    expect(within(step("register")).getByRole("button", { name: "Go to step 1: Register the App" })).toHaveAttribute("aria-pressed", "false");
    expect(within(step("credentials")).getByRole("button", { name: "Go to step 2: Store the key" })).toHaveAttribute("aria-pressed", "false");
    expect(within(step("install")).getByRole("button", { name: "Go to step 3: Install and verify" })).toHaveAttribute("aria-pressed", "true");
    expect(within(step("authorize")).queryByRole("button")).not.toBeInTheDocument();
    expect(within(step("scan")).queryByRole("button")).not.toBeInTheDocument();
  });

  it("marks nothing as current once every step is done, and shows the last step", () => {
    mount(fakeTransport(), makeState(null));

    expect(document.querySelector("[aria-current]")).toBeNull();
    expect(screen.getAllByText("Complete")).toHaveLength(SETUP_STEP_IDS.length);
    expect(heading("scan")).toHaveTextContent("Run the first scan");
    expect(within(panel("scan")).getByRole("button", { name: "Run again" })).toBeInTheDocument();
    expect(within(panel("scan")).queryByRole("button", { name: "Back to current step" })).not.toBeInTheDocument();
  });

  it("summarises finished steps, previews upcoming ones, and keeps the current step uncluttered", () => {
    mount(fakeTransport(), makeState("install"));

    expect(within(step("register")).getByText("App ci-cd-optimizer-acme (ID 123) registered.")).toBeInTheDocument();
    expect(within(step("credentials")).getByText("Saved CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID.")).toBeInTheDocument();
    expect(within(step("authorize")).getByText("Provide a scoped token so GitHub can start coding agents.")).toBeInTheDocument();
    expect(within(step("scan")).getByText("Run the scan once the earlier steps are done.")).toBeInTheDocument();

    expect(within(step("install")).queryByText("Install the App on this repository only, then verify its access.")).not.toBeInTheDocument();
    expect(within(step("install")).queryByText("Installation and repository-scoped token verified.")).not.toBeInTheDocument();
    expect(within(panel("install")).queryByText("Install the App on this repository only, then verify its access.")).not.toBeInTheDocument();
    expect(within(panel("install")).queryByText("Installation and repository-scoped token verified.")).not.toBeInTheDocument();
  });

  it("shows controls only on the current step", () => {
    mount(fakeTransport({ kind: "http" }), makeState("install"));

    expect(within(panel("install")).getByRole("button", { name: "Verify installation" })).toBeInTheDocument();
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
  ] as const)("opens a recorded failure on $where and shows it nowhere else", ({ current, failed, title }) => {
    mount(fakeTransport(), makeState(current, { error: { step: failed, message: "gh exited with status 1" } }));

    expect(screen.getAllByRole("alert")).toHaveLength(1);
    const alert = screen.getByRole("alert");
    expect(within(panel(failed)).getByRole("alert")).toBe(alert);
    expect(within(alert).getByText(title)).toBeInTheDocument();
    expect(within(alert).getByText("gh exited with status 1")).toBeInTheDocument();
    expect(within(step(failed)).getByRole("button", { name: /^Go to step \d: / })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps the current step's controls beside its failure so the user can retry", () => {
    mount(fakeTransport(), makeState("install", { error: { step: "install", message: "The App is not installed." } }));

    expect(within(panel("install")).getByRole("button", { name: "Verify installation" })).toBeEnabled();
  });
});

describe("Stepper navigation", () => {
  it("opens a finished step from the list, moves focus to its heading, and leaves its controls behind", async () => {
    const { user } = mount(fakeTransport(), makeState("install"));

    await user.click(screen.getByRole("button", { name: "Go to step 1: Register the App" }));

    expect(heading("register")).toHaveFocus();
    expect(screen.getByRole("button", { name: "Go to step 1: Register the App" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Go to step 3: Install and verify" })).toHaveAttribute("aria-pressed", "false");
    expect(within(panel("register")).getByText("App ci-cd-optimizer-acme (ID 123) registered.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Verify installation" })).not.toBeInTheDocument();
    expect(step("install")).toHaveAttribute("aria-current", "step");
  });

  it("walks back and forward through finished steps but never past the current one", async () => {
    const { user } = mount(fakeTransport(), makeState("install"));

    expect(within(panel("install")).queryByRole("button", { name: /Continue/ })).not.toBeInTheDocument();
    await user.click(within(panel("install")).getByRole("button", { name: "Back" }));
    expect(heading("credentials")).toHaveFocus();
    await user.click(within(panel("credentials")).getByRole("button", { name: "Back" }));
    expect(within(panel("register")).queryByRole("button", { name: "Back" })).not.toBeInTheDocument();

    await user.click(within(panel("register")).getByRole("button", { name: /Continue/ }));
    await user.click(within(panel("credentials")).getByRole("button", { name: /Continue/ }));
    expect(heading("install")).toHaveFocus();
    expect(within(panel("install")).getByRole("button", { name: "Verify installation" })).toBeInTheDocument();
  });

  it("offers a way back to the current step from a step that is not next to it", async () => {
    const { user } = mount(fakeTransport(), makeState("scan"));

    await user.click(screen.getByRole("button", { name: "Go to step 1: Register the App" }));
    await user.click(within(panel("register")).getByRole("button", { name: "Back to current step" }));

    expect(heading("scan")).toHaveFocus();
    expect(within(panel("scan")).getByRole("button", { name: "Run scan and assign pending findings" })).toBeInTheDocument();
    expect(within(panel("scan")).queryByRole("button", { name: "Back to current step" })).not.toBeInTheDocument();
  });

  it("returns to the new current step when setup advances while the user reviews an earlier one", async () => {
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("authorize") });
    transport.getState.mockReturnValueOnce(gate.promise);
    const { user } = mount(transport, makeState("install", { installation: RUNNING }), FAST);
    await waitFor(() => expect(transport.getState).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Go to step 1: Register the App" }));
    expect(panel("register")).toBeInTheDocument();
    await act(async () => {
      gate.resolve(makeState("authorize"));
    });

    await waitFor(() => expect(heading("authorize")).toHaveFocus());
    expect(document.querySelector("[data-step-panel='register']")).toBeNull();
  });

  it("forgets an earlier pick once setup moves on, even if the same step comes back", async () => {
    const failed = deferred<SetupState>();
    const retried = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("install", { installation: RUNNING }) });
    transport.getState.mockReturnValueOnce(failed.promise).mockReturnValueOnce(retried.promise);
    const { user } = mount(transport, makeState("install", { installation: RUNNING }), FAST);
    await waitFor(() => expect(transport.getState).toHaveBeenCalled());

    await user.click(screen.getByRole("button", { name: "Go to step 1: Register the App" }));
    await act(async () => {
      failed.resolve(makeState("install", { installation: RUNNING, error: { step: "install", message: "The App is not installed." } }));
    });
    await waitFor(() => expect(panel("install")).toBeInTheDocument());

    await act(async () => {
      retried.resolve(makeState("install", { installation: RUNNING }));
    });
    await waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());

    expect(panel("install")).toBeInTheDocument();
    expect(document.querySelector("[data-step-panel='register']")).toBeNull();
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

  it("moves focus to the new step when the control holding it leaves with the finished step", async () => {
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("authorize") });
    transport.getState.mockReturnValueOnce(gate.promise);
    mount(transport, makeState("install", { installation: RUNNING }), FAST);
    await waitFor(() => expect(transport.getState).toHaveBeenCalled());

    const check = within(panel("install")).getByRole("button", { name: "Check verification result" });
    check.focus();
    expect(check).toHaveFocus();
    await act(async () => {
      gate.resolve(makeState("authorize"));
    });

    await waitFor(() => expect(heading("authorize")).toHaveFocus());
    expect(check).not.toBeInTheDocument();
  });

  it("leaves focus alone when the user is working in a control that stays on the page", async () => {
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("authorize") });
    transport.getState.mockReturnValueOnce(gate.promise);
    mount(transport, makeState("install", { installation: RUNNING }), FAST);
    await waitFor(() => expect(transport.getState).toHaveBeenCalled());

    const nav = screen.getByRole("button", { name: "Go to step 1: Register the App" });
    nav.focus();
    await act(async () => {
      gate.resolve(makeState("authorize"));
    });

    await waitFor(() => expect(step("authorize")).toHaveAttribute("aria-current", "step"));
    expect(panel("authorize")).toBeInTheDocument();
    expect(nav).toHaveFocus();
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

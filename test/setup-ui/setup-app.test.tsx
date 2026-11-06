import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SetupApiError } from "@/lib/transport";
import { fakeTransport, makeState } from "./fixtures";
import { FAST, mount, pressInDialog, step } from "./mount";

const SAVE = "Save credentials to this repository";

describe("SetupApp before the first snapshot", () => {
  it("shows the title and a loading status until the snapshot arrives", async () => {
    const transport = fakeTransport({ state: makeState("credentials") });
    mount(transport, null);

    expect(screen.getByRole("heading", { level: 1, name: "CI/CD Optimizer setup" })).toBeInTheDocument();
    expect(screen.getByText("Loading setup status")).toBeInTheDocument();

    expect(await screen.findByRole("list", { name: "Setup steps" })).toBeInTheDocument();
    expect(screen.queryByText("Loading setup status")).not.toBeInTheDocument();
    expect(transport.getState).toHaveBeenCalledTimes(1);
  });

  it("renders a snapshot it was handed without asking for it again", () => {
    const transport = fakeTransport();
    mount(transport, makeState("install"));

    expect(screen.getByRole("list", { name: "Setup steps" })).toBeInTheDocument();
    expect(transport.getState).not.toHaveBeenCalled();
  });

  it.each([
    ["http", "This tab is not authorized", "Reopen the link printed by npm run setup."],
    ["mcp", "This view is not authorized", "Ask Copilot to run the CI/CD Optimizer setup again."],
  ] as const)("tells a %s page that cannot authenticate how to recover", async (kind, title, advice) => {
    const transport = fakeTransport({ kind });
    transport.getState.mockRejectedValue(new SetupApiError("Missing or invalid setup session.", 401));
    mount(transport, null);

    expect(await screen.findByText(title)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(advice.replace(/[.]/g, "\\.")))).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Check again" })).not.toBeInTheDocument();
    expect(screen.queryByText("Loading setup status")).not.toBeInTheDocument();
  });

  it("offers Check again once the server stays unreachable, and recovers when it returns", async () => {
    const transport = fakeTransport({ state: makeState("install") });
    transport.getState.mockRejectedValue(new SetupApiError("Could not reach the setup server.", 0));
    const { user } = mount(transport, null, FAST);

    expect(await screen.findByText("Setup server unreachable")).toBeInTheDocument();

    transport.getState.mockResolvedValue(makeState("install"));
    await user.click(screen.getByRole("button", { name: "Check again" }));

    expect(await screen.findByRole("list", { name: "Setup steps" })).toBeInTheDocument();
    expect(screen.queryByText("Setup server unreachable")).not.toBeInTheDocument();
  });
});

describe("SetupApp header", () => {
  it("names the repository and reports progress", () => {
    mount(fakeTransport(), makeState("install"));

    expect(screen.getByText(/^Setting up/)).toHaveTextContent("Setting up acme/widgets in Actions-hosted mode.");
    const bar = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "40");
    expect(bar).toHaveAttribute("aria-valuetext", "2 of 5 steps complete");
  });

  it("shows when the session expires in the viewer's own time format", () => {
    const state = makeState("install");
    mount(fakeTransport(), state);

    const time = new Date(state.expiresAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    expect(screen.getByText(`Expires ${time}`)).toBeInTheDocument();
    expect(screen.queryByText("Expired")).not.toBeInTheDocument();
  });

  it("leaves the expiry out rather than showing an invalid time", () => {
    mount(fakeTransport(), makeState("install", { expiresAt: "not a date" }));

    expect(screen.queryByText(/^Expires/)).not.toBeInTheDocument();
  });

  it("marks a session resumed from saved settings", () => {
    mount(fakeTransport(), makeState("install", { resumed: true }));

    expect(screen.getByText("Resumed")).toBeInTheDocument();
  });

  it("locks the page and says so once the server reports the session expired", () => {
    mount(fakeTransport(), makeState("credentials", { expired: true }));

    expect(screen.getByText("Expired")).toBeInTheDocument();
    expect(screen.queryByText(/^Expires/)).not.toBeInTheDocument();
    expect(screen.getByText("Setup expired")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
  });

  it("completes the progress bar when every step is done", () => {
    mount(fakeTransport(), makeState(null));

    const bar = screen.getByRole("progressbar", { name: "Setup progress" });
    expect(bar).toHaveAttribute("aria-valuenow", "100");
    expect(bar).toHaveAttribute("aria-valuetext", "5 of 5 steps complete");
  });
});

describe("SetupApp footer", () => {
  it("offers no resume command before an App exists", () => {
    mount(fakeTransport(), makeState("register"));

    expect(screen.queryByText("To continue later without registering again, run:")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy command" })).not.toBeInTheDocument();
    expect(screen.getByText(/listens only on 127\.0\.0\.1/)).toBeInTheDocument();
  });

  it("gives the exact command that resumes with the registered App, and copies it", async () => {
    const { user } = mount(fakeTransport(), makeState("credentials"));
    const command = "npm run setup -- --repo acme/widgets --resume-app ci-cd-optimizer-acme";

    expect(screen.getByText(command)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Copy command" }));

    expect(await navigator.clipboard.readText()).toBe(command);
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("SetupApp notices", () => {
  it("shows an action the server refused before running, and lets the user dismiss it", async () => {
    const transport = fakeTransport({ state: makeState("credentials") });
    transport.act.mockRejectedValue(new SetupApiError("Another setup step is running. Wait for it to finish.", 409));
    const { user } = mount(transport, makeState("credentials"));

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("That did not go through")).toBeInTheDocument();
    expect(within(alert).getByText("Another setup step is running. Wait for it to finish.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SAVE })).toBeEnabled();

    await user.click(within(alert).getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("clears an old notice when the next action starts", async () => {
    const transport = fakeTransport({ state: makeState("credentials") });
    transport.act.mockRejectedValueOnce(new SetupApiError("Another setup step is running. Wait for it to finish.", 409));
    const { user } = mount(transport, makeState("credentials"));

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");
    expect(await screen.findByText("That did not go through")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");

    await waitFor(() => expect(screen.queryByText("That did not go through")).not.toBeInTheDocument());
    expect(transport.act).toHaveBeenCalledTimes(2);
  });

  it("shows a failure the server recorded on its step, not as a second notice", async () => {
    const failed = makeState("credentials", { error: { step: "credentials", message: "gh: HTTP 403" } });
    const transport = fakeTransport({ state: makeState("credentials") });
    transport.act.mockRejectedValue(new SetupApiError("gh: HTTP 403", 502, failed));
    const { user } = mount(transport, makeState("credentials"));

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");

    const alert = await within(step("credentials")).findByRole("alert");
    expect(within(alert).getByText("Could not save the credentials")).toBeInTheDocument();
    expect(screen.getAllByText("gh: HTTP 403")).toHaveLength(1);
    expect(screen.queryByText("That did not go through")).not.toBeInTheDocument();
  });

  it("stops accepting actions when the server cannot be reached mid-action, but keeps the progress visible", async () => {
    const transport = fakeTransport({ state: makeState("credentials") });
    transport.act.mockRejectedValue(new SetupApiError("Could not reach the setup server.", 0));
    const { user } = mount(transport, makeState("credentials"));

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");

    expect(await screen.findByText("Setup server unreachable")).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Setup steps" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("locks the page when the session is no longer authorized", async () => {
    const transport = fakeTransport({ kind: "mcp", state: makeState("credentials") });
    transport.act.mockRejectedValue(new SetupApiError("Missing or invalid setup session.", 401));
    const { user } = mount(transport, makeState("credentials"));

    await user.click(screen.getByRole("button", { name: SAVE }));
    await pressInDialog(user, "Save credentials");

    expect(await screen.findByText("This view is not authorized")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: SAVE })).toBeDisabled();
  });
});

describe("SetupApp status message", () => {
  it("announces a message in a region that was already on the page", async () => {
    const quiet = makeState("credentials");
    const transport = fakeTransport({ state: makeState("install", { message: "App credentials saved. Install on the selected repository next." }) });
    mount(transport, quiet, FAST);

    const region = screen.getByRole("status");
    expect(region).toBeEmptyDOMElement();

    await waitFor(() => expect(region).toHaveTextContent("App credentials saved. Install on the selected repository next."));
    expect(screen.getByRole("status")).toBe(region);
  });
});

describe("SetupApp polling", () => {
  it("moves on to the next step when a poll reports progress made elsewhere", async () => {
    const running = makeState("install", { installation: { status: "running", run: null } });
    const transport = fakeTransport({ state: makeState("authorize") });
    mount(transport, running, FAST);

    expect(within(step("install")).getByText(/^Verification is running/)).toBeInTheDocument();

    await waitFor(() => expect(step("authorize")).toHaveAttribute("aria-current", "step"));
    expect(step("install")).not.toHaveAttribute("aria-current");
    expect(within(step("install")).getByText("Installation and repository-scoped token verified.")).toBeInTheDocument();
    expect(within(step("authorize")).getByRole("link", { name: /Create a scoped assignment token on GitHub/ })).toBeInTheDocument();
  });
});

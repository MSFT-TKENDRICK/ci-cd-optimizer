import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps, FormEvent } from "react";
import { describe, expect, it, vi } from "vitest";
import { ActionButton, ConfirmAction } from "@/components/setup/confirm-action";
import { SetupApiError } from "@/lib/transport";
import type { SetupState } from "@/lib/types";
import { deferred, fakeTransport, makeState } from "./fixtures";
import { heading, mount, panel, pressInDialog, provide } from "./mount";

type Overrides = NonNullable<Parameters<typeof provide>[1]>;
type Blocked<Props> = [reason: string, props: Props, overrides: Overrides];

const save = (props: Partial<ComponentProps<typeof ConfirmAction>> = {}) => (
  <ConfirmAction action="save-credentials" label="Save it" title="Save the credentials?" description="This writes a repository secret." confirmLabel="Save" {...props} />
);

const check = (props: Partial<ComponentProps<typeof ActionButton>> = {}) => (
  <ActionButton action="check-verification" {...props}>
    Check now
  </ActionButton>
);

// Everything that must keep a mutating control from being pressed, whichever way it is reached.
const BLOCKED = <Props,>(own: Props): Blocked<Props>[] => [
  ["the caller disables it", { ...own, disabled: true }, {}],
  ["the page is locked", own, { locked: true }],
  ["a step is running on the server", own, { state: makeState("credentials", { busy: true }) }],
  ["a different action is pending", own, { pending: "verify" }],
];

describe("ConfirmAction", () => {
  it("asks before it acts and says what will happen", async () => {
    const { user, runAction } = provide(save());

    await user.click(screen.getByRole("button", { name: "Save it" }));

    const dialog = await screen.findByRole("alertdialog", { name: "Save the credentials?" });
    expect(dialog).toHaveAccessibleDescription("This writes a repository secret.");
    expect(runAction).not.toHaveBeenCalled();
  });

  it("does nothing when the user cancels", async () => {
    const { user, runAction } = provide(save());
    await user.click(screen.getByRole("button", { name: "Save it" }));

    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(runAction).not.toHaveBeenCalled();
  });

  it("runs the action once when confirmed, then closes the confirmation", async () => {
    const { user, runAction } = provide(save());
    await user.click(screen.getByRole("button", { name: "Save it" }));

    await pressInDialog(user, "Save");

    expect(runAction).toHaveBeenCalledExactlyOnceWith("save-credentials", undefined);
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("reads the payload at confirmation, so nothing is captured earlier", async () => {
    let token = "typed-first";
    const payload = vi.fn(() => ({ token }));
    const { user, runAction } = provide(save({ action: "authorize-copilot", payload }));
    await user.click(screen.getByRole("button", { name: "Save it" }));
    await screen.findByRole("alertdialog");
    expect(payload).not.toHaveBeenCalled();

    token = "edited-after-opening";
    await pressInDialog(user, "Save");

    expect(payload).toHaveBeenCalledOnce();
    expect(runAction).toHaveBeenCalledExactlyOnceWith("authorize-copilot", { token: "edited-after-opening" });
  });

  it.each([true, false])("tells its caller whether the action worked (%s)", async (worked) => {
    const onDone = vi.fn();
    const { user, runAction } = provide(save({ onDone }));
    runAction.mockResolvedValue(worked);
    await user.click(screen.getByRole("button", { name: "Save it" }));

    await pressInDialog(user, "Save");

    await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith(worked));
  });

  it("can be pressed when nothing else is going on", () => {
    provide(save());

    expect(screen.getByRole("button", { name: "Save it" })).toBeEnabled();
  });

  it.each(BLOCKED<Partial<ComponentProps<typeof ConfirmAction>>>({}))("cannot be pressed when %s", (_reason, props, overrides) => {
    provide(save(props), overrides);

    expect(screen.getByRole("button", { name: "Save it" })).toBeDisabled();
  });

  it("shows progress while its own action is pending", () => {
    provide(save(), { pending: "save-credentials" });

    expect(screen.getByRole("button", { name: "Save it" }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
  });

  it("shows no progress for someone else's action", () => {
    provide(save(), { pending: "verify" });

    expect(screen.getByRole("button", { name: "Save it" }).querySelector("svg")).toBeNull();
  });

  it("lets a form that controls the confirmation decide when it opens", async () => {
    const onOpenChange = vi.fn();
    const { user } = provide(save({ open: false, onOpenChange }));

    await user.click(screen.getByRole("button", { name: "Save it" }));

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("shows the confirmation a form has opened and reports its closing", async () => {
    const onOpenChange = vi.fn();
    const { user, runAction } = provide(save({ open: true, onOpenChange }));

    await pressInDialog(user, "Save");

    expect(runAction).toHaveBeenCalledOnce();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});

// The View is auto-sized inside a frame the host owns, so it cannot know which part of the page the user is
// looking at. A modal centred on the viewport can therefore land out of sight, so the confirmation is part of the
// page flow, right after the button that asked for it.
describe("the confirmation panel", () => {
  async function open(ui = save(), overrides: Overrides = {}) {
    const view = provide(ui, overrides);
    await view.user.click(screen.getByRole("button", { name: "Save it" }));
    const panel = await screen.findByRole("alertdialog");
    return { ...view, panel, cancel: within(panel).getByRole("button", { name: "Cancel" }) };
  }

  it("opens in place, right after its button, not over the page", async () => {
    const { panel } = await open(<section aria-label="Slot">{save()}</section>);

    expect(screen.getByRole("region", { name: "Slot" })).toContainElement(panel);
    expect(screen.getByRole("button", { name: "Save it" }).nextElementSibling).toBe(panel);
  });

  it("leaves the rest of the page reachable while it is open", async () => {
    await open(
      <>
        {save()}
        <button type="button">Elsewhere</button>
      </>,
    );

    // A modal hides everything else from assistive technology and blocks pointer input.
    expect(screen.getByRole("button", { name: "Elsewhere" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Save it" })).toBeInTheDocument();
    expect(document.body.style.pointerEvents).not.toBe("none");
  });

  it("tells assistive technology which confirmation its button opened", async () => {
    const { user } = provide(save());
    const button = screen.getByRole("button", { name: "Save it" });
    expect(button).toHaveAttribute("aria-expanded", "false");

    await user.click(button);
    const panel = await screen.findByRole("alertdialog");

    expect(button).toHaveAttribute("aria-expanded", "true");
    expect(button).toHaveAttribute("aria-controls", panel.id);
  });

  it("moves focus to Cancel, the safe choice, when it opens", async () => {
    const { cancel } = await open();

    expect(cancel).toHaveFocus();
  });

  it("scrolls itself into view when it opens", async () => {
    const { panel } = await open();

    const scroll = vi.mocked(Element.prototype.scrollIntoView);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(scroll.mock.contexts[0]).toBe(panel);
  });

  it("closes on Escape and puts focus back on its button", async () => {
    const { user, runAction } = await open();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save it" })).toHaveFocus();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("puts focus back on its button after Cancel", async () => {
    const { user, cancel } = await open();

    await user.click(cancel);

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Save it" })).toHaveFocus();
  });

  it("stays open and does not act when its button is pressed again", async () => {
    const { user, runAction, panel } = await open();

    await user.click(screen.getByRole("button", { name: "Save it" }));

    expect(panel).toBeInTheDocument();
    expect(runAction).not.toHaveBeenCalled();
  });

  it("never submits a form around it", async () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const { user, runAction } = provide(<form onSubmit={onSubmit}>{save()}</form>);

    await user.click(screen.getByRole("button", { name: "Save it" }));
    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Save it" }));
    await pressInDialog(user, "Save");

    expect(runAction).toHaveBeenCalledOnce();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("reports cancelling to a form that controls it", async () => {
    const onOpenChange = vi.fn();
    const { user, runAction } = provide(save({ open: true, onOpenChange }));

    await user.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(runAction).not.toHaveBeenCalled();
  });

  it.each(BLOCKED<Partial<ComponentProps<typeof ConfirmAction>>>({ open: true }))("does not show a confirmation a form has opened when %s, and tells the form to drop it", (_reason, props, overrides) => {
    const onOpenChange = vi.fn();
    provide(save({ ...props, onOpenChange }), overrides);

    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledExactlyOnceWith(false);
  });
});

describe("ActionButton", () => {
  it("runs a read-only action straight away, without a confirmation", async () => {
    const { user, runAction } = provide(check());

    await user.click(screen.getByRole("button", { name: "Check now" }));

    expect(runAction).toHaveBeenCalledExactlyOnceWith("check-verification");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
  });

  it("does not submit a form around it", async () => {
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    const { user } = provide(<form onSubmit={onSubmit}>{check()}</form>);

    await user.click(screen.getByRole("button", { name: "Check now" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("can be pressed when nothing else is going on", () => {
    provide(check());

    expect(screen.getByRole("button", { name: "Check now" })).toBeEnabled();
  });

  it.each(BLOCKED<Partial<ComponentProps<typeof ActionButton>>>({}))("cannot be pressed when %s", (_reason, props, overrides) => {
    provide(check(props), overrides);

    expect(screen.getByRole("button", { name: "Check now" })).toBeDisabled();
  });

  it("shows progress only while its own action is pending", () => {
    const { unmount } = provide(check(), { pending: "check-verification" });
    expect(screen.getByRole("button", { name: "Check now" }).querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    unmount();

    provide(check(), { pending: "verify" });
    expect(screen.getByRole("button", { name: "Check now" }).querySelector("svg")).toBeNull();
  });
});

describe("focus after an action", () => {
  const FAILED: SetupState = makeState("credentials", { error: { step: "credentials", message: "gh: HTTP 403" } });

  // Starts saving the credentials and leaves the request in flight, with the confirmation already gone.
  async function startSaving() {
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: makeState("credentials") });
    transport.act.mockReturnValueOnce(gate.promise);
    const { user } = mount(transport, makeState("credentials"));
    const trigger = within(panel("credentials")).getByRole("button", { name: "Save credentials to this repository" });

    await user.click(trigger);
    await pressInDialog(user, "Save credentials");
    await waitFor(() => expect(trigger).toBeDisabled());
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    return { gate, trigger };
  }

  it("returns to the button after a failure, so the user can try again", async () => {
    const { gate, trigger } = await startSaving();
    expect(document.body).toHaveFocus();

    await act(async () => {
      gate.reject(new SetupApiError("gh: HTTP 403", 502, FAILED));
    });

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(trigger).toHaveFocus();
  });

  it("goes to the step heading when the button stays disabled", async () => {
    const { gate, trigger } = await startSaving();

    await act(async () => {
      gate.reject(new SetupApiError("Setup expired. Restart npm run setup.", 410));
    });

    await waitFor(() => expect(heading("credentials")).toHaveFocus());
    expect(trigger).toBeDisabled();
  });

  it("leaves focus alone when the user moved to another control meanwhile", async () => {
    const { gate, trigger } = await startSaving();
    const copy = screen.getByRole("button", { name: "Copy command" });
    copy.focus();

    await act(async () => {
      gate.reject(new SetupApiError("gh: HTTP 403", 502, FAILED));
    });

    await waitFor(() => expect(trigger).toBeEnabled());
    expect(copy).toHaveFocus();
  });

  it("restores focus to a read-only check once it finishes", async () => {
    const running = makeState("install", { installation: { status: "running", run: null } });
    const gate = deferred<SetupState>();
    const transport = fakeTransport({ state: running });
    transport.act.mockReturnValueOnce(gate.promise);
    mount(transport, running);
    const button = within(panel("install")).getByRole("button", { name: "Check verification result" });

    // A browser drops focus to the page when the focused button becomes disabled, but jsdom keeps it there
    // and cannot blur a disabled control. Clicking without focusing leaves focus on the page, as a browser would.
    fireEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(document.body).toHaveFocus();
    await act(async () => {
      gate.resolve(running);
    });

    await waitFor(() => expect(button).toBeEnabled());
    expect(button).toHaveFocus();
  });
});

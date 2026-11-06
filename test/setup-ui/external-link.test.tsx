import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { CopyButton, ExternalLinkButton } from "@/components/setup/external-link";
import { fakeTransport } from "./fixtures";
import { provide } from "./mount";

const URL = "https://github.com/apps/ci-cd-optimizer-acme/installations/new";

// Records whether the page had already cancelled each click, then cancels it so jsdom does not navigate.
// React handles clicks at its root, which runs before a listener on the document.
function watchClicks() {
  const cancelled: boolean[] = [];
  const listener = (event: Event) => {
    cancelled.push(event.defaultPrevented);
    event.preventDefault();
  };
  document.addEventListener("click", listener);
  onTestFinished(() => document.removeEventListener("click", listener));
  return cancelled;
}

const install = <ExternalLinkButton url={URL}>Install on GitHub</ExternalLinkButton>;

describe("ExternalLinkButton", () => {
  it("is a real link that opens in a new tab without exposing this page", () => {
    provide(install);

    const link = screen.getByRole("link", { name: "Install on GitHub (opens in a new tab)" });
    expect(link).toHaveAttribute("href", URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("lets the browser follow the link when the host offers no way to open it", async () => {
    const cancelled = watchClicks();
    const { user } = provide(install, { transport: fakeTransport() });

    await user.click(screen.getByRole("link", { name: /Install on GitHub/ }));

    expect(cancelled).toEqual([false]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("hands the link to the host instead, and keeps this page where it is", async () => {
    const openExternal = vi.fn(async () => true);
    const cancelled = watchClicks();
    const { user } = provide(install, { transport: fakeTransport({ kind: "mcp", openExternal }) });

    await user.click(screen.getByRole("link", { name: /Install on GitHub/ }));

    expect(openExternal).toHaveBeenCalledExactlyOnceWith(URL);
    expect(cancelled).toEqual([true]);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("explains what to do when the host refuses, and offers the address to copy", async () => {
    const openExternal = vi.fn(async () => false);
    const { user } = provide(install, { transport: fakeTransport({ kind: "mcp", openExternal }) });

    await user.click(screen.getByRole("link", { name: /Install on GitHub/ }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This host did not open the link. Copy the address into your browser instead.");
    expect(within(alert).getByText(URL)).toBeInTheDocument();
    await user.click(within(alert).getByRole("button", { name: "Copy link" }));
    expect(await navigator.clipboard.readText()).toBe(URL);
  });

  it("drops the explanation once the host opens the link", async () => {
    const openExternal = vi.fn<(url: string) => Promise<boolean>>().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const { user } = provide(install, { transport: fakeTransport({ kind: "mcp", openExternal }) });
    const link = screen.getByRole("link", { name: /Install on GitHub/ });

    await user.click(link);
    await screen.findByRole("alert");
    await user.click(link);

    await vi.waitFor(() => expect(screen.queryByRole("alert")).not.toBeInTheDocument());
    expect(openExternal).toHaveBeenCalledTimes(2);
  });
});

// Testing Library settles user-event actions with a timer it only advances under Jest's fake clock, and jsdom's
// FileReader (behind the clipboard stub's readText) waits on one too. These tests therefore click with fireEvent
// and check what was written through a spy.
describe("CopyButton", () => {
  beforeEach(() => {
    // Installs the clipboard stub the component writes to.
    userEvent.setup();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function setup() {
    const view = render(<CopyButton value="npm run setup" label="Copy command" />);
    return { ...view, button: screen.getByRole("button", { name: "Copy command" }) };
  }

  const copy = (button: HTMLElement) =>
    act(async () => {
      fireEvent.click(button);
    });

  function wait(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("copies the value, confirms it, and goes back to its label after two seconds", async () => {
    const { button } = setup();
    const write = vi.spyOn(navigator.clipboard, "writeText");

    await copy(button);

    expect(write).toHaveBeenCalledExactlyOnceWith("npm run setup");
    expect(button).toHaveTextContent("Copied");
    wait(1_999);
    expect(button).toHaveTextContent("Copied");
    wait(1);
    expect(button).toHaveTextContent("Copy command");
  });

  it("announces the result politely instead of interrupting", () => {
    const { button } = setup();

    expect(within(button).getByText("Copy command")).toHaveAttribute("aria-live", "polite");
  });

  it("counts two seconds from the latest copy, not the first", async () => {
    const { button } = setup();
    await copy(button);
    wait(1_500);
    await copy(button);

    wait(500);
    expect(button).toHaveTextContent("Copied");
    wait(1_499);
    expect(button).toHaveTextContent("Copied");
    wait(1);
    expect(button).toHaveTextContent("Copy command");
  });

  it("says so when the clipboard is unavailable, then goes back to its label", async () => {
    const { button } = setup();
    vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));

    await copy(button);

    expect(button).toHaveTextContent("Copy failed");
    wait(2_000);
    expect(button).toHaveTextContent("Copy command");
  });

  it("leaves no timer behind when it unmounts", async () => {
    const { button, unmount } = setup();
    await copy(button);
    expect(vi.getTimerCount()).toBe(1);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });
});

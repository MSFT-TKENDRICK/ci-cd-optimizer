import { render, screen, within } from "@testing-library/react";
import userEvent, { type UserEvent } from "@testing-library/user-event";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { SetupApp } from "@/app";
import { SetupProvider, type SetupContextValue } from "@/components/setup/context";
import type { PollIntervals } from "@/hooks/use-setup-state";
import type { SetupState, SetupStepId } from "@/lib/types";
import { fakeTransport, makeState, type FakeTransport } from "./fixtures";

// Polling is covered by the hook tests, so keep it out of the way unless a test asks for it.
export const QUIET: PollIntervals = { active: 3_600_000, idle: 3_600_000 };
export const FAST: PollIntervals = { active: 25, idle: 25 };

export function mount(transport: FakeTransport, initial: SetupState | null, intervals: PollIntervals = QUIET) {
  const user = userEvent.setup();
  const view = render(<SetupApp transport={transport} initial={initial} intervals={intervals} />);
  return { user, ...view };
}

// Renders one component inside a setup context a test can bend, without the page around it.
// `runAction` is the mock behind `act`; it succeeds unless a test says otherwise.
export function provide(ui: ReactNode, overrides: Partial<Omit<SetupContextValue, "act">> = {}, options?: Parameters<typeof userEvent.setup>[0]) {
  const runAction = vi.fn<SetupContextValue["act"]>(async () => true);
  const value: SetupContextValue = {
    state: makeState("credentials"),
    transport: fakeTransport(),
    fatal: null,
    notice: null,
    pending: null,
    locked: false,
    refresh: vi.fn(async () => {}),
    act: runAction,
    dismissNotice: vi.fn(),
    ...overrides,
  };
  const user = userEvent.setup(options);
  const view = render(<SetupProvider value={value}>{ui}</SetupProvider>);
  return { user, runAction, ...view };
}

export function step(id: SetupStepId): HTMLElement {
  const item = document.querySelector<HTMLElement>(`li[data-step="${id}"]`);
  if (!item) throw new Error(`The page has no "${id}" step.`);
  return item;
}

export function heading(id: SetupStepId): HTMLElement {
  return within(step(id)).getByRole("heading", { level: 2 });
}

// Presses a button inside the open confirmation panel (role "alertdialog").
export async function pressInDialog(user: UserEvent, name: string) {
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name }));
}

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultIntervals, useSetupState, type PollIntervals } from "@/hooks/use-setup-state";
import { SetupApiError } from "@/lib/transport";
import type { SetupState } from "@/lib/types";
import { deferred, fakeTransport, makeState } from "./fixtures";

const INTERVALS: PollIntervals = { active: 100, idle: 500 };
const unreachable = () => new SetupApiError("Could not reach the setup server.", 0);

const flush = (ms = 0) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function setHidden(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
}

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  Reflect.deleteProperty(document, "hidden");
});

describe("polling", () => {
  it("polls straight away when it has no snapshot yet", async () => {
    const transport = fakeTransport({ state: makeState("install") });
    const { result } = renderHook(() => useSetupState(transport, null, INTERVALS));
    expect(result.current.state).toBeNull();
    await flush();
    expect(transport.getState).toHaveBeenCalledTimes(1);
    expect(result.current.state?.current).toBe("install");
  });

  it("waits for the idle interval when it starts from a snapshot", async () => {
    const transport = fakeTransport();
    renderHook(() => useSetupState(transport, makeState("register"), INTERVALS));
    await flush(499);
    expect(transport.getState).not.toHaveBeenCalled();
    await flush(1);
    expect(transport.getState).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a step is running", makeState("install", { busy: true })],
    ["a verification run is pending", makeState("install", { installation: { status: "running", run: null } })],
  ])("polls faster while %s", async (_name, state) => {
    const transport = fakeTransport({ state });
    renderHook(() => useSetupState(transport, state, INTERVALS));
    await flush(100);
    expect(transport.getState).toHaveBeenCalledTimes(1);
    await flush(100);
    expect(transport.getState).toHaveBeenCalledTimes(2);
  });

  it("polls a chat host less often than a browser tab", () => {
    expect(defaultIntervals(fakeTransport({ kind: "http" }))).toEqual({ active: 3_000, idle: 10_000 });
    expect(defaultIntervals(fakeTransport({ kind: "mcp" }))).toEqual({ active: 4_000, idle: 12_000 });
  });

  it("stops polling when unmounted, including a request that was still running", async () => {
    const idle = fakeTransport();
    renderHook(() => useSetupState(idle, makeState("install"), INTERVALS)).unmount();
    await flush(5_000);
    expect(idle.getState).not.toHaveBeenCalled();

    const poll = deferred<SetupState>();
    const running = fakeTransport();
    running.getState.mockReturnValueOnce(poll.promise);
    const { unmount } = renderHook(() => useSetupState(running, null, INTERVALS));
    await flush();
    expect(running.getState).toHaveBeenCalledTimes(1);
    unmount();
    await act(async () => poll.resolve(makeState()));
    await flush(5_000);
    expect(running.getState).toHaveBeenCalledTimes(1);
  });
});

describe("ordering", () => {
  it("never overwrites an action's result with an older poll", async () => {
    const poll = deferred<SetupState>();
    const transport = fakeTransport();
    transport.getState.mockReturnValueOnce(poll.promise);
    const { result } = renderHook(() => useSetupState(transport, makeState("credentials"), INTERVALS));
    await flush(500);
    expect(transport.getState).toHaveBeenCalledTimes(1);

    const saved = makeState("install");
    transport.act.mockResolvedValueOnce(saved);
    await act(async () => {
      await result.current.act("save-credentials");
    });
    expect(result.current.state).toBe(saved);

    await act(async () => poll.resolve(makeState("credentials")));
    await flush();
    expect(result.current.state).toBe(saved);
  });

  it("hands the action payload to the transport and reports success", async () => {
    const transport = fakeTransport();
    const { result } = renderHook(() => useSetupState(transport, makeState("authorize"), INTERVALS));
    let ok = false;
    await act(async () => {
      ok = await result.current.act("authorize-copilot", { token: "fake-token-value" });
    });
    expect(ok).toBe(true);
    expect(transport.act).toHaveBeenCalledWith("authorize-copilot", { token: "fake-token-value" });
  });

  it("tracks the running action and releases it afterwards", async () => {
    const run = deferred<SetupState>();
    const transport = fakeTransport();
    transport.act.mockReturnValueOnce(run.promise);
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    let outcome!: Promise<boolean>;
    await act(async () => {
      outcome = result.current.act("verify");
    });
    expect(result.current.pending).toBe("verify");
    await act(async () => {
      run.resolve(makeState("install", { message: "Verification requested." }));
      await outcome;
    });
    expect(result.current.pending).toBeNull();
    expect(result.current.state?.message).toBe("Verification requested.");
  });
});

describe("fatal states", () => {
  it.each([
    [401, "unauthorized"],
    [410, "expired"],
  ] as const)("locks the page and stops polling after a %i", async (status, kind) => {
    const transport = fakeTransport();
    transport.getState.mockRejectedValue(new SetupApiError("Rejected.", status));
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await flush(500);
    expect(result.current).toMatchObject({ fatal: kind, locked: true });
    transport.getState.mockClear();
    await flush(10_000);
    expect(transport.getState).not.toHaveBeenCalled();
  });

  it("tolerates one missed poll, then reports the server unreachable", async () => {
    const transport = fakeTransport();
    transport.getState.mockRejectedValue(unreachable());
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await flush(500);
    expect(result.current.fatal).toBeNull();
    await flush(100);
    expect(result.current).toMatchObject({ fatal: "unreachable", locked: true });
  });

  it("recovers from unreachable once a check succeeds, and resumes polling", async () => {
    const transport = fakeTransport();
    transport.getState.mockRejectedValue(unreachable());
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await flush(600);
    expect(result.current.fatal).toBe("unreachable");

    transport.getState.mockReset().mockResolvedValue(makeState("install", { message: "Back." }));
    await act(async () => {
      await result.current.refresh();
    });
    expect(result.current).toMatchObject({ fatal: null, locked: false });
    expect(result.current.state?.message).toBe("Back.");
    transport.getState.mockClear();
    await flush(500);
    expect(transport.getState).toHaveBeenCalledTimes(1);
  });

  it("reports an expired session, not an outage, once the deadline has passed", async () => {
    const state = makeState("install", { expiresAt: new Date(Date.now() - 1_000).toISOString() });
    const transport = fakeTransport({ state });
    transport.getState.mockRejectedValue(unreachable());
    const { result } = renderHook(() => useSetupState(transport, state, INTERVALS));
    await flush(500);
    expect(result.current.fatal).toBe("expired");
  });

  it("treats a server-reported expiry as final", async () => {
    const transport = fakeTransport();
    const { result } = renderHook(() => useSetupState(transport, makeState("install", { expired: true }), INTERVALS));
    expect(result.current).toMatchObject({ fatal: "expired", locked: true });
    await flush(10_000);
    expect(transport.getState).not.toHaveBeenCalled();
  });

  it("reports an unreachable server immediately when an action cannot be sent", async () => {
    const transport = fakeTransport();
    transport.act.mockRejectedValue(unreachable());
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    let ok = true;
    await act(async () => {
      ok = await result.current.act("verify");
    });
    expect(ok).toBe(false);
    expect(result.current.fatal).toBe("unreachable");
  });
});

describe("action failures", () => {
  it("shows a rejected precondition as a notice and adopts the state sent with it", async () => {
    const busy = makeState("install", { busy: true });
    const transport = fakeTransport();
    transport.act.mockRejectedValue(new SetupApiError("Another setup step is running. Wait for it to finish.", 409, busy));
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    let ok = true;
    await act(async () => {
      ok = await result.current.act("verify");
    });
    expect(ok).toBe(false);
    expect(result.current.notice).toBe("Another setup step is running. Wait for it to finish.");
    expect(result.current.state).toBe(busy);
    expect(result.current.fatal).toBeNull();
  });

  it("leaves a failure the server recorded on its step instead of repeating it as a notice", async () => {
    const failed = makeState("install", { error: { step: "install", message: "The installation covers all repositories." } });
    const transport = fakeTransport();
    transport.act.mockRejectedValue(new SetupApiError("The installation covers all repositories.", 502, failed));
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await act(async () => {
      await result.current.act("verify");
    });
    expect(result.current.notice).toBeNull();
    expect(result.current.state?.error?.step).toBe("install");
  });

  it("clears a notice when dismissed and when the next action starts", async () => {
    const transport = fakeTransport();
    transport.act.mockRejectedValueOnce(new SetupApiError("Nothing to check yet.", 409));
    const { result } = renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await act(async () => {
      await result.current.act("check-verification");
    });
    expect(result.current.notice).toBe("Nothing to check yet.");
    act(() => result.current.dismissNotice());
    expect(result.current.notice).toBeNull();

    transport.act.mockRejectedValueOnce(new SetupApiError("Nothing to check yet.", 409));
    await act(async () => {
      await result.current.act("check-verification");
    });
    expect(result.current.notice).not.toBeNull();
    const next = deferred<SetupState>();
    transport.act.mockReturnValueOnce(next.promise);
    await act(async () => {
      void result.current.act("verify");
    });
    expect(result.current.notice).toBeNull();
    await act(async () => next.resolve(makeState("install")));
  });
});

describe("waking up", () => {
  it("does not poll while the page is hidden, and catches up when it is shown", async () => {
    setHidden(true);
    const transport = fakeTransport();
    renderHook(() => useSetupState(transport, makeState("install"), INTERVALS));
    await flush(5_000);
    expect(transport.getState).not.toHaveBeenCalled();

    setHidden(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(transport.getState).toHaveBeenCalledTimes(1);
  });

  it("throttles wake-ups so rapid focus changes do not flood the server", async () => {
    const transport = fakeTransport();
    renderHook(() => useSetupState(transport, makeState("install"), { active: 60_000, idle: 60_000 }));
    const focus = () =>
      act(async () => {
        window.dispatchEvent(new Event("focus"));
        await vi.advanceTimersByTimeAsync(0);
      });

    await focus();
    expect(transport.getState).toHaveBeenCalledTimes(1);
    await focus();
    expect(transport.getState).toHaveBeenCalledTimes(1);
    await flush(1_000);
    await focus();
    expect(transport.getState).toHaveBeenCalledTimes(2);
  });
});

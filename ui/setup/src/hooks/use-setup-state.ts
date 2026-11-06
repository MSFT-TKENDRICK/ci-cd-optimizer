import { useCallback, useEffect, useRef, useState } from "react";
import { SetupApiError, type SetupTransport } from "@/lib/transport";
import type { ActionPayload, SetupAction, SetupState } from "@/lib/types";

export interface PollIntervals {
  active: number;
  idle: number;
}

export type FatalKind = "unreachable" | "unauthorized" | "expired";

export interface SetupController {
  state: SetupState | null;
  // Set when the session cannot continue; the page shows how to recover instead of retrying silently.
  fatal: FatalKind | null;
  // An action failure that is not already shown on a step, such as a precondition the server rejected.
  notice: string | null;
  pending: SetupAction | null;
  // True once nothing can be changed from this page.
  locked: boolean;
  refresh(): Promise<void>;
  act(action: SetupAction, payload?: ActionPayload): Promise<boolean>;
  dismissNotice(): void;
}

export const defaultIntervals = (transport: SetupTransport): PollIntervals =>
  transport.kind === "mcp" ? { active: 4_000, idle: 12_000 } : { active: 3_000, idle: 10_000 };

const WAKE_THROTTLE_MS = 1_000;

const isPast = (iso: string | undefined) => iso !== undefined && Date.parse(iso) <= Date.now();

function asApiError(error: unknown): SetupApiError {
  if (error instanceof SetupApiError) return error;
  return new SetupApiError(error instanceof Error && error.message ? error.message : "Setup failed. Retry the current step.", 500);
}

export function useSetupState(transport: SetupTransport, initial: SetupState | null = null, intervals: PollIntervals = defaultIntervals(transport)): SetupController {
  const [state, setState] = useState<SetupState | null>(initial);
  const [fatal, setFatal] = useState<FatalKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<SetupAction | null>(null);
  const clock = useRef({ started: 0, applied: 0 });
  const latest = useRef<SetupState | null>(initial);
  const failures = useRef(0);

  // Polls claim their place when they start and actions claim it when they finish, so a poll that began
  // before an action completed can never overwrite that action's result with older data.
  const claim = useCallback(() => ++clock.current.started, []);

  const apply = useCallback((id: number, next: SetupState) => {
    if (id < clock.current.applied) return;
    clock.current.applied = id;
    latest.current = next;
    setState(next);
  }, []);

  const succeed = useCallback(
    (id: number, next: SetupState) => {
      failures.current = 0;
      setFatal((current) => (current === "unreachable" ? null : current));
      apply(id, next);
    },
    [apply],
  );

  const fail = useCallback(
    (id: number, error: unknown, source: "poll" | "act") => {
      const failure = asApiError(error);
      if (failure.state) apply(id, failure.state);
      if (failure.status === 401) return setFatal("unauthorized");
      if (failure.status === 410) return setFatal("expired");
      if (failure.status === 0) {
        failures.current += 1;
        if (isPast(latest.current?.expiresAt)) setFatal("expired");
        else if (source === "act" || failures.current >= 2) setFatal("unreachable");
        return;
      }
      failures.current = 0;
      // Failures from running a step are recorded in the state and shown on that step.
      if (source === "act" && failure.message !== failure.state?.error?.message) setNotice(failure.message);
    },
    [apply],
  );

  const refresh = useCallback(async () => {
    const id = claim();
    try {
      succeed(id, await transport.getState());
    } catch (error) {
      fail(id, error, "poll");
    }
  }, [transport, claim, succeed, fail]);

  const act = useCallback(
    async (action: SetupAction, payload?: ActionPayload) => {
      setPending(action);
      setNotice(null);
      try {
        const next = await transport.act(action, payload);
        succeed(claim(), next);
        return true;
      } catch (error) {
        fail(claim(), error, "act");
        return false;
      } finally {
        setPending((current) => (current === action ? null : current));
      }
    },
    [transport, claim, succeed, fail],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  const effective: FatalKind | null = state?.expired ? "expired" : fatal;
  const locked = effective !== null;

  useEffect(() => {
    if (locked) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let inflight = false;
    let stopped = false;
    let lastRun = 0;

    const delay = () => {
      const current = latest.current;
      const working = current?.busy === true || current?.installation.status === "running";
      return working || failures.current > 0 ? intervals.active : intervals.idle;
    };

    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => (document.hidden ? schedule() : void tick()), delay());
    };

    const tick = async () => {
      if (inflight) return;
      inflight = true;
      lastRun = Date.now();
      try {
        await refresh();
      } finally {
        inflight = false;
      }
      if (!stopped) schedule();
    };

    // Returning to the tab after installing on GitHub should not wait for the next interval.
    const wake = () => {
      if (document.hidden || inflight || Date.now() - lastRun < WAKE_THROTTLE_MS) return;
      clearTimeout(timer);
      void tick();
    };

    if (latest.current) schedule();
    else void tick();
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("focus", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("focus", wake);
    };
  }, [locked, refresh, intervals.active, intervals.idle]);

  return { state, fatal: effective, notice, pending, locked, refresh, act, dismissNotice };
}

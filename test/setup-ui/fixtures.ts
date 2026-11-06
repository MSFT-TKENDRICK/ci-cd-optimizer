import { vi, type Mock } from "vitest";
import type { SetupTransport } from "@/lib/transport";
import { SETUP_STEP_IDS, type SetupState, type SetupStepId } from "@/lib/types";

const TITLES: Record<SetupStepId, string> = {
  register: "Register the App",
  credentials: "Store the key",
  install: "Install and verify",
  authorize: "Authorize the coding agent",
  scan: "Run the first scan",
};

// A snapshot positioned at `current`; a null `current` means every step is complete.
export function makeState(current: SetupStepId | null = "register", overrides: Partial<SetupState> = {}): SetupState {
  const index = current === null ? SETUP_STEP_IDS.length : SETUP_STEP_IDS.indexOf(current);
  return {
    repo: "acme/widgets",
    owner: "acme",
    organization: true,
    resumed: false,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expired: false,
    busy: false,
    app: index > 0 ? { id: 123, slug: "ci-cd-optimizer-acme" } : null,
    credentials: { saved: index > 1 },
    installation: { status: index > 2 ? "verified" : "unverified", run: null },
    copilot: { saved: index > 3 },
    scan: { requested: index > 4, actionsUrl: "https://github.com/acme/widgets/actions" },
    message: "",
    error: null,
    urls: {
      register: index === 0 ? "http://127.0.0.1:4000/register?session=session-1" : null,
      install: index > 0 ? "https://github.com/apps/ci-cd-optimizer-acme/installations/new" : null,
      tokenSettings: "https://github.com/settings/personal-access-tokens/new",
      setup: "http://127.0.0.1:4000/?session=session-1",
      actions: "https://github.com/acme/widgets/actions",
    },
    registration: index === 0 ? { action: "https://github.com/organizations/acme/settings/apps/new?state=nonce", manifest: '{"name":"ci-cd-optimizer-acme"}' } : null,
    current,
    steps: SETUP_STEP_IDS.map((id, position) => ({
      id,
      title: TITLES[id],
      status: position < index ? "complete" : position === index ? "current" : "upcoming",
    })),
    ...overrides,
  };
}

export interface FakeTransport extends SetupTransport {
  getState: Mock<SetupTransport["getState"]>;
  act: Mock<SetupTransport["act"]>;
}

export function fakeTransport(options: { kind?: "http" | "mcp"; state?: SetupState; openExternal?: SetupTransport["openExternal"] } = {}): FakeTransport {
  const state = options.state ?? makeState();
  const kind = options.kind ?? "http";
  return {
    kind,
    canEnterSecrets: kind === "http",
    getState: vi.fn<SetupTransport["getState"]>(async () => state),
    act: vi.fn<SetupTransport["act"]>(async () => state),
    ...(options.openExternal ? { openExternal: options.openExternal } : {}),
  };
}

// A promise the test settles by hand, to hold a request in flight.
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

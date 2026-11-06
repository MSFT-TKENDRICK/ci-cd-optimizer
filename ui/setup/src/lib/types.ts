export const SETUP_STEP_IDS = ["register", "credentials", "install", "authorize", "scan"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];
export type SetupStepStatus = "complete" | "current" | "upcoming";
export type InstallationStatus = "unverified" | "running" | "verified" | "failed";

export interface SetupStep {
  id: SetupStepId;
  title: string;
  status: SetupStepStatus;
}

// Mirrors the snapshot returned by scripts/setup-session.mjs. It never contains key material.
export interface SetupState {
  repo: string;
  owner: string;
  organization: boolean;
  resumed: boolean;
  expiresAt: string;
  expired: boolean;
  busy: boolean;
  app: { id: number; slug: string } | null;
  credentials: { saved: boolean };
  installation: { status: InstallationStatus; run: { id: number; url: string } | null };
  copilot: { saved: boolean };
  scan: { requested: boolean; actionsUrl: string };
  message: string;
  error: { step: SetupStepId; message: string } | null;
  urls: {
    register: string | null;
    install: string | null;
    tokenSettings: string;
    setup: string;
    actions: string;
  };
  registration: { action: string; manifest: string } | null;
  current: SetupStepId | null;
  steps: SetupStep[];
}

// Typed as a record so adding or removing a SetupState field fails compilation until this is updated.
const STATE_KEY_RECORD: Record<keyof SetupState, true> = {
  repo: true,
  owner: true,
  organization: true,
  resumed: true,
  expiresAt: true,
  expired: true,
  busy: true,
  app: true,
  credentials: true,
  installation: true,
  copilot: true,
  scan: true,
  message: true,
  error: true,
  urls: true,
  registration: true,
  current: true,
  steps: true,
};
export const SETUP_STATE_KEYS: readonly string[] = Object.keys(STATE_KEY_RECORD).sort();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Structural check only: enough to avoid rendering a malformed payload, tolerant of additive server fields.
export function isSetupState(value: unknown): value is SetupState {
  return (
    isRecord(value) &&
    typeof value.repo === "string" &&
    typeof value.expiresAt === "string" &&
    Array.isArray(value.steps) &&
    isRecord(value.urls) &&
    isRecord(value.credentials) &&
    isRecord(value.installation) &&
    isRecord(value.copilot) &&
    isRecord(value.scan)
  );
}

export type SetupAction = "save-credentials" | "verify" | "check-verification" | "authorize-copilot" | "run-scan";

// A token is only ever accepted by the loopback HTTP API, never by an MCP tool.
export interface ActionPayload {
  token?: string;
}

export type McpAction = Exclude<SetupAction, "authorize-copilot">;

export const MCP_TOOLS = {
  open: "cicd_optimizer_setup",
  state: "setup_get_state",
  "save-credentials": "setup_save_credentials",
  verify: "setup_verify",
  "check-verification": "setup_check_verification",
  "run-scan": "setup_run_scan",
} as const satisfies Record<"open" | "state" | McpAction, string>;

export const MCP_RESOURCE_URI = "ui://cicd-optimizer/setup.html";

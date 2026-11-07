import { LoaderCircle } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { SetupState, SetupStepId } from "@/lib/types";
import { ActionButton, ConfirmAction } from "./confirm-action";
import { useSetup } from "./context";
import { ExternalLinkButton } from "./external-link";

const Code = ({ children }: { children: ReactNode }) => <code className="break-all">{children}</code>;

export interface StepContent {
  failureTitle: string;
  // Shown under an upcoming step so people know what is coming.
  hint: string;
  summary: (state: SetupState) => string;
  Body: () => ReactNode;
  // Extra controls on a finished step, for actions worth repeating.
  Complete?: () => ReactNode;
}

function RegisterBody() {
  const { state, transport } = useSetup();
  const { registration, urls } = state;
  return (
    <>
      <p className="text-sm">
        GitHub will ask you to approve a private App owned by <Code>{state.owner}</Code>. It needs Actions read access and write access to
        checks, contents, issues, pull requests, security events and workflows. It requests no account-wide user permissions.
      </p>
      {registration && transport.kind === "http" ? (
        <form method="post" action={registration.action}>
          <input type="hidden" name="manifest" value={registration.manifest} />
          <Button type="submit">Review registration on GitHub</Button>
        </form>
      ) : urls.register ? (
        <div>
          <ExternalLinkButton url={urls.register}>Open the registration page</ExternalLinkButton>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Already saved an App? Restart with <Code>--resume-app YOUR-APP-SLUG</Code> instead of registering another.
      </p>
    </>
  );
}

function CredentialsBody() {
  const { state } = useSetup();
  return (
    <>
      <p className="text-sm">
        The generated key stays in this process until saved. It is never printed, written to disk, or returned to this page. Closing setup
        before saving means generating a replacement key in GitHub.
      </p>
      <p className="text-sm text-muted-foreground">
        Saving writes or replaces <Code>CICD_OPTIMIZER_APP_PRIVATE_KEY</Code> and <Code>CICD_OPTIMIZER_APP_ID</Code> in <Code>{state.repo}</Code>.
      </p>
      <div className="flex flex-col items-start gap-3">
        <ConfirmAction
          action="save-credentials"
          label="Save credentials to this repository"
          title="Save the App credentials?"
          description={
            <>
              This writes or replaces the Actions secret <Code>CICD_OPTIMIZER_APP_PRIVATE_KEY</Code> and the variable{" "}
              <Code>CICD_OPTIMIZER_APP_ID</Code> in <Code>{state.repo}</Code>. The key goes straight to GitHub through the gh CLI on your machine.
            </>
          }
          confirmLabel="Save credentials"
        />
      </div>
    </>
  );
}

type Look = { variant?: "default" | "outline"; size?: "default" | "sm" };

function VerifyAction({ variant, size }: Look) {
  const { state } = useSetup();
  const { installation, resumed, repo } = state;
  const again = installation.status === "verified" || installation.status === "failed";
  return (
    <ConfirmAction
      action="verify"
      label={again ? "Verify again" : "Verify installation"}
      title={again ? "Verify the installation again?" : "Verify the installation?"}
      description={
        resumed ? (
          <>
            This starts the manual verification workflow in <Code>{repo}</Code>. It runs in GitHub Actions with the saved key, checks the
            installation, then creates and revokes a repository-scoped token. It does not run a scan or create findings. It may use Actions
            minutes on your plan.
          </>
        ) : (
          <>
            This process mints a short-lived token for <Code>{repo}</Code> from the new key, reads the repository once, then revokes the token.
            Nothing else is changed.
          </>
        )
      }
      confirmLabel="Verify"
      variant={variant}
      size={size}
      disabled={installation.status === "running"}
    />
  );
}

function InstallBody() {
  const { state, transport } = useSetup();
  const { installation, urls, repo, resumed } = state;
  const running = installation.status === "running";
  return (
    <>
      <p className="text-sm">
        Choose <strong>Only select repositories</strong> and select <Code>{repo}</Code>. Installation gives the App access; it does not
        authorize Copilot as you.
      </p>
      {urls.install ? (
        <div>
          <ExternalLinkButton url={urls.install} variant="outline">
            Install on GitHub
          </ExternalLinkButton>
        </div>
      ) : null}
      <p className="text-sm text-muted-foreground">
        After installing, return to this setup {transport.kind === "mcp" ? "view" : "tab"} and press Verify installation.
      </p>
      {resumed ? (
        <p className="text-sm text-muted-foreground">
          Verification runs in this repository&apos;s GitHub Actions using the saved key. It checks access and creates then revokes a
          repository-scoped token; it does not run a scan, create findings, or assign agents. Actions usage may consume your plan&apos;s allowance.
        </p>
      ) : null}
      {running ? (
        <p role="status" className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 shrink-0 animate-spin" aria-hidden="true" />
          Verification is running. This page checks automatically; you do not need to press another button.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <VerifyAction />
        {running ? <ActionButton action="check-verification">Check verification result</ActionButton> : null}
        {installation.run ? (
          <ExternalLinkButton url={installation.run.url} variant="link">
            View verification run
          </ExternalLinkButton>
        ) : null}
      </div>
    </>
  );
}

function InstallComplete() {
  const { state } = useSetup();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <VerifyAction variant="outline" size="sm" />
      {state.installation.run ? (
        <ExternalLinkButton url={state.installation.run.url} variant="link" size="sm">
          View verification run
        </ExternalLinkButton>
      ) : null}
    </div>
  );
}

function TokenForm() {
  const { state } = useSetup();
  const [token, setToken] = useState("");
  const [open, setOpen] = useState(false);
  const inputId = useId();
  const helpId = useId();
  const ready = token.trim().length > 0;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) setOpen(true);
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>Assignment token</Label>
        <Input
          id={inputId}
          name="assignment-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={helpId}
          data-1p-ignore
          data-lpignore="true"
        />
        <p id={helpId} className="text-sm text-muted-foreground">
          Paste it here to check that it can see <Code>{state.repo}</Code> and save it directly as <Code>COPILOT_ASSIGN_TOKEN</Code>. This cannot
          prove your Copilot license or Issues write permission until an assignment succeeds. Never paste the token into chat.
        </p>
      </div>
      <div className="flex flex-col items-start gap-3">
        <ConfirmAction
          action="authorize-copilot"
          label="Validate and save assignment token"
          title="Save the assignment token?"
          description={
            <>
              The token is checked against <Code>{state.repo}</Code> and saved as the Actions secret <Code>COPILOT_ASSIGN_TOKEN</Code>. Scans use
              it to assign issues to the Copilot coding agent as you, and Copilot usage consumes your plan&apos;s allowance.
            </>
          }
          confirmLabel="Validate and save"
          payload={() => ({ token })}
          onDone={(ok) => {
            if (ok) setToken("");
          }}
          disabled={!ready}
          open={open}
          onOpenChange={setOpen}
        />
      </div>
    </form>
  );
}

function AuthorizeBody() {
  const { state, transport } = useSetup();
  return (
    <>
      <p className="text-sm">
        GitHub requires a Copilot-licensed user&apos;s token to start coding agents; App installation tokens cannot. Create a fine-grained token
        limited to <Code>{state.repo}</Code> with Issues: read and write, and an expiry. Select this repository explicitly on GitHub.
      </p>
      <div>
        <ExternalLinkButton url={state.urls.tokenSettings} variant="outline">
          Create a scoped assignment token on GitHub
        </ExternalLinkButton>
      </div>
      {transport.canEnterSecrets ? (
        <TokenForm />
      ) : (
        <>
          <p className="text-sm">For your security the token is entered only on the local setup page, never in chat.</p>
          <div>
            <ExternalLinkButton url={state.urls.setup}>Open the secure setup page</ExternalLinkButton>
          </div>
        </>
      )}
      <p className="text-sm text-muted-foreground">
        Not authorized yet: <Code>copilot:ready</Code> is a queue label, not a running agent.
      </p>
    </>
  );
}

function RunScanAction({ label, variant, size }: Look & { label: string }) {
  const { state } = useSetup();
  return (
    <ConfirmAction
      action="run-scan"
      label={label}
      title="Run the scan now?"
      description={
        <>
          This starts <Code>cicd-optimizer-scan.yml</Code> in <Code>{state.repo}</Code>. It can create or update issues and pull requests and
          assign coding agents. Copilot usage consumes your plan&apos;s allowance.
        </>
      }
      confirmLabel="Run scan"
      variant={variant}
      size={size}
    />
  );
}

function ScanBody() {
  return (
    <>
      <p className="text-sm">
        This runs the repository&apos;s existing scan workflow, including configured issue and pull request writes and coding-agent assignments.
        Copilot usage consumes your plan&apos;s allowance.
      </p>
      <div className="flex flex-col items-start gap-3">
        <RunScanAction label="Run scan and assign pending findings" />
      </div>
    </>
  );
}

function ScanComplete() {
  const { state } = useSetup();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <ExternalLinkButton url={state.urls.actions} variant="outline" size="sm">
        Open Actions
      </ExternalLinkButton>
      <RunScanAction label="Run again" variant="outline" size="sm" />
    </div>
  );
}

export const STEP_CONTENT: Record<SetupStepId, StepContent> = {
  register: {
    failureTitle: "Registration failed",
    hint: "Create a private GitHub App for this repository's owner.",
    summary: ({ app, resumed }) => (app ? `${resumed ? "Using the saved App" : "App"} ${app.slug} (ID ${app.id})${resumed ? "." : " registered."}` : "App registered."),
    Body: RegisterBody,
  },
  credentials: {
    failureTitle: "Could not save the credentials",
    hint: "Save the App's key and ID to this repository's Actions settings.",
    summary: ({ resumed }) =>
      resumed
        ? "Resumed from repository settings. The private key stays in GitHub; nothing was replaced."
        : "Saved CICD_OPTIMIZER_APP_PRIVATE_KEY and CICD_OPTIMIZER_APP_ID.",
    Body: CredentialsBody,
  },
  install: {
    failureTitle: "Verification failed",
    hint: "Install the App on this repository only, then verify its access.",
    summary: () => "Installation and repository-scoped token verified.",
    Body: InstallBody,
    Complete: InstallComplete,
  },
  authorize: {
    failureTitle: "Could not authorize the coding agent",
    hint: "Provide a scoped token so GitHub can start coding agents.",
    summary: () => "Assignment token saved as COPILOT_ASSIGN_TOKEN. Existing copilot:ready findings are retried by the next scan.",
    Body: AuthorizeBody,
  },
  scan: {
    failureTitle: "Could not start the scan",
    hint: "Run the scan once the earlier steps are done.",
    summary: () => "Scan requested. A dispatch alone does not prove an agent was assigned: check the issue's assignees and its linked pull request.",
    Body: ScanBody,
    Complete: ScanComplete,
  },
};

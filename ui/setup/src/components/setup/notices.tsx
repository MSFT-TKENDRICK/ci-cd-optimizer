import { CircleAlert, Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { FatalKind } from "@/hooks/use-setup-state";
import type { SetupTransport } from "@/lib/transport";

// The region stays in the page so screen readers announce a message that arrives later.
export function StatusMessage({ message }: { message: string }) {
  return (
    <div role="status" className="empty:sr-only">
      {message ? (
        <Alert role="none">
          <Info aria-hidden="true" />
          <AlertDescription className="text-foreground">{message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

export function NoticeAlert({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>That did not go through</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <Button type="button" variant="outline" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
      </AlertDescription>
    </Alert>
  );
}

const FATAL_COPY: Record<FatalKind, Record<SetupTransport["kind"], { title: string; text: string }>> = {
  unreachable: {
    http: {
      title: "Setup server unreachable",
      text: "The setup server stopped or is unreachable. Restart npm run setup, or press Check again if your computer was asleep.",
    },
    mcp: {
      title: "Setup server unreachable",
      text: "Copilot could not reach the setup server. Press Check again, or ask Copilot to run the CI/CD Optimizer setup again.",
    },
  },
  unauthorized: {
    http: {
      title: "This tab is not authorized",
      text: "This tab is not authorized for the running setup server. Reopen the link printed by npm run setup.",
    },
    mcp: {
      title: "This view is not authorized",
      text: "This setup view is no longer authorized. Ask Copilot to run the CI/CD Optimizer setup again.",
    },
  },
  expired: {
    http: { title: "Setup expired", text: "Setup expired after one hour. Restart npm run setup." },
    mcp: { title: "Setup expired", text: "Setup expired after one hour. Ask Copilot to run the CI/CD Optimizer setup again." },
  },
};

export function FatalAlert({ kind, transport, onRetry }: { kind: FatalKind; transport: SetupTransport["kind"]; onRetry: () => void }) {
  const copy = FATAL_COPY[kind][transport];
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{copy.title}</AlertTitle>
      <AlertDescription>
        <p>{copy.text}</p>
        {kind === "unreachable" ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            Check again
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function FailureAlert({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

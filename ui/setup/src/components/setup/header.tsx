import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useSetup } from "./context";

export function SetupTitle() {
  return <h1 className="text-xl font-semibold">CI/CD Optimizer setup</h1>;
}

function expiryLabel(iso: string): string | null {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function SetupHeader() {
  const { state } = useSetup();
  const total = state.steps.length;
  const done = state.steps.filter((step) => step.status === "complete").length;
  const expiry = expiryLabel(state.expiresAt);

  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <SetupTitle />
        {state.resumed ? <Badge variant="secondary">Resumed</Badge> : null}
        {state.expired ? <Badge variant="destructive">Expired</Badge> : expiry ? <Badge variant="outline">Expires {expiry}</Badge> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        Setting up <code className="break-all">{state.repo}</code> in Actions-hosted mode. Register once, install on this repository, and
        authorize the coding-agent handoff. No paid hosting or public webhook is needed.
      </p>
      <div className="flex items-center gap-3">
        <Progress
          value={total ? Math.round((done / total) * 100) : 0}
          aria-label="Setup progress"
          getValueLabel={() => `${done} of ${total} steps complete`}
          className="h-1.5"
        />
        <span aria-hidden="true" className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {done} of {total} done
        </span>
      </div>
    </header>
  );
}

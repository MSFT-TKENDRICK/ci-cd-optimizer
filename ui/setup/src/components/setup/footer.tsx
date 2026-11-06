import { Separator } from "@/components/ui/separator";
import { CopyButton } from "./external-link";
import { useSetup } from "./context";

export function SetupFooter() {
  const { state } = useSetup();
  const resume = state.app ? `npm run setup -- --repo ${state.repo} --resume-app ${state.app.slug}` : null;

  return (
    <footer className="flex flex-col gap-3 text-sm text-muted-foreground">
      <Separator />
      <p>
        The setup server listens only on 127.0.0.1 and expires after one hour. For webhook hosting and a durable database, follow{" "}
        <code>docs/github-app.md</code>.
      </p>
      {resume ? (
        <div className="flex flex-col items-start gap-2">
          <p>To continue later without registering again, run:</p>
          <code className="break-all">{resume}</code>
          <CopyButton value={resume} label="Copy command" />
        </div>
      ) : null}
    </footer>
  );
}

import { applyDocumentTheme, type App } from "@modelcontextprotocol/ext-apps";
import { useApp } from "@modelcontextprotocol/ext-apps/react";
import { useEffect, useMemo, useState } from "react";
import { AppShell, SetupApp } from "@/app";
import { Loading } from "@/components/setup/loading";
import { FailureAlert } from "@/components/setup/notices";
import { parseBootResult, type Boot, type BootOutcome } from "@/lib/boot";
import { createMcpTransport } from "@/lib/transport";

const APP_INFO = { name: "CI/CD Optimizer setup", version: "1.0.0" };

function Connected({ app, boot }: { app: App; boot: Boot }) {
  const transport = useMemo(() => createMcpTransport(app, boot.session), [app, boot.session]);
  return <SetupApp transport={transport} initial={boot.state} />;
}

export function McpSetup() {
  const [outcome, setOutcome] = useState<BootOutcome | null>(null);
  const { app, isConnected, error } = useApp({
    appInfo: APP_INFO,
    capabilities: {},
    // Handlers go on before the handshake so the opening tool result cannot be missed.
    onAppCreated: (created) => {
      created.ontoolresult = (result) => setOutcome(parseBootResult(result));
      created.onhostcontextchanged = (context) => {
        if (context.theme) applyDocumentTheme(context.theme);
      };
    },
  });

  // Only the light/dark choice follows the host; the Clawpilot palette stays authoritative.
  useEffect(() => {
    const theme = app?.getHostContext()?.theme;
    if (isConnected && theme) applyDocumentTheme(theme);
  }, [app, isConnected]);

  if (error) {
    return (
      <AppShell>
        <FailureAlert title="Could not connect to Copilot" message={error.message} />
      </AppShell>
    );
  }
  if (!app || !isConnected) {
    return (
      <AppShell>
        <Loading label="Connecting to Copilot" />
      </AppShell>
    );
  }
  if (!outcome) {
    return (
      <AppShell>
        <Loading label="Waiting for the setup details" />
      </AppShell>
    );
  }
  if ("failure" in outcome) {
    return (
      <AppShell>
        <FailureAlert title="Setup could not start" message={outcome.failure} />
      </AppShell>
    );
  }
  return <Connected key={outcome.boot.session} app={app} boot={outcome.boot} />;
}

import type { ReactNode } from "react";
import { ErrorBoundary } from "@/components/setup/error-boundary";
import { Loading } from "@/components/setup/loading";
import { SetupFooter } from "@/components/setup/footer";
import { SetupHeader, SetupTitle } from "@/components/setup/header";
import { FatalAlert, NoticeAlert, StatusMessage } from "@/components/setup/notices";
import { Stepper } from "@/components/setup/steps";
import { SetupProvider } from "@/components/setup/context";
import { useSetupState, type PollIntervals } from "@/hooks/use-setup-state";
import type { SetupTransport } from "@/lib/transport";
import type { SetupState } from "@/lib/types";

export function AppShell({ children }: { children: ReactNode }) {
  return <main className="mx-auto flex w-full max-w-2xl flex-col gap-5 p-4 sm:p-6">{children}</main>;
}

export interface SetupAppProps {
  transport: SetupTransport;
  initial?: SetupState | null;
  intervals?: PollIntervals;
}

export function SetupApp({ transport, initial = null, intervals }: SetupAppProps) {
  const controller = useSetupState(transport, initial, intervals);
  const { state, fatal, notice, dismissNotice, refresh } = controller;

  if (!state) {
    return (
      <AppShell>
        <SetupTitle />
        {fatal ? <FatalAlert kind={fatal} transport={transport.kind} onRetry={() => void refresh()} /> : <Loading label="Loading setup status" />}
      </AppShell>
    );
  }

  return (
    <AppShell>
      <SetupProvider value={{ ...controller, state, transport }}>
        <SetupHeader />
        <StatusMessage message={state.message} />
        {notice ? <NoticeAlert message={notice} onDismiss={dismissNotice} /> : null}
        {fatal ? <FatalAlert kind={fatal} transport={transport.kind} onRetry={() => void refresh()} /> : null}
        <Stepper />
        <SetupFooter />
      </SetupProvider>
    </AppShell>
  );
}

export { ErrorBoundary };

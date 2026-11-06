import { createContext, useContext } from "react";
import type { SetupController } from "@/hooks/use-setup-state";
import type { SetupTransport } from "@/lib/transport";
import type { SetupState } from "@/lib/types";

export interface SetupContextValue extends Omit<SetupController, "state"> {
  state: SetupState;
  transport: SetupTransport;
}

const SetupContext = createContext<SetupContextValue | null>(null);

export const SetupProvider = SetupContext.Provider;

export function useSetup(): SetupContextValue {
  const value = useContext(SetupContext);
  if (!value) throw new Error("useSetup must be used inside a SetupProvider.");
  return value;
}

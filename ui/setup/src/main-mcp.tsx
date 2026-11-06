import "@/lib/csp-safe";
import { createRoot } from "react-dom/client";
import { ErrorBoundary } from "@/app";
import { McpSetup } from "@/mcp-app";

const container = document.getElementById("root");
if (!container) throw new Error("The setup view is missing its root element.");

// No StrictMode: useApp connects once on mount and does not close the App on unmount.
createRoot(container).render(
  <ErrorBoundary>
    <McpSetup />
  </ErrorBoundary>,
);

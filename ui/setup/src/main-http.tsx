import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ErrorBoundary, SetupApp } from "@/app";
import { createHttpTransport } from "@/lib/transport";

// Created once, outside React, so the launch link's session is taken from the address bar exactly once.
const transport = createHttpTransport();
const container = document.getElementById("root");
if (!container) throw new Error("The setup page is missing its root element.");

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <SetupApp transport={transport} />
    </ErrorBoundary>
  </StrictMode>,
);

import "./csp-safe";
import { createRoot } from "react-dom/client";
import { McpDashboard } from "./mcp-app";

const root = document.getElementById("root");
if (!root) throw new Error("Missing dashboard root");
createRoot(root).render(<McpDashboard />);

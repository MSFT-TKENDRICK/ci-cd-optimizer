#!/usr/bin/env node
// `cicd-mcp`: a read-only MCP server over stdio. See docs/agents.md.
import { runMcp } from "./agents/main.js";

await runMcp(process.argv.slice(2));

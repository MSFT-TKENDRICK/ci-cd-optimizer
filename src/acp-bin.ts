#!/usr/bin/env node
// `cicd-acp`: a read-only Agent Client Protocol agent over stdio. See docs/agents.md.
import { runAcp } from "./agents/main.js";

await runAcp(process.argv.slice(2));

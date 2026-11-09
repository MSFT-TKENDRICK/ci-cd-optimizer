// Process entry points for the stdio agents. src/mcp-bin.ts, src/acp-bin.ts and the plugin bundle
// (src/agent-bundle.ts) call these, so `cicd-mcp`, `cicd-acp` and the zero-install plugin server behave the same.
import { Readable, Writable } from "node:stream";
import { ndJsonStream } from "@agentclientprotocol/sdk";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { createAcpAgent } from "./acp.js";
import { acpCommand, mcpCommand } from "./cli.js";
import { createMcpServer } from "./mcp.js";
import { VERSION } from "../version.js";

// Stdout carries the protocol; anything a dependency logs must go to stderr instead.
function protectStdout(): void {
  console.log = console.error;
  console.info = console.error;
}

export async function runMcp(argv: string[]): Promise<void> {
  protectStdout();
  try {
    const command = await mcpCommand(argv, { cwd: process.cwd(), env: process.env });
    if (command.kind === "help") process.stdout.write(command.text);
    else if (command.kind === "version") process.stdout.write(`${VERSION}\n`);
    else {
      for (const notice of command.notices) process.stderr.write(`cicd-mcp: ${notice}\n`);
      const { root, fallbackRoot, pluginRoot, remote } = command;
      const server = createMcpServer({
        ...(root ? { root } : {}),
        fallbackRoot,
        ...(pluginRoot ? { pluginRoot } : {}),
        ...(remote ? { remote } : {}),
      });
      const stop = () => void server.close().finally(() => process.exit(0));
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await server.connect(new StdioServerTransport());
    }
  } catch (error) {
    process.stderr.write(`cicd-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

export async function runAcp(argv: string[]): Promise<void> {
  protectStdout();
  try {
    const command = acpCommand(argv);
    if (command.kind === "help") process.stdout.write(command.text);
    else if (command.kind === "version") process.stdout.write(`${VERSION}\n`);
    else {
      const stream = ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);
      const connection = createAcpAgent().connect(stream);
      const stop = () => connection.close();
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
      await connection.closed;
    }
  } catch (error) {
    process.stderr.write(`cicd-acp: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}

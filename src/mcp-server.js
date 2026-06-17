#!/usr/bin/env node
// Stdio MCP server: exposes the Codex Computer Use tools to any MCP client
// (Claude Code, Codex, etc.) by proxying through `codex app-server`.
//
// This is the "plugin-style" entry point. Declare it in an MCP client config:
//   { "command": "node", "args": ["/abs/path/src/mcp-server.js"] }
//
// Tool execution still requires the launching client to hold the macOS TCC
// grants Computer Use needs (Accessibility, Input Monitoring, Screen Recording,
// Automation). See src/app-server-client.js.

import { createInterface } from "node:readline";
import { AppServerClient } from "./app-server-client.js";

const client = new AppServerClient();
const out = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
const reply = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32000) =>
  out({ jsonrpc: "2.0", id, error: { code, message } });

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed) handle(trimmed).catch(() => {});
});

async function handle(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;

  // Notifications (no id) need no response.
  if (id === undefined) return;

  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codex-computer-use-bridge", version: "0.2.0" },
      });
    }

    if (method === "tools/list") {
      const { tools } = await client.listTools();
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object" },
        })),
      });
    }

    if (method === "tools/call") {
      const result = await client.callTool(params?.name, params?.arguments ?? {});
      return reply(id, {
        content: result?.content ?? [],
        isError: Boolean(result?.isError),
      });
    }

    if (method === "ping") return reply(id, {});

    return fail(id, `Method not found: ${method}`, -32601);
  } catch (error) {
    return fail(id, error.message);
  }
}

process.on("SIGINT", () => {
  client.stop();
  process.exit(0);
});
process.on("SIGTERM", () => {
  client.stop();
  process.exit(0);
});

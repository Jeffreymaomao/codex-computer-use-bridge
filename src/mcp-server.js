#!/usr/bin/env node
// Stdio MCP server exposing the Codex Computer Use tools to any MCP client.
//
// Two modes:
//   LOCAL  (default): spawns `codex app-server` on THIS machine and drives it.
//   REMOTE (set BRIDGE_URL): forwards tools to a running HTTP bridge over the
//          network — so a teammate runs this locally and operates the desktop
//          of the machine hosting the bridge. Send BRIDGE_TOKEN to authenticate.
//
// Declare it in an MCP client config:
//   { "command": "node", "args": ["/abs/path/src/mcp-server.js"],
//     "env": { "BRIDGE_URL": "http://10.0.0.5:37321", "BRIDGE_TOKEN": "..." } }
//
// LOCAL mode still requires the launching client to hold the macOS TCC grants
// Computer Use needs (Accessibility, Input Monitoring, Screen Recording,
// Automation). REMOTE mode requires those on the bridge host instead.

import { createInterface } from "node:readline";
import { AppServerClient } from "./app-server-client.js";

const REMOTE_URL = process.env.BRIDGE_URL ?? "";
const TOKEN = process.env.BRIDGE_TOKEN ?? "";
const backend = REMOTE_URL ? remoteBackend(REMOTE_URL, TOKEN) : localBackend();

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
  if (id === undefined) return; // notification

  try {
    if (method === "initialize") {
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "codex-computer-use-bridge", version: "0.2.0" },
      });
    }

    if (method === "tools/list") {
      const tools = await backend.listTools();
      return reply(id, {
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema ?? { type: "object" },
        })),
      });
    }

    if (method === "tools/call") {
      const result = await backend.callTool(params?.name, params?.arguments ?? {});
      return reply(id, { content: result?.content ?? [], isError: Boolean(result?.isError) });
    }

    if (method === "ping") return reply(id, {});

    return fail(id, `Method not found: ${method}`, -32601);
  } catch (error) {
    return fail(id, error.message);
  }
}

// --- backends ---------------------------------------------------------------

function localBackend() {
  const client = new AppServerClient();
  const stop = () => client.stop();
  process.on("SIGINT", () => (stop(), process.exit(0)));
  process.on("SIGTERM", () => (stop(), process.exit(0)));
  return {
    async listTools() {
      return (await client.listTools()).tools;
    },
    callTool: (name, args) => client.callTool(name, args),
  };
}

function remoteBackend(baseUrl, token) {
  const url = baseUrl.replace(/\/$/, "");
  const headers = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return {
    async listTools() {
      const res = await fetch(`${url}/computer-use/tools`, { headers });
      if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
      return (await res.json()).tools ?? [];
    },
    async callTool(name, args) {
      const res = await fetch(`${url}/computer-use/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name, arguments: args, raw: true }),
      });
      if (!res.ok) throw new Error(`bridge ${res.status}: ${await res.text()}`);
      return res.json();
    },
  };
}

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { AppServerClient } from "./app-server-client.js";

const execFileAsync = promisify(execFile);

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? "37321");

// Reach Computer Use through `codex app-server` (initialize -> thread/start ->
// mcpServer/tool/call). See src/app-server-client.js for the TCC caveat.
const computerUse = new AppServerClient();

const routes = [
  "GET /health",
  "GET /apps",
  "POST /apps/activate { name }",
  "GET /computer-use/status",
  "GET /computer-use/tools",
  "POST /computer-use/call { name, arguments }",
  "POST /shortcut/run { name, input? }",
  "POST /osascript/run { script } requires BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1",
];

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, { name: "codex-local-bridge", routes });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        mcp: computerUse.status(),
      });
    }

    if (req.method === "GET" && url.pathname === "/apps") {
      const apps = await listVisibleApps();
      return sendJson(res, 200, { apps });
    }

    if (req.method === "POST" && url.pathname === "/apps/activate") {
      const body = await readJson(req);
      requireString(body.name, "name");
      await runAppleScript(`tell application ${quoteAppleScript(body.name)} to activate`);
      return sendJson(res, 200, { ok: true });
    }

    if (req.method === "GET" && url.pathname === "/computer-use/status") {
      return sendJson(res, 200, computerUse.status());
    }

    if (req.method === "GET" && url.pathname === "/computer-use/tools") {
      const result = await computerUse.listTools();
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/computer-use/call") {
      const body = await readJson(req);
      requireString(body.name, "name");
      const result = await computerUse.callTool(body.name, body.arguments ?? {});
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/shortcut/run") {
      const body = await readJson(req);
      requireString(body.name, "name");
      const result = await runShortcut(body.name, body.input);
      return sendJson(res, 200, result);
    }

    if (req.method === "POST" && url.pathname === "/osascript/run") {
      if (process.env.BRIDGE_ALLOW_ARBITRARY_OSASCRIPT !== "1") {
        return sendJson(res, 403, {
          error: "Set BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1 to enable this endpoint.",
        });
      }
      const body = await readJson(req);
      requireString(body.script, "script");
      const result = await runAppleScript(body.script);
      return sendJson(res, 200, result);
    }

    sendJson(res, 404, { error: "not_found", routes });
  } catch (error) {
    sendJson(res, error.statusCode ?? 500, {
      error: error.message,
      mcp: computerUse.status(),
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`codex-local-bridge listening on http://${HOST}:${PORT}`);
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  computerUse.stop();
  server.close(() => process.exit(0));
}

async function listVisibleApps() {
  const script = [
    'tell application "System Events"',
    "  set appNames to name of application processes whose visible is true",
    "end tell",
    'set AppleScript\'s text item delimiters to linefeed',
    "return appNames as text",
  ].join("\n");
  const result = await runAppleScript(script);
  return result.stdout.split("\n").map((name) => name.trim()).filter(Boolean);
}

async function runAppleScript(script) {
  const { stdout, stderr } = await execFileAsync("osascript", ["-e", script], {
    timeout: Number(process.env.OSASCRIPT_TIMEOUT_MS ?? "10000"),
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function runShortcut(name, input) {
  const args = ["run", name];
  if (typeof input === "string" && input.length > 0) {
    args.push("--input-path", input);
  }
  const { stdout, stderr } = await execFileAsync("shortcuts", args, {
    timeout: Number(process.env.SHORTCUTS_TIMEOUT_MS ?? "30000"),
    maxBuffer: 1024 * 1024,
  });
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Invalid JSON body.");
    error.statusCode = 400;
    throw error;
  }
}

function requireString(value, name) {
  if (typeof value === "string" && value.trim()) return;
  const error = new Error(`Missing required string field: ${name}`);
  error.statusCode = 400;
  throw error;
}

function sendJson(res, statusCode, body) {
  const payload = `${JSON.stringify(body, null, 2)}\n`;
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function quoteAppleScript(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

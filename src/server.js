import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, createReadStream, existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { AppServerClient } from "./app-server-client.js";

const execFileAsync = promisify(execFile);

const HOST = process.env.BRIDGE_HOST ?? "127.0.0.1";
const PORT = Number(process.env.BRIDGE_PORT ?? "37321");
// Shared secret for network access. When set, every endpoint except /health
// requires `Authorization: Bearer <token>`. Leave unset only for localhost use.
const TOKEN = process.env.BRIDGE_TOKEN ?? "";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = process.env.BRIDGE_DATA_DIR ?? join(ROOT, "data");
const SHOTS_DIR = join(DATA_DIR, "screenshots");
mkdirSync(SHOTS_DIR, { recursive: true });

// Reach Computer Use through `codex app-server` (initialize -> thread/start ->
// mcpServer/tool/call). See src/app-server-client.js for the TCC caveat.
const computerUse = new AppServerClient();

const routes = [
  "GET  /                                 service info",
  "GET  /health",
  "GET  /apps                             visible app names (AppleScript)",
  "POST /apps/activate    { name }        bring an app to the front",
  "GET  /computer-use/status",
  "GET  /computer-use/tools               list Computer Use tools",
  "POST /computer-use/call     { name, arguments }",
  "POST /computer-use/sequence { app, steps:[{ tool, arguments }] }",
  "GET  /screenshots/<file>               fetch a saved screenshot",
  "POST /shortcut/run     { name, input? }",
  "POST /osascript/run    { script }      needs BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1",
];

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.on("finish", () =>
    console.log(`${req.method} ${url.pathname} -> ${res.statusCode} (${Date.now() - started}ms)`),
  );

  try {
    // /health stays open for liveness checks; everything else needs the token.
    if (url.pathname !== "/health" && !authorized(req)) {
      return sendJson(res, 401, { error: "unauthorized" });
    }

    if (req.method === "GET" && url.pathname === "/") {
      return sendJson(res, 200, { name: "codex-computer-use-bridge", routes });
    }

    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, { ok: true, mcp: computerUse.status() });
    }

    if (req.method === "GET" && url.pathname === "/apps") {
      return sendJson(res, 200, { apps: await listVisibleApps() });
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
      return sendJson(res, 200, await computerUse.listTools());
    }

    if (req.method === "POST" && url.pathname === "/computer-use/call") {
      const body = await readJson(req);
      requireString(body.name, "name");
      const raw = await computerUse.callTool(body.name, body.arguments ?? {});
      // `raw:true` returns the unformatted MCP result (used by the MCP proxy).
      if (body.raw) {
        return sendJson(res, 200, { content: raw?.content ?? [], isError: Boolean(raw?.isError) });
      }
      return sendJson(res, 200, await formatResult(body.name, raw, url));
    }

    if (req.method === "POST" && url.pathname === "/computer-use/sequence") {
      const body = await readJson(req);
      return sendJson(res, 200, await runSequence(body, url));
    }

    if (req.method === "GET" && url.pathname.startsWith("/screenshots/")) {
      return sendFile(res, join(SHOTS_DIR, basename(url.pathname)));
    }

    if (req.method === "POST" && url.pathname === "/shortcut/run") {
      const body = await readJson(req);
      requireString(body.name, "name");
      return sendJson(res, 200, await runShortcut(body.name, body.input));
    }

    if (req.method === "POST" && url.pathname === "/osascript/run") {
      if (process.env.BRIDGE_ALLOW_ARBITRARY_OSASCRIPT !== "1") {
        return sendJson(res, 403, {
          error: "Set BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1 to enable this endpoint.",
        });
      }
      const body = await readJson(req);
      requireString(body.script, "script");
      return sendJson(res, 200, await runAppleScript(body.script));
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
  console.log(`codex-computer-use-bridge listening on http://${HOST}:${PORT}`);
  console.log(`auth: ${TOKEN ? "bearer token required" : "OPEN (localhost only — set BRIDGE_TOKEN before exposing)"}`);
  console.log(`screenshots -> ${SHOTS_DIR}`);
  if (!TOKEN && HOST !== "127.0.0.1" && HOST !== "localhost") {
    console.warn("WARNING: bound to a non-loopback host with no BRIDGE_TOKEN — anyone on the network can control this desktop.");
  }
});

// Constant-time bearer-token check. No token configured => allow (localhost mode).
function authorized(req) {
  if (!TOKEN) return true;
  const header = req.headers["authorization"] ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const want = Buffer.from(TOKEN);
  return given.length === want.length && timingSafeEqual(given, want);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

function shutdown() {
  computerUse.stop();
  server.close(() => process.exit(0));
}

// --- Computer Use result shaping --------------------------------------------

// Turn a raw MCP tool result into readable output: collapse text blocks into a
// single string and persist any screenshots to disk, returning a fetchable URL
// instead of dumping base64 into the response.
async function formatResult(tool, raw, url) {
  const content = raw?.content ?? [];
  const text = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");

  const images = [];
  for (const c of content) {
    if (c.type !== "image" || !c.data) continue;
    const ext = (c.mimeType ?? "image/jpeg").includes("png") ? "png" : "jpg";
    const file = `${Date.now()}-${tool}-${images.length}.${ext}`;
    await writeFile(join(SHOTS_DIR, file), Buffer.from(c.data, "base64"));
    images.push({
      file,
      url: `${url.origin}/screenshots/${file}`,
      path: join(SHOTS_DIR, file),
      mimeType: c.mimeType ?? "image/jpeg",
      bytes: Buffer.byteLength(c.data, "base64"),
    });
  }

  return { ok: !raw?.isError, tool, text, images, isError: Boolean(raw?.isError) };
}

// Run get_app_state(app) once to arm the session, then a list of actions in the
// same thread. Computer Use only needs one get_app_state per session; each
// action already returns fresh state, so callers don't repeat it per step.
async function runSequence(body, url) {
  const steps = Array.isArray(body?.steps) ? body.steps : [];
  if (!steps.length) {
    const error = new Error("`steps` must be a non-empty array of { tool, arguments }.");
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  if (typeof body.app === "string" && body.app.trim()) {
    const state = await computerUse.callTool("get_app_state", { app: body.app });
    results.push(await formatResult("get_app_state", state, url));
  }

  for (const step of steps) {
    const tool = step.tool ?? step.name;
    if (typeof tool !== "string" || !tool.trim()) {
      const error = new Error("Each step needs a `tool` (or `name`) string.");
      error.statusCode = 400;
      throw error;
    }
    const raw = await computerUse.callTool(tool, step.arguments ?? {});
    const formatted = await formatResult(tool, raw, url);
    results.push(formatted);
    if (formatted.isError) break; // stop on first failure
  }

  return { ok: results.every((r) => !r.isError), app: body.app ?? null, results };
}

// --- macOS helpers ----------------------------------------------------------

async function listVisibleApps() {
  const script = [
    'tell application "System Events"',
    "  set appNames to name of application processes whose visible is true",
    "end tell",
    "set AppleScript's text item delimiters to linefeed",
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
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

async function runShortcut(name, input) {
  const args = ["run", name];
  if (typeof input === "string" && input.length > 0) args.push("--input-path", input);
  const { stdout, stderr } = await execFileAsync("shortcuts", args, {
    timeout: Number(process.env.SHORTCUTS_TIMEOUT_MS ?? "30000"),
    maxBuffer: 1024 * 1024,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// --- HTTP plumbing ----------------------------------------------------------

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

function sendFile(res, path) {
  if (!existsSync(path)) return sendJson(res, 404, { error: "not_found" });
  const type = path.endsWith(".png") ? "image/png" : "image/jpeg";
  res.writeHead(200, { "content-type": type });
  createReadStream(path).pipe(res);
}

function quoteAppleScript(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

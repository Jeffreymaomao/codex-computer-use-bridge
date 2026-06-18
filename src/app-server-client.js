import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

// Resolve the codex binary that exposes `app-server` on THIS machine, so the
// bridge works on anyone's install without hardcoding a path. Order:
//   1. CODEX_BIN override.
//   2. The standalone install managed by the Codex installer.
//   3. `codex` found anywhere on PATH (npm -g, Homebrew, ~/.local/bin, …).
//   4. Common bin locations and the bundled GUI copy.
// Returns the first that exists; if none do, returns the standalone path so the
// spawn failure points at the expected location. (The user must have Codex
// installed — this only locates it, it can't fetch it.)
function resolveCodexBin() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;

  const onPath = (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => join(dir, "codex"));

  const candidates = [
    `${homedir()}/.codex/packages/standalone/current/codex`,
    ...onPath,
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    `${homedir()}/.local/bin/codex`,
    "/Applications/Codex.app/Contents/Resources/codex",
  ];
  return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Drives `codex app-server` over stdio (newline-delimited JSON-RPC) and reaches
 * the Computer Use tools through `mcpServer/tool/call`.
 *
 * This is the supported wiring: app-server itself launches the computer-use MCP
 * inside a thread and attaches its reverse channel, which a bare
 * `SkyComputerUseClient mcp` started over plain stdio never gets.
 *
 * NOTE: actual tool execution requires the *responsible* (top-level launching)
 * process to hold the macOS TCC grants Computer Use needs — Accessibility,
 * Input Monitoring, Screen Recording and Automation. Launch the bridge from a
 * Terminal that has those, not from a sandboxed host.
 */
export class AppServerClient {
  constructor({
    command = resolveCodexBin(),
    serverName = process.env.COMPUTER_USE_SERVER_NAME ?? "computer-use",
    requestTimeoutMs = Number(process.env.APP_SERVER_REQUEST_TIMEOUT_MS ?? "60000"),
    readyTimeoutMs = Number(process.env.APP_SERVER_READY_TIMEOUT_MS ?? "20000"),
  } = {}) {
    this.command = command;
    this.args = ["app-server"];
    this.serverName = serverName;
    this.requestTimeoutMs = requestTimeoutMs;
    this.readyTimeoutMs = readyTimeoutMs;

    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializing = null;
    this.threadId = null;
    this.threadStarting = null;
    this.readyServers = new Set();
    this.stderrTail = [];
    this.lastError = null;
  }

  status() {
    return {
      running: Boolean(this.proc && this.proc.exitCode === null),
      initialized: this.initialized,
      threadId: this.threadId,
      serverName: this.serverName,
      serverReady: this.readyServers.has(this.serverName),
      command: this.command,
      lastError: this.lastError,
      stderrTail: this.stderrTail.slice(-20),
    };
  }

  async listTools() {
    await this.ensureThread();
    const res = await this.request("mcpServerStatus/list", { detail: "full" });
    const entry = (res?.data ?? []).find((s) => s.name === this.serverName);
    if (!entry) {
      return { server: this.serverName, found: false, tools: [] };
    }
    const tools = Object.values(entry.tools ?? {});
    return { server: this.serverName, found: true, tools };
  }

  async callTool(tool, toolArguments = {}) {
    const threadId = await this.ensureThread();
    return this.request(
      "mcpServer/tool/call",
      { server: this.serverName, threadId, tool, arguments: toolArguments },
      this.requestTimeoutMs,
    );
  }

  // ---- lifecycle ----------------------------------------------------------

  start() {
    if (this.proc && this.proc.exitCode === null) return;

    this.proc = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"] });
    this.initialized = false;
    this.initializing = null;
    this.threadId = null;
    this.threadStarting = null;
    this.readyServers = new Set();
    this.stderrTail = [];

    const stdout = createInterface({ input: this.proc.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = createInterface({ input: this.proc.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    const fail = (error) => {
      this.lastError = error.message;
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.initialized = false;
      this.initializing = null;
      this.threadId = null;
      this.threadStarting = null;
    };

    this.proc.on("exit", (code, signal) =>
      fail(new Error(`app-server exited: code=${code} signal=${signal}`)),
    );
    this.proc.on("error", fail);
  }

  stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill();
  }

  async ensureInitialized() {
    this.start();
    if (this.initialized) return;
    if (!this.initializing) {
      this.initializing = (async () => {
        await this.request("initialize", {
          clientInfo: { name: "codex-local-bridge", version: "0.1.0" },
          capabilities: { experimentalApi: true },
        });
        this.notify("initialized", {});
        this.initialized = true;
      })();
    }
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async ensureThread() {
    await this.ensureInitialized();
    if (this.threadId) return this.threadId;
    if (!this.threadStarting) {
      this.threadStarting = (async () => {
        const res = await this.request("thread/start", {});
        this.threadId = res?.thread?.id ?? res?.threadId ?? res?.id;
        if (!this.threadId) throw new Error("thread/start returned no thread id");
        await this.waitForServerReady();
        return this.threadId;
      })();
    }
    try {
      return await this.threadStarting;
    } finally {
      this.threadStarting = null;
    }
  }

  waitForServerReady() {
    if (this.readyServers.has(this.serverName)) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        if (this.readyServers.has(this.serverName) || Date.now() - started > this.readyTimeoutMs) {
          clearInterval(timer);
          resolve();
        }
      }, 100);
    });
  }

  // ---- JSON-RPC over stdio ------------------------------------------------

  request(method, params, timeoutMs = this.requestTimeoutMs) {
    this.start();
    const id = this.nextId++;
    const payload = { jsonrpc: "2.0", id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      this.proc.stdin.write(`${JSON.stringify(payload)}\n`, (error) => {
        if (!error) return;
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  notify(method, params) {
    this.start();
    this.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  handleLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      this.stderrTail.push(`non-json stdout: ${trimmed.slice(0, 200)}`);
      return;
    }

    // Server -> client request: we don't drive interactive approvals, so reject
    // anything that expects a reply rather than letting the peer hang.
    if (message.id !== undefined && message.method) {
      this.proc.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32601, message: `unhandled server request: ${message.method}` },
        })}\n`,
      );
      return;
    }

    // Notification.
    if (message.id === undefined) {
      if (
        message.method === "mcpServer/startupStatus/updated" &&
        message.params?.status === "ready" &&
        typeof message.params?.name === "string"
      ) {
        this.readyServers.add(message.params.name);
      }
      return;
    }

    // Response to one of our requests.
    const entry = this.pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pending.delete(message.id);
    if (message.error) {
      entry.reject(new Error(JSON.stringify(message.error)));
    } else {
      entry.resolve(message.result);
    }
  }
}

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export class McpClient {
  constructor({ command, args = [], cwd, timeoutMs = 10000 }) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.proc = null;
    this.nextId = 1;
    this.pending = new Map();
    this.initialized = false;
    this.initializing = null;
    this.queue = Promise.resolve();
    this.stderrTail = [];
  }

  status() {
    return {
      running: Boolean(this.proc && !this.proc.killed && this.proc.exitCode === null),
      initialized: this.initialized,
      command: this.command,
      args: this.args,
      cwd: this.cwd,
      stderrTail: this.stderrTail.slice(-20),
    };
  }

  async listTools() {
    return this.runExclusive(async () => {
      await this.ensureInitialized();
      return this.request("tools/list", {});
    });
  }

  async callTool(name, toolArguments = {}) {
    return this.runExclusive(async () => {
      await this.ensureInitialized();
      return this.request("tools/call", {
        name,
        arguments: toolArguments,
      });
    });
  }

  runExclusive(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => {});
    return run;
  }

  async ensureInitialized() {
    this.start();
    if (this.initialized) return;
    if (this.initializing) return this.initializing;

    this.initializing = this.initialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async initialize() {
    await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: {
        name: "codex-local-bridge",
        version: "0.1.0",
      },
    });

    this.notify("notifications/initialized", {});
    this.initialized = true;
  }

  start() {
    if (this.proc && this.proc.exitCode === null) return;

    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.initialized = false;
    this.stderrTail = [];

    const stdout = createInterface({ input: this.proc.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = createInterface({ input: this.proc.stderr });
    stderr.on("line", (line) => {
      this.stderrTail.push(line);
      if (this.stderrTail.length > 50) this.stderrTail.shift();
    });

    this.proc.on("exit", (code, signal) => {
      const error = new Error(`MCP process exited: code=${code} signal=${signal}`);
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.initialized = false;
      this.initializing = null;
    });

    this.proc.on("error", (error) => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(error);
      }
      this.pending.clear();
      this.initialized = false;
      this.initializing = null;
    });
  }

  stop() {
    if (!this.proc || this.proc.exitCode !== null) return;
    this.proc.kill();
    this.initialized = false;
    this.initializing = null;
  }

  request(method, params) {
    this.start();

    const id = this.nextId++;
    const payload = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.stop();
        reject(new Error(`MCP request timed out: ${method}`));
      }, this.timeoutMs);

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
    const payload = {
      jsonrpc: "2.0",
      method,
      params,
    };
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  handleLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.stderrTail.push(`non-json stdout: ${line}`);
      return;
    }

    if (typeof message.id === "undefined") return;

    const entry = this.pending.get(message.id);
    if (!entry) return;

    clearTimeout(entry.timer);
    this.pending.delete(message.id);

    if (message.error) {
      entry.reject(new Error(JSON.stringify(message.error)));
      return;
    }

    entry.resolve(message.result);
  }
}

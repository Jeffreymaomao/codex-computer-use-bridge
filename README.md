# Codex Computer Use Bridge

Control native macOS apps from your own code by reaching **Codex Computer Use** the supported
way — through `codex app-server` — and exposing it over both an **HTTP API** and a **stdio MCP
server**.

```
your code ──HTTP──┐
                  ├─► codex-computer-use-bridge ─► codex app-server ─► computer-use ─► macOS UI
MCP client ──stdio─┘
```

Tools: `list_apps`, `get_app_state`, `click`, `type_text`, `press_key`, `scroll`, `drag`,
`set_value`, `select_text`, `perform_secondary_action`. For text entry prefer `set_value` over
`type_text` — see [Usage tips](#usage-tips).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and why a bare
`SkyComputerUseClient mcp` can't do this on its own.

## Requirements

- macOS, Node ≥ 20.
- The standalone Codex install at `~/.codex/packages/standalone/current/codex`:
  ```bash
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  ```
  Auto-detected: the bridge also picks up `codex` from your `PATH`, common bin dirs
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`), and the bundled GUI copy at
  `/Applications/Codex.app/Contents/Resources/codex`. Override with `CODEX_BIN`. You must have
  Codex installed — the bridge locates it but can't fetch it.
- **macOS permissions on the launching process** — see [Permissions](#permissions). Without
  them, tool calls hang.

## Run

### HTTP server

```bash
npm start          # listens on http://127.0.0.1:37321
```

```text
GET  /                                 service info
GET  /health
GET  /apps                             visible app names (AppleScript)
POST /apps/activate    { name }        bring an app to the front
GET  /computer-use/status
GET  /computer-use/tools               list Computer Use tools
POST /computer-use/call     { name, arguments }
POST /computer-use/sequence { app, steps:[{ tool, arguments }] }
GET  /screenshots/<file>               fetch a saved screenshot
POST /shortcut/run     { name, input? }
POST /osascript/run    { script }      needs BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1
```

Tool calls return clean output — text in `text`, and any screenshot saved to
`data/screenshots/` with a fetchable `url` (no base64 dumped into the response):

```json
{
  "ok": true,
  "tool": "get_app_state",
  "text": "Computer Use state ...\n<app_state> ... </app_state>",
  "images": [{ "file": "...-get_app_state-0.jpg", "url": "http://127.0.0.1:37321/screenshots/...", "bytes": 134676 }],
  "isError": false
}
```

### MCP server

The stdio entry point is `src/mcp-server.js`. In **LOCAL mode** (default) it spawns
`codex app-server` on the machine the client runs on — so installing it below drives *that*
machine's desktop. To instead control a remote host that's running the bridge, set `BRIDGE_URL`
and `BRIDGE_TOKEN` (see [Team / LAN sharing](#team--lan-sharing)). Use an **absolute path** to
`src/mcp-server.js` in every example below.

> **macOS permissions (local mode):** tool execution needs Accessibility, Screen Recording, Input
> Monitoring, and Automation granted to whatever launches the MCP — your terminal for Claude Code /
> opencode, or Claude Desktop itself. Without them, calls hang. See [Permissions](#permissions).

#### Claude Code

```bash
# user scope → available in every project
claude mcp add computer-use-bridge --scope user -- \
  node /abs/path/codex-computer-use-bridge/src/mcp-server.js

# remote mode (drive a host's desktop): add env with -e
claude mcp add computer-use-bridge --scope user \
  -e BRIDGE_URL=http://100.x.y.z:37321 -e BRIDGE_TOKEN=the-shared-secret -- \
  node /abs/path/codex-computer-use-bridge/src/mcp-server.js
```

Verify with `claude mcp list` or `/mcp` inside Claude Code. (This repo also ships a project-scoped
`.mcp.json`, so launching `claude` from the repo root offers the server automatically.)

#### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`, then restart the app:

```json
{
  "mcpServers": {
    "computer-use-bridge": {
      "command": "node",
      "args": ["/abs/path/codex-computer-use-bridge/src/mcp-server.js"]
    }
  }
}
```

For remote mode, add `"env": { "BRIDGE_URL": "http://100.x.y.z:37321", "BRIDGE_TOKEN": "..." }`.

#### opencode

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "computer-use-bridge": {
      "type": "local",
      "command": ["node", "/abs/path/codex-computer-use-bridge/src/mcp-server.js"],
      "enabled": true
    }
  }
}
```

For remote mode, keep `"type": "local"` and add
`"environment": { "BRIDGE_URL": "http://100.x.y.z:37321", "BRIDGE_TOKEN": "..." }` — the proxy
forwards to the host bridge. (Don't point opencode's `"type": "remote"` at the bridge's HTTP port:
`/computer-use/*` is a plain JSON API, not the MCP-over-HTTP transport opencode expects.)

#### Any other MCP client

Register a **stdio** server whose command is
`node /abs/path/codex-computer-use-bridge/src/mcp-server.js` (optionally with `BRIDGE_URL` /
`BRIDGE_TOKEN` in its environment for remote mode).

### Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `BRIDGE_HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on the network (see below). |
| `BRIDGE_PORT` | `37321` | HTTP port. |
| `BRIDGE_TOKEN` | _(unset)_ | Shared secret. When set, every endpoint except `/health` requires `Authorization: Bearer <token>`. **Required before exposing off localhost.** |
| `CODEX_BIN` | standalone, then GUI copy | Path to the `codex` binary. |
| `BRIDGE_URL` | _(unset)_ | MCP server only: forward to a remote bridge instead of running locally (see [Team / LAN sharing](#team--lan-sharing)). |

## Usage tips

- **`get_app_state(app)` once per session**, then chain actions — each action response already
  returns the fresh accessibility tree + screenshot, so you don't repeat `get_app_state` per
  step. (The first action of a session fails until `get_app_state` has run.)
- **Prefer `element_index` over pixels.** `click` takes either `element_index` (from the
  accessibility tree — precise) or `x`/`y` (screenshot pixels, a fallback for elements the tree
  doesn't expose).
- **For text entry, prefer `set_value` over `type_text`.** `type_text` synthesizes keystrokes and
  can return success without inserting anything. For a `(settable, string)` element, write the
  value directly with `set_value`, then `press_key Return` to submit.
- **Element indices renumber on every `get_app_state`.** Use indices from the latest read only;
  inside `/sequence` they come from the `get_app_state` that runs first. A stale index fails with
  `cannotClickOffscreenElement`.
- `/computer-use/sequence` runs `get_app_state(app)` once and then your steps in one request.

```bash
curl -sX POST localhost:37321/computer-use/sequence \
  -H 'content-type: application/json' \
  -d '{"app":"Notes","steps":[
        {"tool":"click","arguments":{"app":"Notes","element_index":"5"}},
        {"tool":"set_value","arguments":{"app":"Notes","element_index":"6","value":"Hello"}},
        {"tool":"press_key","arguments":{"app":"Notes","key":"Return"}}
      ]}'
```

## Permissions

Listing tools works headless. **Executing** a tool needs macOS TCC grants — Accessibility, Input
Monitoring, Screen Recording, and Automation/Apple Events — and macOS attributes them to the
*responsible* (top-level) process that launched the bridge.

Grant those to the **Terminal you run `npm start` from** in System Settings → Privacy & Security.
From the Codex GUI the responsible app is Codex.app (already granted). A host without them — or
lacking the `com.apple.security.automation.apple-events` entitlement — makes tool calls hang.
The AppleScript endpoints (`/apps`, `/osascript/run`) need Automation permission for the same
terminal.

## Team / LAN sharing

Let trusted teammates on your internal network drive **your** machine's Computer Use. The bridge
runs on your Mac (the one with the macOS permissions); teammates connect to it — they need no
Codex install and no permissions of their own.

> ⚠️ This grants remote control of your real desktop — clicks, keystrokes, screenshots,
> clipboard, AppleScript. Only expose it to people you trust, always set `BRIDGE_TOKEN`, and
> prefer a private overlay network (Tailscale/WireGuard/VPN) over a raw LAN. Never expose it to
> the public internet.

### Host (you)

```bash
export BRIDGE_TOKEN="$(openssl rand -hex 24)"   # share this secret with teammates
BRIDGE_HOST=0.0.0.0 BRIDGE_PORT=37321 npm start # or bind to your Tailscale IP instead of 0.0.0.0
```

Find the address teammates use: your Tailscale IP (`tailscale ip -4`) or LAN IP
(`ipconfig getifaddr en0`). The server refuses every request without the token (except
`/health`).

### Teammate — as an MCP server (recommended)

They run the proxy locally; their MCP client talks to it, and it forwards to your bridge:

```jsonc
{
  "mcpServers": {
    "computer-use-bridge": {
      "command": "node",
      "args": ["/abs/path/codex-computer-use-bridge/src/mcp-server.js"],
      "env": { "BRIDGE_URL": "http://100.x.y.z:37321", "BRIDGE_TOKEN": "the-shared-secret" }
    }
  }
}
```

### Teammate — as plain HTTP

```bash
curl -sX POST http://100.x.y.z:37321/computer-use/call \
  -H "authorization: Bearer the-shared-secret" \
  -H 'content-type: application/json' \
  -d '{"name":"list_apps","arguments":{}}'
```

## Run at login (optional)

```bash
cp launchd/com.codex-computer-use-bridge.plist ~/Library/LaunchAgents/
# edit the path inside the plist to your clone, then:
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.codex-computer-use-bridge.plist
launchctl kickstart -k gui/$(id -u)/com.codex-computer-use-bridge
```

## Layout

```
src/server.js              HTTP API
src/mcp-server.js          stdio MCP server
src/app-server-client.js   drives codex app-server
skills/computer-use-bridge/SKILL.md   agent usage + confirmation policy
.codex-plugin/plugin.json  plugin manifest    .mcp.json  MCP declaration
docs/ARCHITECTURE.md       how it works + the TCC requirement
scripts/smoke.js           quick end-to-end check
```

## License

MIT — see [LICENSE](LICENSE).

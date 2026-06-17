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
`set_value`, `select_text`, `perform_secondary_action`.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for how it works and why a bare
`SkyComputerUseClient mcp` can't do this on its own.

## Requirements

- macOS, Node ≥ 20.
- The standalone Codex install at `~/.codex/packages/standalone/current/codex`:
  ```bash
  curl -fsSL https://chatgpt.com/codex/install.sh | sh
  ```
  Falls back to `/Applications/Codex.app/Contents/Resources/codex`; override with `CODEX_BIN`.
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

For MCP clients (Claude Code, Codex, …) point them at the stdio entry point:

```jsonc
{
  "mcpServers": {
    "computer-use-bridge": {
      "command": "node",
      "args": ["/abs/path/codex-computer-use-bridge/src/mcp-server.js"]
    }
  }
}
```

## Usage tips

- **`get_app_state(app)` once per session**, then chain actions — each action response already
  returns the fresh accessibility tree + screenshot, so you don't repeat `get_app_state` per
  step. (The first action of a session fails until `get_app_state` has run.)
- **Prefer `element_index` over pixels.** `click` takes either `element_index` (from the
  accessibility tree — precise) or `x`/`y` (screenshot pixels, a fallback for elements the tree
  doesn't expose).
- `/computer-use/sequence` runs `get_app_state(app)` once and then your steps in one request.

```bash
curl -sX POST localhost:37321/computer-use/sequence \
  -H 'content-type: application/json' \
  -d '{"app":"Notes","steps":[
        {"tool":"click","arguments":{"app":"Notes","element_index":"5"}},
        {"tool":"type_text","arguments":{"app":"Notes","text":"Hello"}},
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

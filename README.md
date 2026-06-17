# Codex Local Bridge

Local HTTP bridge for macOS automation plus a bridge to Codex Computer Use.

It reaches Computer Use the supported way: it spawns `codex app-server` and drives it over
stdio JSON-RPC (`initialize` → `thread/start` → `mcpServer/tool/call`). app-server itself
launches the `computer-use` MCP inside the thread and wires its reverse channel — which a bare
`SkyComputerUseClient mcp` started over plain stdio never gets, so direct-stdio tool calls hang.

Requires the standalone Codex install (`~/.codex/packages/standalone/current/codex`); install
it with `curl -fsSL https://chatgpt.com/codex/install.sh | sh` if missing. The bridge falls back
to `/Applications/Codex.app/Contents/Resources/codex`. Override with `CODEX_BIN`.

## Run

```bash
npm start
```

The server listens on:

```text
http://127.0.0.1:37321
```

## Endpoints

```text
GET  /health
GET  /apps
POST /apps/activate        { "name": "Safari" }
GET  /computer-use/status
GET  /computer-use/tools
POST /computer-use/call    { "name": "list_apps", "arguments": {} }
POST /shortcut/run         { "name": "Shortcut Name" }
POST /osascript/run        { "script": "..." }
```

`/osascript/run` is disabled by default. Enable it only on localhost:

```bash
BRIDGE_ALLOW_ARBITRARY_OSASCRIPT=1 npm start
```

## Examples

```bash
curl http://127.0.0.1:37321/health
curl http://127.0.0.1:37321/apps
curl http://127.0.0.1:37321/computer-use/tools
curl -X POST http://127.0.0.1:37321/apps/activate \
  -H 'content-type: application/json' \
  -d '{"name":"Safari"}'
```

## LaunchAgent

Install:

```bash
mkdir -p ~/Library/LaunchAgents
cp launchd/com.yangchangmao.codex-local-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yangchangmao.codex-local-bridge.plist
launchctl enable gui/$(id -u)/com.yangchangmao.codex-local-bridge
launchctl kickstart -k gui/$(id -u)/com.yangchangmao.codex-local-bridge
```

Uninstall:

```bash
launchctl bootout gui/$(id -u)/com.yangchangmao.codex-local-bridge
rm ~/Library/LaunchAgents/com.yangchangmao.codex-local-bridge.plist
```

Logs:

```bash
tail -f /tmp/codex-local-bridge.out.log /tmp/codex-local-bridge.err.log
```

## macOS permission requirement (important)

Listing tools (`/computer-use/tools`) works headless. **Executing** a Computer Use tool
(`list_apps`, `click`, `get_app_state`, …) needs macOS TCC grants — Accessibility, Input
Monitoring, Screen Recording, and Automation/Apple Events.

macOS attributes those to the *responsible* process: whatever sits at the top of the launch
chain that ran `npm start`. So launch the bridge from a **Terminal that has been granted** those
permissions in System Settings → Privacy & Security. If the launching process lacks them (e.g. a
sandboxed host without the `com.apple.security.automation.apple-events` entitlement), the request
can't be satisfied and the tool call hangs — installing more software does not fix this.

The same applies to the AppleScript endpoints (`/apps`, `/osascript/run`), which need Automation
permission for the launching terminal.

## Verification

```text
/health                      ok
/computer-use/tools          lists all 10 computer-use tools via app-server
/computer-use/status         running / initialized / threadId / serverReady=true
/computer-use/call <tool>    executes only when launched from a TCC-permissioned terminal
```

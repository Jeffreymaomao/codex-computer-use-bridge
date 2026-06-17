# How it works

## The chain

```
HTTP / MCP client
  -> codex-computer-use-bridge        (this repo: src/server.js or src/mcp-server.js)
       -> codex app-server            (spawned over stdio, newline JSON-RPC)
            initialize
            thread/start               -> threadId
            (app-server launches the `computer-use` MCP inside the thread)
            mcpServer/tool/call        { server:"computer-use", threadId, tool, arguments }
                 -> SkyComputerUseClient mcp
                      -> SkyComputerUseService
                           -> macOS Accessibility / screenshot / keyboard / mouse
```

`src/app-server-client.js` drives `codex app-server` and reaches the tools via
`mcpServer/tool/call`. Tool inventory comes from `mcpServerStatus/list { detail: "full" }`.

## Why not just run `SkyComputerUseClient mcp` directly?

A bare `SkyComputerUseClient mcp` started over plain stdio answers `initialize` and
`tools/list`, but **every `tools/call` hangs** (`No standalone GET stream connected, message
stored for replay`). That MCP is designed to be launched *by* app-server, which attaches a
reverse channel it never gets when started standalone. Going through app-server is the supported
path and the one this bridge uses.

## The real requirement: macOS TCC attribution

Even with everything wired (app-server hosting the MCP, `SkyComputerUseService` running), tool
execution hangs unless the **responsible process** — the top of the launch chain — holds the TCC
grants Computer Use needs: Accessibility, Input Monitoring, Screen Recording, and
Automation/Apple Events.

macOS attributes the permission request to that responsible process. Launch the bridge from a
Terminal that has those permissions (System Settings → Privacy & Security). From the Codex GUI
the responsible app is Codex.app, which is already granted — that is why it "just works" there.
A host without the grants (or without the `com.apple.security.automation.apple-events`
entitlement) cannot satisfy the request, so the call hangs. Installing more software does not fix
this; the fix is granting the launching app those permissions.

## Prerequisite

The standalone Codex install at `~/.codex/packages/standalone/current/codex`:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```

The bridge falls back to `/Applications/Codex.app/Contents/Resources/codex`. Override the binary
with the `CODEX_BIN` environment variable.

# Codex Computer Use MCP 本機調用整理

這份文件整理目前查到的 Codex Computer Use MCP 行為、掛載位置、可用指令，以及如果想在本機做到類似 Codex agent 的 Computer Use 能力，實際上可以和不可以怎麼做。

## 結論

Codex Computer Use 是一個 **stdio MCP server**，不是 localhost HTTP API。

Codex agent 裡看到的：

```text
mcp__computer_use.list_apps
mcp__computer_use.get_app_state
mcp__computer_use.click
```

不是一個可以用 `curl` 或 browser 直接連的 endpoint，而是 Codex runtime 幫 agent 注入的 tool namespace。

外部程式不能直接接到「Codex 這個對話已經開好的 MCP」。原因是 stdio MCP 的 stdin/stdout pipe 是 Codex runtime 和 child process 之間的私有連線，通常只支援 single client。外部硬接 fd 會打亂 JSON-RPC 對話。

如果要自己用，有三條路：

```text
1. 自己啟動 SkyComputerUseClient mcp，自己送 MCP JSON-RPC
2. 在 Codex 對話裡請 agent 呼叫 mcp__computer_use.*
3. 不用 Computer Use MCP，改用 AppleScript / osascript / macOS Accessibility
```

目前測到的限制是：裸跑 `SkyComputerUseClient mcp` 可以 `initialize` 和 `tools/list`，但實際 `tools/call list_apps` 可能會回：

```text
codex app-server exited before returning a response
```

也就是說 Computer Use MCP 不是完全獨立的 binary；它還會依賴 Codex app-server / runtime 這層。

## 檔案位置

目前 plugin cache：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/
```

主要 MCP binary：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient
```

installed copy：

```text
/Users/yangchangmao/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient
```

service app binary，不是 MCP 主入口：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/MacOS/SkyComputerUseService
```

你之前跑的：

```bash
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex\ Computer\ Use.app/Contents/MacOS/SkyComputerUseService --help
```

這支是 service wrapper，不是 `.mcp.json` 裡定義的 MCP server。

## Plugin 掛載方式

Codex config 裡啟用 plugin：

```toml
[plugins."computer-use@openai-bundled"]
enabled = true
```

plugin manifest：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/.codex-plugin/plugin.json
```

裡面有：

```json
{
  "mcpServers": "./.mcp.json",
  "bundledContentVariant": "legacy-mcp"
}
```

MCP 宣告：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/.mcp.json
```

內容：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "./Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "."
    }
  }
}
```

所以掛載鏈路是：

```text
config.toml 啟用 plugin
  -> plugin.json 指向 .mcp.json
  -> .mcp.json 定義 MCP server: computer-use
  -> SkyComputerUseClient mcp
  -> Codex runtime 暴露成 mcp__computer_use.*
```

## Codex Agent 實際做到哪一層

在 Codex agent 裡，我實際呼叫的是 tool namespace：

```json
{
  "recipient_name": "mcp__computer_use.list_apps",
  "parameters": {}
}
```

或：

```json
{
  "recipient_name": "mcp__computer_use.get_app_state",
  "parameters": {
    "app": "Arc"
  }
}
```

我平常不直接跑：

```bash
SkyComputerUseClient mcp
```

也不直接操作它的 stdin/stdout。那層由 Codex runtime 負責。

實際分層：

```text
使用者說「用電腦操作 Arc」
  -> agent 呼叫 mcp__computer_use.*
  -> Codex runtime 轉成 MCP tools/call
  -> SkyComputerUseClient mcp 執行
  -> macOS Accessibility / screenshot / keyboard / mouse
```

## CLI Subcommands

檢查方式：

```bash
cd /Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810

./Codex\ Computer\ Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient --help
```

已知 subcommands：

```text
mcp
event-stream
skysight
turn-ended
```

### `mcp`

主 Computer Use MCP server。

用途：

```text
列 app
讀 app screenshot 和 accessibility tree
點擊
輸入文字
按鍵
拖曳
滾動
設定 accessibility element value
```

raw `tools/list` 看到的 tools：

```text
list_apps
get_app_state
click
perform_secondary_action
set_value
select_text
scroll
drag
press_key
type_text
```

目前 Codex 這個會話中暴露出來的 namespace 少一點，主要有：

```text
mcp__computer_use.list_apps
mcp__computer_use.get_app_state
mcp__computer_use.click
mcp__computer_use.type_text
mcp__computer_use.set_value
mcp__computer_use.scroll
mcp__computer_use.perform_secondary_action
mcp__computer_use.drag
```

### `event-stream mcp`

Record & Replay 用的 MCP server。

啟動：

```bash
SkyComputerUseClient event-stream mcp
```

tools：

```text
event_stream_start
event_stream_status
event_stream_stop
```

用途：

```text
開始記錄使用者操作，最多 30 分鐘
查目前或最近一次錄製狀態
停止錄製
```

### `skysight mcp`

近期活動觀察/記錄用的 MCP server。

啟動：

```bash
SkyComputerUseClient skysight mcp
```

tools：

```text
skysight_start
skysight_stop
skysight_status
skysight_update_exclusion
skysight_list_exclusions
```

用途：

```text
啟動/停止近期活動記錄
查狀態
新增或移除 app / website exclusion
列出 exclusions
```

### `turn-ended`

Codex 回合結束通知用。

你的 config 有：

```toml
notify = ["/Users/yangchangmao/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient", "turn-ended"]
```

它不是桌面控制 MCP tool，而是 Codex turn 結束時呼叫的通知/收尾入口。

## 手動啟動 MCP

互動啟動：

```bash
cd /Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810

./Codex\ Computer\ Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient mcp
```

然後送 MCP JSON-RPC。

initialize：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.1"}}}
```

initialized notification：

```json
{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}
```

列 tools：

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

呼叫 `list_apps`：

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"list_apps","arguments":{}}}
```

呼叫 `get_app_state`：

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_app_state","arguments":{"app":"Arc"}}}
```

點 accessibility element：

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"click","arguments":{"app":"Arc","element_index":"12"}}}
```

點座標：

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"click","arguments":{"app":"Arc","x":420,"y":280}}}
```

## 為什麼不能直接傳給 Codex 已開的 MCP

Codex 啟動時的形態大概是：

```text
Codex runtime
  -> child process: SkyComputerUseClient mcp
       stdin/stdout 只接給 Codex runtime
```

這條連線不是：

```text
localhost:port
unix socket endpoint
HTTP API
多人可連的 server
```

它是 parent/child process 的 pipe。

外部 script 沒有一個乾淨的 API 可以 attach 到那條 pipe。就算用系統技巧找到 fd，也會和 Codex runtime 搶讀 stdout、搶寫 stdin，讓 JSON-RPC stream 壞掉。

所以外部程式的正確做法是：

```text
自己啟動一個新的 SkyComputerUseClient mcp
```

但注意：目前實測裸跑 MCP 的實際 tool call 會碰到 Codex app-server runtime 依賴。

## app-server 依賴

實測：

```text
SkyComputerUseClient mcp
```

可以回：

```text
initialize
tools/list
```

但 `tools/call list_apps` 可能回：

```text
codex app-server exited before returning a response
```

從 binary 字串看到相關訊息：

```text
Launching codex app-server
codex app-server exited before returning a response
/Applications/Codex.app/Contents/Resources/codex
```

也就是它會需要 Codex app-server 參與。

檢查 Codex app-server：

```bash
/Applications/Codex.app/Contents/Resources/codex app-server --help
```

有：

```text
codex app-server
codex app-server daemon
codex app-server proxy
```

嘗試 daemon start：

```bash
/Applications/Codex.app/Contents/Resources/codex app-server daemon start
```

目前這台回：

```text
Error: managed standalone Codex install not found at /Users/yangchangmao/.codex/packages/standalone/current/codex

This command requires the standalone install managed by the Codex installer...
```

所以目前這台的 CLI/app 組合下，外部裸跑 Computer Use MCP 不一定能完整執行 tool call。

## Bash Script 嘗試

目前目錄有：

```text
/Users/yangchangmao/Documents/AppleScript/list_apps_mcp.sh
```

目的：

```text
啟動 SkyComputerUseClient mcp
送 initialize
送 notifications/initialized
送 tools/call list_apps
印出結果
```

目前限制：

```text
這個 script 是真的在 call MCP
但在沒有完整 Codex app-server runtime 的外部 shell 裡，list_apps 可能拿不到成功結果
```

如果要繼續修這個 script，下一步不是調 JSON，而是處理 Codex app-server / standalone install / runtime 依賴。

## Local 常駐 Bridge 實作

目前這個資料夾已補一個最小 Node HTTP bridge：

```text
/Users/yangchangmao/Documents/AppleScript/src/server.js
/Users/yangchangmao/Documents/AppleScript/src/mcp-client.js
/Users/yangchangmao/Documents/AppleScript/launchd/com.yangchangmao.codex-local-bridge.plist
```

啟動：

```bash
npm start
```

預設只綁 localhost：

```text
http://127.0.0.1:37321
```

它做兩件事：

```text
1. 自己啟動 SkyComputerUseClient mcp，透過 stdio JSON-RPC 呼叫 Computer Use tools
2. 提供 macOS automation fallback，例如列可見 app、activate app、跑 Shortcuts / AppleScript
```

已驗證成功：

```bash
curl http://127.0.0.1:37321/health
curl http://127.0.0.1:37321/apps
curl http://127.0.0.1:37321/computer-use/tools
curl -X POST http://127.0.0.1:37321/computer-use/call \
  -H 'content-type: application/json' \
  -d '{"name":"list_apps","arguments":{}}'
```

目前限制：

```text
computer-use/call list_apps 成功
computer-use/call get_app_state(Finder) 目前 30 秒 timeout
```

所以實際可用策略是：

```text
列 app / 讀 Computer Use tool schema：走 Computer Use MCP
activate app / 跑本機 automation：走 AppleScript / Shortcuts
需要 screenshot + accessibility tree：仍要處理 get_app_state timeout
```

常駐方式：

```bash
mkdir -p ~/Library/LaunchAgents
cp launchd/com.yangchangmao.codex-local-bridge.plist ~/Library/LaunchAgents/
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yangchangmao.codex-local-bridge.plist
launchctl enable gui/$(id -u)/com.yangchangmao.codex-local-bridge
launchctl kickstart -k gui/$(id -u)/com.yangchangmao.codex-local-bridge
```

## 自己的 MCP Client 掛載範例

如果你的 MCP client 支援 `mcpServers` 設定，可以加：

```json
{
  "mcpServers": {
    "computer-use": {
      "command": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["mcp"],
      "cwd": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810"
    }
  }
}
```

但這只能解決「如何啟動 MCP server」。如果 tool call 需要 Codex app-server，而你的環境沒有把那層跑起來，還是會失敗。

另外兩個 MCP mode：

```json
{
  "mcpServers": {
    "computer-use-event-stream": {
      "command": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["event-stream", "mcp"],
      "cwd": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810"
    },
    "computer-use-skysight": {
      "command": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient",
      "args": ["skysight", "mcp"],
      "cwd": "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810"
    }
  }
}
```

## macOS 權限

Computer Use 需要 macOS 權限。

如果 app 看不到或不能控制，檢查：

```text
System Settings -> Privacy & Security -> Accessibility
System Settings -> Privacy & Security -> Screen Recording
```

可能需要允許：

```text
Codex
Codex Computer Use
SkyComputerUseClient
Terminal 或你的 MCP client
```

## 內建 App 指引

bundle 裡有幾個 app-specific instruction：

```text
AppleMusic.md
Clock.md
Notion.md
Numbers.md
Spotify.md
iPhone Mirroring.md
```

位置：

```text
/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/Resources/Package_ComputerUseClient.bundle/Contents/Resources/AppInstructions/
```

這些不是限制只能操作這些 app，而是對常見 app 的操作補充說明。

## 實務建議

如果只是要在本機自動化 app：

```text
優先考慮 AppleScript / osascript / Shortcuts / Accessibility scripting
```

如果是要讓 AI agent 看畫面、點擊、輸入：

```text
在 Codex 裡用 [@電腦](plugin://computer-use@openai-bundled)
```

如果是要自己寫 MCP client：

```text
可以掛 SkyComputerUseClient mcp
但要預期它依賴 Codex app-server
需要解決 standalone Codex app-server runtime 後才比較可能完整成功
```

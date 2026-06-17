import { McpClient } from "../src/mcp-client.js";

const MCP_CWD =
  process.env.COMPUTER_USE_MCP_CWD ??
  "/Users/yangchangmao/.codex/plugins/cache/openai-bundled/computer-use/1.0.810";
const MCP_BIN =
  process.env.COMPUTER_USE_MCP_BIN ??
  `${MCP_CWD}/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient`;

const client = new McpClient({
  command: MCP_BIN,
  args: ["mcp"],
  cwd: MCP_CWD,
  timeoutMs: Number(process.env.COMPUTER_USE_MCP_TIMEOUT_MS ?? "30000"),
});

try {
  const result = await client.callTool("list_apps", {});
  const texts = (result.content ?? [])
    .filter((item) => item.type === "text")
    .map((item) => item.text);

  if (result.isError) {
    console.error(texts.join("\n"));
    process.exitCode = 2;
  } else {
    console.log(texts.join("\n"));
  }
} finally {
  client.stop();
}

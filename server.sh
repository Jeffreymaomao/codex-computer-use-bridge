#!/usr/bin/env bash
#
# RESERVED — GPT / OpenAI control-plane tunnel path (tunnel-client).
#
# Intentionally DISABLED. Publishing the Computer Use MCP through the OpenAI
# control plane subjects every tool call to OpenAI's safety checks, which block
# computer-use actions non-deterministically (clicks/typing come back
# "blocked by OpenAI's safety checks") and only work with Codex-side clients.
#
# For real use, drive the bridge LOCALLY instead:
#   pnpm start              # local HTTP bridge on http://127.0.0.1:37321
#   node src/mcp-server.js  # local stdio MCP (point Claude Code / MCP clients here)
#
# The tunnel wiring below is kept for reference only. To run it anyway (not
# recommended), set GPT_TUNNEL_ENABLE=1 and provide TUNNEL_ID (see .env.example).

set -euo pipefail
cd "$(dirname "$0")"

if [[ "${GPT_TUNNEL_ENABLE:-0}" != "1" ]]; then
  cat >&2 <<'MSG'
[server.sh] DISABLED — this is the reserved GPT/OpenAI tunnel path.
Routing Computer Use through the OpenAI control plane gets actions blocked by
OpenAI's safety checks, so this script does not run by default.

Use the local bridge instead:
  pnpm start              # HTTP API   -> http://127.0.0.1:37321
  node src/mcp-server.js  # stdio MCP  -> for Claude Code / other MCP clients

(Override at your own risk: GPT_TUNNEL_ENABLE=1 ./server.sh)
MSG
  exit 1
fi

# --- Reserved tunnel wiring (only runs when GPT_TUNNEL_ENABLE=1) -------------
# Load local secrets/overrides if present (.env is gitignored — see .env.example).
if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# TUNNEL_ID is required and instance-specific — never hardcode it here.
# Get yours at https://platform.openai.com/settings/organization/tunnels
TUNNEL_ID="${TUNNEL_ID:?set TUNNEL_ID in .env (your tunnel_... id)}"
TUNNEL_PROFILE="${TUNNEL_PROFILE:-local-stdio}"
TUNNEL_SAMPLE="${TUNNEL_SAMPLE:-sample_mcp_stdio_local}"
MCP_COMMAND="${MCP_COMMAND:-node ./src/mcp-server.js}"

# `init --force` overwrites manual edits to the profile, so make it opt-in.
PROFILE_FILE="${HOME}/.config/tunnel-client/${TUNNEL_PROFILE}.yaml"
if [[ ! -f "$PROFILE_FILE" || "${TUNNEL_FORCE_INIT:-0}" == "1" ]]; then
  tunnel-client init \
    --sample "$TUNNEL_SAMPLE" \
    --profile "$TUNNEL_PROFILE" \
    --tunnel-id "$TUNNEL_ID" \
    --mcp-command "$MCP_COMMAND" \
    --force
fi

tunnel-client doctor --profile "$TUNNEL_PROFILE" --explain
tunnel-client run --profile "$TUNNEL_PROFILE"

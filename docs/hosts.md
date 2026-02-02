# Host Abstraction

We separate **runtime core** from **host integrations**.

## Packages

### Core runtime (host-agnostic)
- `@w3rt/runtime` (source in `packages/runtime`)
  - workflow runner
  - policy gate
  - trace + artifacts
  - chain tools (Solana/Jupiter currently)

### Host adapters (UI / protocol surfaces)
- `@w3rt/host-pi` (source in `packages/host-pi`)
  - Pi extension commands
  - approval via Pi UI

Future:
- `@w3rt/host-mcp`
  - MCP server for Claude Desktop / Codex Desktop / any MCP client
- `@w3rt/host-openclaw`
  - OpenClaw skill wrapper (optional)

## Compatibility shims
To avoid breaking imports early:
- `@w3rt/core` re-exports `@w3rt/runtime`
- `@w3rt/pi` re-exports `@w3rt/host-pi`

## Start Pi with w3rt host

```bash
bun run build
bun run pi
# (runs: pi -e packages/host-pi/dist/pi-extension.js)
```

# @w3rt/host-mcp

MCP server for Web3 AI Runtime - enables Claude Desktop / ChatGPT Desktop to perform DeFi operations with built-in safety layer.

## Features

- 🔍 **Meteora Pool Monitoring** - Find high-yield DLMM pools
- 💱 **Safe Token Swaps** - Jupiter aggregator with policy gates
- 💰 **Wallet Management** - Check balances across chains
- 📊 **Transaction Tracking** - Full audit trail

## Quick Start

### 1. Build the MCP server

```bash
cd packages/host-mcp
bun install
bun run build
```

### 2. Configure Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or equivalent:

```json
{
  "mcpServers": {
    "w3rt": {
      "command": "node",
      "args": [
        "/home/davirain/clawd/web3AIRuntime/packages/host-mcp/dist/mcp-server.js"
      ],
      "env": {
        "W3RT_DIR": "/home/davirain/.w3rt"
      }
    }
  }
}
```

### 3. Start w3rt daemon (optional, for Meteora monitoring)

```bash
# In another terminal
cd ~/clawd/web3AIRuntime
bun run daemon
```

### 4. Restart Claude Desktop

The w3rt tools should now appear in Claude's tool list!

## Available Tools

### `meteora_top_pools`
Get top Meteora DLMM pools by fee generation.

**Example:**
> "Show me the top 5 Meteora pools for USDC in the last hour"

### `solana_balance`
Check Solana wallet balance.

**Example:**
> "What's my SOL balance?"

### `solana_swap`
Execute a token swap with safety checks.

**Example:**
> "Swap 0.1 SOL to USDC with 0.5% slippage"

### `w3rt_status`
Check w3rt daemon and configuration status.

**Example:**
> "Check w3rt status"

## Architecture

```
Claude Desktop
      ↓
  MCP Protocol (stdio)
      ↓
  w3rt-mcp-server
      ↓
  @w3rt/runtime
      ↓
  Policy Layer → Workflow Engine → Chain Adapters
```

## Development

```bash
# Run in dev mode
bun run dev

# Test the server manually
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | bun run dist/mcp-server.js
```

## Safety Features

- ✅ **Policy Gates** - All transactions require explicit approval
- ✅ **Simulation** - Preview transaction outcome before execution
- ✅ **Trace** - Full audit trail of all operations
- ✅ **Allowlists** - Restrict to approved programs/pools

## Troubleshooting

### "w3rt daemon is not running"
Start the daemon: `cd ~/clawd/web3AIRuntime && bun run daemon`

### "Tool not found in Claude"
1. Check config path: `~/Library/Application Support/Claude/claude_desktop_config.json`
2. Verify node path: `which node`
3. Restart Claude Desktop completely

### "Permission denied"
Make the server executable: `chmod +x packages/host-mcp/dist/mcp-server.js`

## Next Steps

- [ ] Implement wallet integration
- [ ] Add swap execution with approval flow
- [ ] Support more chains (EVM, Sui)
- [ ] Add portfolio tracking
- [ ] Real-time notifications

## License

MIT

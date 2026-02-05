# Quick Setup Guide

## 1. Create w3rt directory

```bash
mkdir -p ~/.w3rt
```

## 2. Configure w3rt

Copy the example config:

```bash
cp packages/host-mcp/config.example.yaml ~/.w3rt/config.yaml
```

Edit `~/.w3rt/config.yaml`:
- Set your RPC endpoint (or use the default)
- Configure wallet keypath (see step 3)

## 3. Setup Solana Wallet

### Option A: Use existing keypair

```bash
# Copy your existing keypair
cp ~/.config/solana/id.json ~/.w3rt/keypair.json
```

### Option B: Create new keypair

```bash
# Generate new keypair
solana-keygen new --outfile ~/.w3rt/keypair.json --no-bip39-passphrase

# Fund it (devnet)
solana airdrop 2 ~/.w3rt/keypair.json --url devnet

# Or (mainnet) - send SOL to the address
solana address -k ~/.w3rt/keypair.json
```

## 4. Test the setup

```bash
cd ~/clawd/web3AIRuntime

# Test MCP server
./test-mcp.sh

# Test balance check
echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"solana_balance","arguments":{}}}' | node packages/host-mcp/dist/mcp-server.js 2>/dev/null | jq
```

## 5. Configure Claude Desktop

### macOS

```bash
# Create config directory
mkdir -p ~/Library/Application\ Support/Claude/

# Edit config
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

### Linux

```bash
# Create config directory
mkdir -p ~/.config/Claude/

# Edit config
nano ~/.config/Claude/claude_desktop_config.json
```

### Config content:

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

**Important:** Update the path to match your actual location!

## 6. (Optional) Start daemon for Meteora monitoring

```bash
cd ~/clawd/web3AIRuntime

# If you have a daemon start script:
bun run daemon

# Or manually note the daemon URL in ~/.w3rt/daemon.url
echo "http://127.0.0.1:38135" > ~/.w3rt/daemon.url
```

## 7. Restart Claude Desktop

Completely quit and restart Claude Desktop.

## 8. Test in Claude

Try these commands:

### Check status
> "Check w3rt status"

Expected output: Shows daemon status, wallet address, config status.

### Check balance
> "What's my Solana balance?"

or

> "Check my Solana balance including tokens"

### Get top Meteora pools
> "Show me the top 5 Meteora pools for USDC in the last hour"

### Get swap quote
> "Get a quote to swap 0.1 SOL to USDC"

## Troubleshooting

### "w3rt daemon is not running"

The daemon is only needed for Meteora pool monitoring. Other features (balance, swap quotes) work without it.

To start the daemon:
```bash
cd ~/clawd/web3AIRuntime
# Check if there's a daemon command
bun run daemon
```

Or manually configure the URL:
```bash
echo "http://127.0.0.1:38135" > ~/.w3rt/daemon.url
```

### "Wallet not configured"

Make sure:
1. `~/.w3rt/keypair.json` exists
2. It's a valid Solana keypair (JSON array of 64 bytes)
3. `config.yaml` has `wallet.keyPath: "keypair.json"`

### "Tools don't appear in Claude"

1. Check Claude logs:
   ```bash
   # macOS
   tail -f ~/Library/Logs/Claude/mcp*.log
   
   # Linux
   tail -f ~/.config/Claude/logs/mcp*.log
   ```

2. Verify config path is correct in `claude_desktop_config.json`

3. Make sure to **completely quit** Claude (not just close window) before restarting

### "Permission denied"

```bash
chmod +x packages/host-mcp/dist/mcp-server.js
```

## Security Notes

⚠️ **Important:**

1. **Never share your keypair file** - it contains your private key
2. **Use a dedicated wallet** for testing - don't use your main wallet
3. **Start with small amounts** - test with devnet or minimal funds
4. **Review all transactions** - the MCP server shows quotes before executing

## Next Steps

- ✅ Configure policy limits in `~/.w3rt/config.yaml`
- ✅ Test with devnet first (`solana.rpc: "https://api.devnet.solana.com"`)
- ✅ Enable Meteora monitoring by starting the daemon
- ✅ Explore other tools (balance, quotes, pool monitoring)

## Need Help?

Check the main README or create an issue on GitHub.

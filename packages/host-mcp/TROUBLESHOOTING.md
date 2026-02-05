# Troubleshooting Guide

## Error: Cannot find module 'mcp-server.js'

### Symptom
```
Error: Cannot find module '/home/davirain/clawd/web3AIRuntime/packages/host-mcp/dist/mcp-server.js'
```

### Cause
This happens when:
1. The project path in Claude Desktop config doesn't match your actual system
2. You're running Claude Desktop on macOS but the config points to a Linux path
3. The dist files aren't built yet

### Solutions

#### Solution 1: Build on the same system as Claude Desktop

If you're using Claude Desktop on **macOS**:

```bash
# On macOS, clone the repo (or sync from Linux)
cd ~/Documents  # or wherever you want
git clone git@github.com:DaviRain-Su/web3AIRuntime.git
cd web3AIRuntime

# Install and build
bun install
bun run build

# Update Claude Desktop config
nano ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Use this config (update the path to match your location):
```json
{
  "mcpServers": {
    "w3rt": {
      "command": "node",
      "args": [
        "/Users/YOUR_USERNAME/Documents/web3AIRuntime/packages/host-mcp/dist/mcp-server.js"
      ],
      "env": {
        "W3RT_DIR": "/Users/YOUR_USERNAME/.w3rt"
      }
    }
  }
}
```

#### Solution 2: Test without Claude Desktop first

On the system where the project is built:

```bash
cd ~/clawd/web3AIRuntime

# Test if the MCP server works
./test-mcp.sh

# Test with direct execution
node packages/host-mcp/dist/mcp-server.js
```

If this works, the build is fine - you just need to fix the path in Claude Desktop config.

#### Solution 3: Use absolute paths and verify

1. Find the actual project location:
   ```bash
   cd ~/clawd/web3AIRuntime
   pwd
   # Output: /home/davirain/clawd/web3AIRuntime
   ```

2. Verify the file exists:
   ```bash
   ls -la packages/host-mcp/dist/mcp-server.js
   ```

3. Update Claude Desktop config with the **exact** path from step 1.

#### Solution 4: Remote access (if project is on Linux, Claude on macOS)

If you want to run the MCP server on Linux and access from macOS Claude Desktop:

**Option A: Use SSH tunnel**
```bash
# On macOS
ssh -L 3000:localhost:3000 user@linux-machine

# Then modify the MCP server to support HTTP instead of stdio
# (This requires code changes)
```

**Option B: Run Claude Desktop on Linux**
Install Claude Desktop on Linux instead of macOS.

## Common Issues

### Issue: "Server transport closed unexpectedly"

**Cause:** The Node.js process exits immediately after starting.

**Solutions:**
1. Check for syntax errors:
   ```bash
   node packages/host-mcp/dist/mcp-server.js
   ```
   
2. Check dependencies are installed:
   ```bash
   cd packages/host-mcp
   npm list
   ```

3. Rebuild:
   ```bash
   bun run build
   ```

### Issue: "MODULE_NOT_FOUND" for dependencies

**Cause:** Missing node_modules or wrong NODE_PATH.

**Solution:**
Add `NODE_PATH` to your Claude Desktop config:
```json
{
  "mcpServers": {
    "w3rt": {
      "command": "node",
      "args": ["path/to/mcp-server.js"],
      "env": {
        "W3RT_DIR": "/path/to/.w3rt",
        "NODE_PATH": "/path/to/web3AIRuntime/node_modules"
      }
    }
  }
}
```

### Issue: Node version mismatch

**Cause:** Different Node versions between build and runtime.

**Solution:**
Use the same Node version:
```bash
# Check Node version used for build
node --version

# Use nvm to match versions
nvm use 24.11.1  # or whatever version you used to build
```

## Platform-Specific Paths

### macOS
- Claude config: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Logs: `~/Library/Logs/Claude/mcp*.log`
- Typical project path: `/Users/username/Documents/web3AIRuntime`

### Linux
- Claude config: `~/.config/Claude/claude_desktop_config.json`
- Logs: `~/.config/Claude/logs/mcp*.log`
- Typical project path: `/home/username/clawd/web3AIRuntime`

## Debugging Steps

1. **Verify file exists:**
   ```bash
   ls -la /path/from/error/message
   ```

2. **Test direct execution:**
   ```bash
   node /path/to/mcp-server.js
   # Should output: "w3rt MCP server running on stdio"
   ```

3. **Check Claude logs:**
   ```bash
   tail -f ~/Library/Logs/Claude/mcp*.log  # macOS
   tail -f ~/.config/Claude/logs/mcp*.log  # Linux
   ```

4. **Verify dependencies:**
   ```bash
   cd packages/host-mcp
   npm list @modelcontextprotocol/sdk
   npm list @w3rt/runtime
   ```

5. **Try simple test:**
   ```bash
   cd ~/clawd/web3AIRuntime
   ./test-mcp.sh
   ```

## Still Having Issues?

1. Check the main README.md for requirements
2. Ensure all dependencies are installed: `bun install`
3. Rebuild everything: `bun run build`
4. Check Claude Desktop logs for detailed error messages
5. Create an issue on GitHub with:
   - Your OS and Node version
   - The exact error message
   - Output of `./test-mcp.sh`

## Quick Fix Checklist

- [ ] Project is cloned/synced to the same machine as Claude Desktop
- [ ] `bun install` has been run
- [ ] `bun run build` has been run successfully
- [ ] Path in `claude_desktop_config.json` matches actual file location
- [ ] `node packages/host-mcp/dist/mcp-server.js` works when run directly
- [ ] Claude Desktop has been **completely** quit and restarted

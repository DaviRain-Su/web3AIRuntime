#!/bin/bash
# Quick test script for w3rt MCP server

echo "Testing w3rt MCP server..."
echo ""

# Test 1: List tools
echo "Test 1: Listing available tools"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | node packages/host-mcp/dist/mcp-server.js 2>/dev/null | jq '.result.tools[].name' 2>/dev/null || echo "Error: Server failed to start"

echo ""
echo "✅ If you see tool names above, the MCP server is working!"
echo ""
echo "Next steps:"
echo "1. Configure Claude Desktop (see packages/host-mcp/README.md)"
echo "2. Restart Claude Desktop"
echo "3. Try: 'Check w3rt status' or 'Show me top Meteora pools'"

#!/bin/bash
# Advanced test script for w3rt MCP server

set -e

echo "🧪 Testing w3rt MCP server..."
echo ""

MCP_BIN="node packages/host-mcp/dist/mcp-server.js"

# Helper function to call MCP tool
call_tool() {
  local tool=$1
  local args=$2
  echo "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$tool\",\"arguments\":$args}}" | $MCP_BIN 2>/dev/null
}

# Test 1: List tools
echo "📋 Test 1: Listing available tools"
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | $MCP_BIN 2>/dev/null | jq -r '.result.tools[].name' | while read tool; do
  echo "  ✓ $tool"
done

echo ""

# Test 2: Check status
echo "🔍 Test 2: Checking w3rt status"
call_tool "w3rt_status" "{}" | jq '.result.content[0].text' | jq -r '.' | head -15
echo ""

# Test 3: Check balance (if wallet configured)
echo "💰 Test 3: Checking Solana balance"
result=$(call_tool "solana_balance" "{\"includeTokens\":false}" 2>&1)
if echo "$result" | jq -e '.result' >/dev/null 2>&1; then
  echo "$result" | jq -r '.result.content[0].text' | head -10
else
  echo "  ⚠️  Wallet not configured or balance check failed"
  echo "     Run: cp ~/.config/solana/id.json ~/.w3rt/keypair.json"
fi

echo ""

# Test 4: Get swap quote (simulation)
echo "💱 Test 4: Getting swap quote (simulation)"
call_tool "solana_swap" '{"fromToken":"SOL","toToken":"USDC","amount":"0.1","simulate":true}' | jq -r '.result.content[0].text' | head -15

echo ""
echo "✅ MCP server tests complete!"
echo ""
echo "📝 Next steps:"
echo "1. Configure wallet: cp ~/.config/solana/id.json ~/.w3rt/keypair.json"
echo "2. Create config: cp packages/host-mcp/config.example.yaml ~/.w3rt/config.yaml"
echo "3. Configure Claude Desktop (see packages/host-mcp/SETUP.md)"
echo "4. Restart Claude and try: 'Check w3rt status'"

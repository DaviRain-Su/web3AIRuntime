# Web3 AI Runtime

## 基于 Pi SDK 的产品设计规划 v2.0

---

## 核心定位

> **Web3 AI Runtime = Pi SDK + DeFi Safety Layer + Web3 Tools**

我们不重新发明轮子，而是站在 Pi 的肩膀上，专注于 Web3 特有的价值：

| 复用 Pi 的 | 我们专注开发的 |
|-----------|---------------|
| Agent Runtime | **Policy Runtime** (安全闸) |
| Extension 系统 | **Web3 Extensions** (wallet/swap/stake) |
| Session 管理 | **Trace Runtime** (链上审计) |
| TUI 框架 | **DeFi Skills** (协议操作指南) |
| 4 种运行模式 | **Workflow Engine** (多步交易编排) |
| 多 LLM 支持 | 配置即可 |

---

## 1. 架构设计

### 1.1 整体架构

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Web3 AI Runtime (w3rt)                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                    我们开发的 Web3 Layer                         │    │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐   │    │
│  │  │  Policy    │ │  Wallet    │ │  DeFi      │ │  Trace     │   │    │
│  │  │  Runtime   │ │  Manager   │ │  Skills    │ │  Runtime   │   │    │
│  │  │  (安全闸)   │ │  (钱包)    │ │  (协议)    │ │  (审计)    │   │    │
│  │  └────────────┘ └────────────┘ └────────────┘ └────────────┘   │    │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                  │    │
│  │  │  Workflow  │ │  Chain     │ │  Web3      │                  │    │
│  │  │  Engine    │ │  Adapters  │ │  Extensions│                  │    │
│  │  │  (编排)    │ │  (多链)    │ │  (Pi扩展)  │                  │    │
│  │  └────────────┘ └────────────┘ └────────────┘                  │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                    │                                     │
│                                    ▼                                     │
│  ┌─────────────────────────────────────────────────────────────────┐    │
│  │                      Pi SDK (复用)                               │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐           │    │
│  │  │ pi-agent │ │  pi-tui  │ │  pi-ai   │ │ Session  │           │    │
│  │  │  (core)  │ │  (终端)  │ │  (LLM)   │ │ Manager  │           │    │
│  │  └──────────┘ └──────────┘ └──────────┘ └──────────┘           │    │
│  │  ┌──────────┐ ┌──────────┐ ┌──────────┐                        │    │
│  │  │Extension │ │  Tools   │ │   RPC    │                        │    │
│  │  │  Runner  │ │  System  │ │   Mode   │                        │    │
│  │  └──────────┘ └──────────┘ └──────────┘                        │    │
│  └─────────────────────────────────────────────────────────────────┘    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 与 Pi 的关系

```
pi-mono (上游)
├── @mariozechner/pi-ai          → 直接使用
├── @mariozechner/pi-agent       → 直接使用
├── @mariozechner/pi-tui         → 直接使用
├── @mariozechner/pi-coding-agent → Fork 或作为依赖扩展
└── ...

web3-ai-runtime (我们的项目)
├── @w3rt/core                   → 基于 pi-coding-agent 扩展
├── @w3rt/policy                 → 安全策略引擎 (新开发)
├── @w3rt/wallet                 → 钱包管理 (新开发)
├── @w3rt/chains                 → 多链适配器 (新开发)
├── @w3rt/defi-skills            → DeFi 操作 Skills (新开发)
├── @w3rt/trace                  → 审计追踪 (新开发)
└── @w3rt/workflow               → 多步编排 (新开发)
```

---

## 2. 命名体系

| 层级 | 名称 | 说明 |
|------|------|------|
| **产品名** | Web3 AI Runtime | 对外品牌 |
| **CLI 命令** | `w3rt` | 类似 `pi`，简短好记 |
| **npm scope** | `@w3rt/*` | 包命名空间 |
| **配置文件** | `W3RT.md` / `.w3rt/` | 类似 Pi 的 `.pi/` |

---

## 3. 模块详细设计

### 3.1 Policy Runtime (安全闸) - 核心差异化

这是 Web3 AI Runtime 相比通用 coding agent 的**核心差异**。

```typescript
// @w3rt/policy/src/types.ts

interface PolicyConfig {
  // 网络策略
  networks: {
    mainnet: {
      enabled: boolean;
      requireApproval: boolean;      // 主网强制审批
      requireSimulation: boolean;    // 强制先模拟
      maxDailyVolume: number;        // 每日限额 (USD)
    };
    testnet: {
      enabled: boolean;
      requireApproval: boolean;
    };
  };
  
  // 交易策略
  transactions: {
    maxSingleAmount: number;         // 单笔限额 (USD)
    maxSlippage: number;             // 最大滑点 %
    maxGasPrice: number;             // Gas 上限
    requireConfirmation: 'never' | 'large' | 'always';
  };
  
  // 白名单
  whitelist: {
    protocols: string[];             // 允许的协议
    tokens: string[];                // 允许的代币
    addresses: string[];             // 允许的合约地址
  };
  
  // 风险规则
  rules: PolicyRule[];
}

interface PolicyRule {
  name: string;
  condition: string;                 // 表达式，如 "amount > 5000"
  action: 'allow' | 'warn' | 'confirm' | 'block';
  message?: string;
}
```

**Policy 检查流程 (作为 Pi Extension 实现):**

```typescript
// @w3rt/policy/src/extension.ts

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { PolicyEngine } from "./engine";

export default function (pi: ExtensionAPI) {
  const policy = new PolicyEngine();
  
  // 拦截所有 Web3 工具调用
  pi.on("tool_call", async (event, ctx) => {
    if (!isWeb3Tool(event.tool)) return;
    
    // 1. 检查白名单
    const whitelistCheck = policy.checkWhitelist(event.params);
    if (!whitelistCheck.allowed) {
      ctx.ui.notify(`🚫 Blocked: ${whitelistCheck.reason}`, "error");
      return { abort: true, reason: whitelistCheck.reason };
    }
    
    // 2. 检查限额
    const limitCheck = policy.checkLimits(event.params);
    if (!limitCheck.allowed) {
      ctx.ui.notify(`🚫 Limit exceeded: ${limitCheck.reason}`, "error");
      return { abort: true, reason: limitCheck.reason };
    }
    
    // 3. 检查风险规则
    const riskCheck = policy.checkRules(event.params);
    
    switch (riskCheck.action) {
      case 'block':
        ctx.ui.notify(`🚫 ${riskCheck.message}`, "error");
        return { abort: true };
        
      case 'confirm':
        const ok = await ctx.ui.confirm(
          "⚠️ Requires Approval",
          riskCheck.message
        );
        if (!ok) return { abort: true };
        break;
        
      case 'warn':
        ctx.ui.notify(`⚠️ ${riskCheck.message}`, "warning");
        break;
    }
    
    // 4. 主网强制模拟
    if (policy.config.networks.mainnet.requireSimulation) {
      ctx.ui.setStatus("w3rt", "🔄 Simulating...");
      // 模拟逻辑在 tool 内部处理
    }
  });
  
  // 注册 policy 管理命令
  pi.registerCommand("policy", {
    description: "View or edit policy configuration",
    execute: async (args, ctx) => {
      if (args[0] === "show") {
        ctx.ui.print(formatPolicy(policy.config));
      } else if (args[0] === "edit") {
        // 打开编辑器
      }
    }
  });
}
```

### 3.2 Wallet Manager (钱包管理)

```typescript
// @w3rt/wallet/src/extension.ts

export default function (pi: ExtensionAPI) {
  const walletManager = new WalletManager();
  
  // 注册钱包工具
  pi.registerTool({
    name: "wallet_balance",
    description: "Get wallet balance for a token",
    parameters: {
      wallet: { type: "string", optional: true },
      token: { type: "string", optional: true },
      chain: { type: "string", optional: true }
    },
    execute: async (params, ctx) => {
      const wallet = params.wallet || walletManager.getDefault();
      const balances = await walletManager.getBalances(wallet, params.chain);
      return formatBalances(balances);
    }
  });
  
  pi.registerTool({
    name: "wallet_transfer",
    description: "Transfer tokens to an address",
    parameters: {
      to: { type: "string" },
      amount: { type: "number" },
      token: { type: "string" },
      chain: { type: "string", optional: true }
    },
    execute: async (params, ctx) => {
      // Policy 检查会在 tool_call 事件中自动触发
      const tx = await walletManager.transfer(params);
      return { txHash: tx.hash, status: "pending" };
    }
  });
  
  // 钱包管理命令
  pi.registerCommand("wallet", {
    description: "Manage wallets",
    execute: async (args, ctx) => {
      const [subCmd, ...rest] = args;
      switch (subCmd) {
        case "list":
          const wallets = walletManager.list();
          ctx.ui.print(formatWallets(wallets));
          break;
        case "add":
          // 交互式添加钱包
          break;
        case "switch":
          walletManager.setDefault(rest[0]);
          ctx.ui.notify(`Switched to ${rest[0]}`, "success");
          break;
      }
    }
  });
  
  // 在 TUI 状态栏显示当前钱包
  pi.on("agent_start", async (event, ctx) => {
    const wallet = walletManager.getDefault();
    const balance = await walletManager.getMainBalance(wallet);
    ctx.ui.setWidget("wallet", [
      `💰 ${wallet.name}`,
      `   ${balance.formatted}`
    ]);
  });
}
```

### 3.3 DeFi Skills (协议操作指南)

Pi 的 Skills 是 CLI 工具 + README 的形式，我们为 DeFi 协议创建专门的 Skills：

```
~/.w3rt/skills/
├── cetus/
│   ├── SKILL.md           # 协议说明 + 操作指南
│   └── cli.ts             # 可选的 CLI 工具
├── pancakeswap/
│   ├── SKILL.md
│   └── cli.ts
├── aave/
│   └── SKILL.md
└── ...
```

**示例 Skill (Cetus on Sui):**

```markdown
<!-- ~/.w3rt/skills/cetus/SKILL.md -->
---
name: cetus
description: Cetus DEX on Sui - AMM and Concentrated Liquidity
chains: [sui]
version: "1.0"
---

# Cetus DEX

Cetus is the leading DEX on Sui with concentrated liquidity (CLMM).

## Available Operations

### Swap Tokens
```bash
w3rt-cetus swap --from SUI --to USDC --amount 100
```

Parameters:
- `--from`: Source token symbol
- `--to`: Target token symbol  
- `--amount`: Amount to swap
- `--slippage`: Max slippage (default: 0.5%)

### Add Liquidity
```bash
w3rt-cetus add-liquidity --pool SUI-USDC --amount-a 100 --amount-b 125
```

### Check Pool Info
```bash
w3rt-cetus pool-info --pool SUI-USDC
```

## Contract Addresses (Mainnet)

- CLMM Package: `0x1eabed...`
- Router: `0x2eeabe...`

## Safety Notes

- Always simulate before mainnet execution
- Check pool TVL before large trades
- Verify token addresses match expected
```

### 3.4 Trace Runtime (审计追踪)

```typescript
// @w3rt/trace/src/extension.ts

export default function (pi: ExtensionAPI) {
  const trace = new TraceManager();
  
  // 记录所有 Web3 操作
  pi.on("tool_result", async (event, ctx) => {
    if (!isWeb3Tool(event.tool)) return;
    
    await trace.log({
      timestamp: Date.now(),
      tool: event.tool,
      params: event.params,
      result: event.result,
      sessionId: ctx.session.id,
      // 链上信息
      txHash: event.result?.txHash,
      chain: event.params?.chain,
      gasUsed: event.result?.gasUsed
    });
  });
  
  // 回放命令
  pi.registerCommand("replay", {
    description: "Replay a historical run",
    execute: async (args, ctx) => {
      const runId = args[0];
      const run = await trace.getRun(runId);
      ctx.ui.print(formatRunTrace(run));
    }
  });
  
  // 导出审计报告
  pi.registerCommand("audit", {
    description: "Export audit report",
    execute: async (args, ctx) => {
      const [startDate, endDate] = args;
      const report = await trace.generateReport(startDate, endDate);
      await fs.writeFile("audit-report.json", JSON.stringify(report, null, 2));
      ctx.ui.notify("Audit report exported", "success");
    }
  });
}
```

### 3.5 Chain Adapters (多链适配)

```typescript
// @w3rt/chains/src/types.ts

interface ChainAdapter {
  name: string;
  chainId: string;
  
  // 基础操作
  getBalance(address: string, token?: string): Promise<Balance>;
  transfer(params: TransferParams): Promise<TxResult>;
  
  // 交易
  simulateTx(tx: Transaction): Promise<SimulationResult>;
  signTx(tx: Transaction, wallet: Wallet): Promise<SignedTx>;
  sendTx(signedTx: SignedTx): Promise<TxHash>;
  waitForTx(txHash: TxHash): Promise<TxReceipt>;
  
  // 查询
  getGasPrice(): Promise<GasPrice>;
  getTokenPrice(token: string): Promise<number>;
}

// @w3rt/chains/src/sui.ts
export class SuiAdapter implements ChainAdapter {
  private client: SuiClient;
  
  async transfer(params: TransferParams): Promise<TxResult> {
    // Sui 特定实现
  }
}

// @w3rt/chains/src/bnb.ts
export class BnbAdapter implements ChainAdapter {
  private provider: ethers.Provider;
  
  async transfer(params: TransferParams): Promise<TxResult> {
    // EVM 实现
  }
}
```

### 3.6 Workflow Engine (多步编排)

```typescript
// @w3rt/workflow/src/types.ts

interface Workflow {
  name: string;
  version: string;
  description?: string;
  
  // 触发方式
  trigger: 'manual' | 'cron' | 'price_alert' | 'event';
  triggerConfig?: {
    cron?: string;           // "0 9 * * *"
    priceAlert?: {
      token: string;
      condition: 'above' | 'below';
      price: number;
    };
  };
  
  // 执行阶段
  stages: WorkflowStage[];
  
  // 全局配置
  config?: {
    maxRetries?: number;
    timeout?: string;        // "5m"
    rollbackOnFailure?: boolean;
  };
}

interface WorkflowStage {
  name: string;
  type: 'analysis' | 'simulation' | 'approval' | 'execution' | 'monitor';
  
  // 操作列表
  actions: WorkflowAction[];
  
  // 条件
  when?: string;             // 表达式
  
  // 审批配置
  approval?: {
    required: boolean;
    timeout?: string;
    conditions?: string[];   // 自动审批条件
  };
}
```

**示例 Workflow (跨链套利):**

```yaml
# ~/.w3rt/workflows/cross-chain-arb.yaml

name: cross_chain_arbitrage
version: "1.0"
description: Monitor and execute cross-chain arbitrage opportunities

trigger: cron
triggerConfig:
  cron: "*/5 * * * *"  # 每 5 分钟

stages:
  - name: analyze
    type: analysis
    actions:
      - tool: price_check
        params:
          tokens: [SUI, USDC]
          chains: [sui, bnb]
      - tool: calculate_opportunity
        params:
          minProfit: 10  # USD
          
  - name: simulate
    type: simulation
    when: "opportunity.profit > 10"
    actions:
      - tool: simulate_swap
        params:
          chain: "{{ opportunity.sourceChain }}"
          from: "{{ opportunity.sourceToken }}"
          to: "{{ opportunity.targetToken }}"
          amount: "{{ opportunity.amount }}"
          
  - name: approve
    type: approval
    approval:
      required: true
      timeout: "2m"
      conditions:
        - "simulation.success == true"
        - "simulation.profit > 50"  # 大于 $50 自动批准
        
  - name: execute
    type: execution
    actions:
      - tool: swap
        params:
          chain: "{{ opportunity.sourceChain }}"
          from: "{{ opportunity.sourceToken }}"
          to: "{{ opportunity.targetToken }}"
          amount: "{{ opportunity.amount }}"
          
  - name: verify
    type: monitor
    actions:
      - tool: verify_balance
      - tool: notify
        params:
          message: "Arbitrage complete: +{{ result.profit }} USDC"

config:
  maxRetries: 2
  timeout: "10m"
  rollbackOnFailure: false
```

---

## 4. CLI 设计

### 4.1 命令结构

```bash
# 基于 Pi 的命令，加上 Web3 特有功能

# 启动
w3rt                              # 交互式 TUI (继承 pi)
w3rt "swap 100 SUI to USDC"      # 单次执行 (继承 pi --print)
w3rt --json "..."                # JSON 输出 (继承 pi)
w3rt --mode rpc                  # RPC 模式 (继承 pi)

# Web3 特有命令
w3rt wallet list                 # 钱包列表
w3rt wallet add                  # 添加钱包
w3rt wallet balance              # 查看余额

w3rt policy show                 # 查看策略
w3rt policy edit                 # 编辑策略

w3rt run <workflow>              # 执行 workflow
w3rt sim <workflow>              # 模拟 workflow
w3rt approve <run-id>            # 审批

w3rt trace <run-id>              # 查看执行追踪
w3rt audit --from 2026-01-01     # 导出审计报告

# 继承 Pi 的命令
w3rt /resume                     # 恢复会话
w3rt /model                      # 切换模型
w3rt /reload                     # 重载 extensions
```

### 4.2 TUI 界面

```
┌─ Web3 AI Runtime v0.1.0 ────────────────────────────────────────────────┐
│ Model: claude-3-opus │ Network: sui-mainnet │ Policy: default           │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  > swap 500 SUI to USDC on Cetus with max 0.5% slippage                 │
│                                                                          │
│  ┌─ Simulation Result ───────────────────────────────────────────────┐  │
│  │ Input:  500 SUI ($612.50)                                         │  │
│  │ Output: 608.75 USDC (expected)                                    │  │
│  │ Slippage: 0.3%                                                    │  │
│  │ Gas: 0.001 SUI (~$0.001)                                          │  │
│  │ Route: SUI → USDC (Cetus CLMM Pool)                               │  │
│  └───────────────────────────────────────────────────────────────────┘  │
│                                                                          │
│  ⚠️  Mainnet transaction - requires approval                            │
│                                                                          │
│  [Enter] Approve  [Esc] Cancel  [s] Edit slippage  [r] Refresh quote    │
│                                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ 💰 davirain.sui                          │ 🔗 sui-mainnet              │
│    1,234.56 SUI ($1,512.34)              │    Block: 12,345,678         │
│    5,678.90 USDC                         │    Gas: 0.001 SUI            │
└─────────────────────────────────────────────────────────────────────────┘
```

### 4.3 配置文件

**W3RT.md (项目级配置，类似 Pi 的 .pi/SYSTEM.md):**

```markdown
<!-- .w3rt/W3RT.md -->

# Project: DeFi Trading Bot

## Wallet
- Default: davirain.sui
- Networks: sui-mainnet, bnb-mainnet

## Trading Rules
- Max single trade: $500
- Preferred DEX: Cetus (Sui), PancakeSwap (BNB)
- Default slippage: 0.5%

## Safety
- Always simulate before mainnet
- Require confirmation for trades > $100
- Never interact with unverified contracts

## Custom Commands
- `/arb` - Run cross-chain arbitrage check
- `/rebalance` - Rebalance to 50/50 stables
- `/dca` - Execute DCA buy

## Active Skills
- cetus
- pancakeswap
- aave
```

---

## 5. 项目结构

```
web3-ai-runtime/
├── packages/
│   ├── core/                    # 主入口，整合所有模块
│   │   ├── src/
│   │   │   ├── cli.ts          # CLI 入口
│   │   │   ├── index.ts        # SDK 入口
│   │   │   └── extensions/     # 内置 extensions 注册
│   │   └── package.json
│   │
│   ├── policy/                  # Policy Runtime
│   │   ├── src/
│   │   │   ├── engine.ts       # 策略引擎
│   │   │   ├── rules.ts        # 规则解析
│   │   │   └── extension.ts    # Pi Extension
│   │   └── package.json
│   │
│   ├── wallet/                  # 钱包管理
│   │   ├── src/
│   │   │   ├── manager.ts
│   │   │   ├── encryption.ts   # 密钥加密
│   │   │   └── extension.ts
│   │   └── package.json
│   │
│   ├── chains/                  # 多链适配
│   │   ├── src/
│   │   │   ├── types.ts
│   │   │   ├── sui.ts
│   │   │   ├── bnb.ts
│   │   │   └── avalanche.ts
│   │   └── package.json
│   │
│   ├── trace/                   # 审计追踪
│   │   ├── src/
│   │   │   ├── manager.ts
│   │   │   ├── storage.ts
│   │   │   └── extension.ts
│   │   └── package.json
│   │
│   ├── workflow/                # Workflow 引擎
│   │   ├── src/
│   │   │   ├── engine.ts
│   │   │   ├── parser.ts       # YAML 解析
│   │   │   └── scheduler.ts    # 定时触发
│   │   └── package.json
│   │
│   └── skills/                  # 内置 DeFi Skills
│       ├── cetus/
│       ├── pancakeswap/
│       └── aave/
│
├── .w3rt/                       # 默认配置
│   ├── policy.yaml             # 默认策略
│   └── W3RT.md                 # 默认系统提示
│
├── examples/
│   ├── extensions/             # 示例 extensions
│   └── workflows/              # 示例 workflows
│
├── package.json                # 工作区配置
├── tsconfig.json
└── README.md
```

---

## 6. 依赖关系

```json
// packages/core/package.json
{
  "name": "@w3rt/core",
  "dependencies": {
    // Pi SDK (核心依赖)
    "@mariozechner/pi-coding-agent": "^0.12.0",
    "@mariozechner/pi-ai": "^0.12.0",
    "@mariozechner/pi-tui": "^0.12.0",
    
    // 我们的模块
    "@w3rt/policy": "workspace:*",
    "@w3rt/wallet": "workspace:*",
    "@w3rt/chains": "workspace:*",
    "@w3rt/trace": "workspace:*",
    "@w3rt/workflow": "workspace:*"
  }
}

// packages/chains/package.json
{
  "name": "@w3rt/chains",
  "dependencies": {
    "@mysten/sui": "^1.0.0",      // Sui SDK
    "ethers": "^6.0.0",           // EVM chains
    "viem": "^2.0.0"              // 备选 EVM
  }
}
```

---

## 7. 开发路线图

### Phase 1: 基础框架 (2 周)

**目标**: 跑通基于 Pi 的最小可用版本

```
Week 1:
├── [ ] 项目初始化，配置 monorepo
├── [ ] 集成 pi-coding-agent 作为依赖
├── [ ] 创建 @w3rt/core，实现 CLI 入口
├── [ ] 实现基础 Policy Extension (白名单、限额)
└── [ ] 测试 Pi 的 Extension 系统

Week 2:
├── [ ] 实现 @w3rt/wallet (Sui 钱包)
├── [ ] 实现 @w3rt/chains/sui (Sui 适配器)
├── [ ] 创建第一个 Tool: wallet_balance
├── [ ] 创建第一个 Skill: cetus (基础 swap)
└── [ ] 端到端测试: 查余额 + testnet swap
```

**交付物**:
- `w3rt` CLI 可运行
- 可以连接 Sui 钱包查余额
- 可以在 testnet 执行简单 swap

### Phase 2: 安全层 + DeFi Tools (3 周)

**目标**: 完善 Policy Runtime，添加更多 DeFi 操作

```
Week 3:
├── [ ] 完善 Policy Runtime (风险规则引擎)
├── [ ] 实现交易模拟 (simulate before execute)
├── [ ] 实现审批流程 (TUI 确认)
└── [ ] 添加 mainnet 支持 (带安全检查)

Week 4:
├── [ ] 实现 @w3rt/trace (操作追踪)
├── [ ] 添加更多 DeFi Tools: add_liquidity, stake
├── [ ] 完善 Cetus Skill
└── [ ] 创建 PancakeSwap Skill (BNB Chain)

Week 5:
├── [ ] 实现 @w3rt/chains/bnb (EVM 适配)
├── [ ] 跨链余额聚合显示
├── [ ] TUI Widget: 实时余额、Gas 价格
└── [ ] 文档完善
```

**交付物**:
- Policy Runtime 完整实现
- 支持 Sui + BNB Chain
- 可执行 swap/liquidity/stake
- 完整的操作追踪

### Phase 3: Workflow + 高级功能 (3 周)

**目标**: 实现多步编排，准备开源

```
Week 6:
├── [ ] 实现 @w3rt/workflow (YAML 解析 + 执行)
├── [ ] 支持 manual trigger
├── [ ] 实现 stage: simulation → approval → execution
└── [ ] 创建示例 workflow

Week 7:
├── [ ] 支持 cron trigger (定时执行)
├── [ ] 支持 price_alert trigger
├── [ ] 实现 workflow 暂停/恢复
└── [ ] 审计报告导出

Week 8:
├── [ ] RPC 模式测试 (为外部集成准备)
├── [ ] 创建 example extensions
├── [ ] 完善 README 和文档
├── [ ] 开源发布准备
└── [ ] 发布 v0.1.0
```

**交付物**:
- Workflow Engine 完整实现
- 定时/价格触发
- 开源仓库 + 文档
- npm 发布

---

## 8. 与 OpenClaw 的关系

OpenClaw 基于 Pi SDK 构建了通用个人助手，我们可以：

1. **学习其集成方式**: 看 OpenClaw 如何使用 Pi 的 RPC 模式
2. **潜在整合**: 未来可以作为 OpenClaw 的 Web3 Skill 提供
3. **差异化**: 我们专注 DeFi 安全层，OpenClaw 专注通用任务

```
OpenClaw 的架构:
├── Gateway (消息路由)
├── Pi SDK (Agent Runtime)  ← 我们共用这层
├── Skills (通用技能)
└── Multi-channel (WhatsApp/Telegram)

Web3 AI Runtime 的架构:
├── CLI / RPC (入口)
├── Pi SDK (Agent Runtime)  ← 共用
├── Policy Runtime (安全层) ← 我们的核心
├── DeFi Skills (专业技能) ← 我们的核心
└── Trace Runtime (审计)   ← 我们的核心
```

---

## 9. 风险与应对

| 风险 | 应对策略 |
|------|---------|
| Pi API 变更 | 锁定版本，关注 pi-mono releases |
| 钱包安全 | 本地加密存储，支持硬件钱包 |
| 链 RPC 不稳定 | 多节点 fallback |
| Gas 估算不准 | 预留 buffer，模拟优先 |
| 用户误操作 | Policy 默认严格，需显式放宽 |

---

## 10. 成功指标

### 技术指标

| 指标 | 目标 |
|------|------|
| 启动时间 | < 2 秒 |
| Swap 延迟 (含模拟) | < 5 秒 |
| Policy 检查延迟 | < 100ms |
| 模拟准确率 | > 99% |

### 产品指标 (3 个月)

| 指标 | 目标 |
|------|------|
| 支持链数 | 3 (Sui, BNB, Avalanche) |
| DeFi Skills | 5+ |
| GitHub Stars | 500+ |
| npm 下载 | 1000+/月 |

---

## 11. 立即行动

### 本周 (Week 1)

1. [ ] Fork 或克隆 pi-mono，熟悉代码结构
2. [ ] 创建 web3-ai-runtime 仓库
3. [ ] 配置 monorepo (npm workspaces)
4. [ ] 实现最简 @w3rt/core，验证 Pi 集成
5. [ ] 写第一个 Extension: 显示 "Hello Web3"

### 需要确认

1. **仓库策略**: Fork pi-mono 还是独立仓库 + 依赖？
   - 推荐：独立仓库 + 依赖（更灵活）
   
2. **首发链**: Sui 优先还是 EVM 优先？
   - 推荐：Sui（你已有 web3mcp 经验）
   
3. **开源策略**: 一开始就开源还是 MVP 后？
   - 推荐：一开始就开源（吸引贡献者）

---

*文档版本: v2.0*  
*创建日期: 2026-02-02*  
*技术路线: 基于 Pi SDK*

export type NetworkName = "mainnet" | "testnet";

export type PolicyAction = "allow" | "warn" | "confirm" | "block";

export interface PolicyConfig {
  networks: {
    mainnet: {
      enabled: boolean;
      requireApproval: boolean;
      requireSimulation: boolean;
      maxDailyVolumeUsd: number;
    };
    testnet: {
      enabled: boolean;
      requireApproval: boolean;
    };
  };
  transactions: {
    maxSingleAmountUsd: number;
    maxSlippageBps: number;
    requireConfirmation: "never" | "large" | "always";

    // Conservative runtime limits (applied to broadcast actions)
    cooldownSeconds?: number; // minimum time between broadcasts
    maxTxPerMinute?: number; // rolling window limit

    // Solana-specific absolute size limits (deterministic, no price feed)
    maxSingleSol?: number;

    // If enabled, require a simulation-derived slippage estimate for mainnet swap broadcasts.
    requireSimulatedSlippageOnMainnet?: boolean;
  };
  allowlist: {
    solanaPrograms?: string[];
    suiPackages?: string[];
    evmContracts?: string[];
    tokenMints?: string[];
    actions?: string[];
  };
  rules: PolicyRule[];
}

export interface PolicyRule {
  name: string;
  // MVP: keep as string, but must be sandboxed (TODO). Prefer JSON DSL later.
  condition: string;
  action: PolicyAction;
  message?: string;
}

export type PolicyDecision =
  | { decision: "allow"; reasons?: string[] }
  | { decision: "warn"; code: string; message: string; reasons?: string[] }
  | { decision: "confirm"; code: string; message: string; confirmationKey: string; reasons?: string[] }
  | { decision: "block"; code: string; message: string; reasons?: string[] };

export interface PolicyContext {
  chain: string;
  network: NetworkName;
  action: string;
  sideEffect?: "none" | "broadcast";

  // Optional runtime-provided metrics snapshot (arbitrary structured data).
  // This enables custom rules like: metrics.meteora_sol_usdc.liquidity_usd < 500000
  metrics?: Record<string, any>;

  // Simulation gate: whether we have a successful simulation artifact for the tx.
  simulationOk?: boolean;

  amountUsd?: number;
  slippageBps?: number; // requested slippage

  // If we can derive from simulation + quote, the implied slippage vs quote.
  simulatedSlippageBps?: number;

  programIds?: string[];
  programIdsKnown?: boolean;
  tokenMints?: string[];

  // Rate limiting context (computed by runtime)
  secondsSinceLastBroadcast?: number;
  broadcastsLastMinute?: number;

  // Deterministic size context for Solana
  amountSol?: number;
  amountLamports?: number;
}

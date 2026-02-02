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
  | { decision: "warn"; code: string; message: string }
  | { decision: "confirm"; code: string; message: string; confirmationKey: string }
  | { decision: "block"; code: string; message: string };

export interface PolicyContext {
  chain: string;
  network: NetworkName;
  action: string;
  sideEffect?: "none" | "broadcast";

  // Simulation gate: whether we have a successful simulation artifact for the tx.
  simulationOk?: boolean;

  amountUsd?: number;
  slippageBps?: number;
  programIds?: string[];
  tokenMints?: string[];
}

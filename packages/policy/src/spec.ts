import type { PolicyConfig } from "./types.js";

export type PolicySpecVersion = 1;

/**
 * PolicySpec is the stable, machine-readable policy DSL we can generate from natural language.
 * It is intentionally conservative and easy to validate/audit.
 */
export interface PolicySpecV1 {
  policySpecVersion: 1;

  networks: PolicyConfig["networks"];
  transactions: PolicyConfig["transactions"];
  allowlist: PolicyConfig["allowlist"];

  /**
   * Reserved for future structured rules (no code strings).
   * For now we keep it empty and rely on the existing engine gates.
   */
  rules?: Array<Record<string, unknown>>;
}

export type PolicySpec = PolicySpecV1;

export function policyConfigFromSpec(spec: PolicySpec): PolicyConfig {
  if (spec.policySpecVersion !== 1) {
    throw new Error(`Unsupported policySpecVersion: ${(spec as any)?.policySpecVersion}`);
  }
  return {
    networks: spec.networks,
    transactions: spec.transactions,
    allowlist: spec.allowlist,
    // keep legacy string-rule DSL empty for now
    rules: [],
  };
}

export function defaultPolicySpec(): PolicySpecV1 {
  return {
    policySpecVersion: 1,
    networks: {
      mainnet: { enabled: true, requireApproval: true, requireSimulation: true, maxDailyVolumeUsd: 500 },
      testnet: { enabled: true, requireApproval: false },
    },
    transactions: {
      maxSingleAmountUsd: 100,
      maxSlippageBps: 100,
      requireConfirmation: "large",
    },
    allowlist: {
      actions: ["swap", "transfer", "balance", "quote", "simulate", "confirm"],
    },
    rules: [],
  };
}

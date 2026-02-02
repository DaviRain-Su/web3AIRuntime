import { describe, expect, test } from "bun:test";
import { PolicyEngine } from "../src/engine";
import type { PolicyConfig } from "../src/types";

const baseConfig: PolicyConfig = {
  networks: {
    mainnet: {
      enabled: true,
      requireApproval: true,
      requireSimulation: true,
      maxDailyVolumeUsd: 500,
    },
    testnet: {
      enabled: true,
      requireApproval: false,
    },
  },
  transactions: {
    maxSingleAmountUsd: 500,
    maxSlippageBps: 50,
    requireConfirmation: "large",
  },
  allowlist: {
    actions: ["swap"],
    solanaPrograms: ["11111111111111111111111111111111"],
  },
  rules: [],
};

describe("PolicyEngine", () => {
  test("blocks mainnet broadcast when simulation required but missing", () => {
    const e = new PolicyEngine(baseConfig);
    const d = e.decide({
      chain: "solana",
      network: "mainnet",
      action: "swap",
      sideEffect: "broadcast",
      simulationOk: false,
      programIdsKnown: true,
      programIds: ["11111111111111111111111111111111"],
    });
    expect(d.decision).toBe("block");
    // @ts-expect-error narrowing
    expect(d.code).toBe("SIMULATION_REQUIRED");
  });

  test("fail-closed when allowlist enabled but programIds unknown", () => {
    const e = new PolicyEngine(baseConfig);
    const d = e.decide({
      chain: "solana",
      network: "mainnet",
      action: "swap",
      sideEffect: "broadcast",
      simulationOk: true,
      programIdsKnown: false,
    });
    expect(d.decision).toBe("block");
    // @ts-expect-error narrowing
    expect(d.code).toBe("PROGRAMS_UNKNOWN");
  });

  test("blocks when program not in allowlist", () => {
    const e = new PolicyEngine(baseConfig);
    const d = e.decide({
      chain: "solana",
      network: "mainnet",
      action: "swap",
      sideEffect: "broadcast",
      simulationOk: true,
      programIdsKnown: true,
      programIds: ["BadProgram111111111111111111111111111111111"],
    });
    expect(d.decision).toBe("block");
    // @ts-expect-error narrowing
    expect(d.code).toBe("PROGRAM_NOT_ALLOWED");
  });
});

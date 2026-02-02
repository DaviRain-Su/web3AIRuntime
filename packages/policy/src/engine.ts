import type { PolicyConfig, PolicyContext, PolicyDecision } from "./types.js";

export class PolicyEngine {
  constructor(public readonly config: PolicyConfig) {}

  decide(ctx: PolicyContext): PolicyDecision {
    // 1) network gates
    if (ctx.network === "mainnet") {
      if (!this.config.networks.mainnet.enabled) {
        return { decision: "block", code: "MAINNET_DISABLED", message: "Mainnet disabled" };
      }
    }

    // 2) mainnet simulation hard gate (for side-effect actions)
    if (
      ctx.network === "mainnet" &&
      this.config.networks.mainnet.requireSimulation &&
      ctx.sideEffect === "broadcast" &&
      ctx.simulationOk !== true
    ) {
      return {
        decision: "block",
        code: "SIMULATION_REQUIRED",
        message: "Simulation required before broadcasting on mainnet",
      };
    }

    // 3) allowlist by action
    const allowedActions = this.config.allowlist.actions ?? [];
    if (allowedActions.length && !allowedActions.includes(ctx.action)) {
      return {
        decision: "block",
        code: "ACTION_NOT_ALLOWED",
        message: `Action not allowed: ${ctx.action}`,
      };
    }

    // 4) solana program allowlist
    if (ctx.chain === "solana") {
      const allowedPrograms = this.config.allowlist.solanaPrograms ?? [];
      if (allowedPrograms.length) {
        // Fail-closed: if we cannot determine programIds, do not broadcast.
        if (ctx.programIdsKnown !== true) {
          return {
            decision: "block",
            code: "PROGRAMS_UNKNOWN",
            message: "Cannot determine Solana program ids for this transaction (ALT lookup failed or missing). Refusing to broadcast.",
          };
        }

        const used = ctx.programIds ?? [];
        const notAllowed = used.filter((p) => !allowedPrograms.includes(p));
        if (notAllowed.length) {
          return {
            decision: "block",
            code: "PROGRAM_NOT_ALLOWED",
            message: `Solana program not allowed: ${notAllowed[0]}`,
          };
        }
      }
    }

    // 5) basic limits
    if (typeof ctx.amountUsd === "number" && ctx.amountUsd > this.config.transactions.maxSingleAmountUsd) {
      return {
        decision: "confirm",
        code: "AMOUNT_LARGE",
        message: `Large amount: $${ctx.amountUsd.toFixed(2)}`,
        confirmationKey: "amount_large",
      };
    }

    if (typeof ctx.slippageBps === "number" && ctx.slippageBps > this.config.transactions.maxSlippageBps) {
      return {
        decision: "confirm",
        code: "SLIPPAGE_HIGH",
        message: `High slippage: ${(ctx.slippageBps / 100).toFixed(2)}%`,
        confirmationKey: "slippage_high",
      };
    }

    return { decision: "allow" };
  }
}

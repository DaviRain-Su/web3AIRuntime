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

    // 5) conservative runtime rate limits (best-effort)
    if (ctx.sideEffect === "broadcast") {
      const cooldown = this.config.transactions.cooldownSeconds;
      if (
        typeof cooldown === "number" &&
        cooldown > 0 &&
        typeof ctx.secondsSinceLastBroadcast === "number" &&
        ctx.secondsSinceLastBroadcast >= 0 &&
        ctx.secondsSinceLastBroadcast < cooldown
      ) {
        return {
          decision: "block",
          code: "COOLDOWN_ACTIVE",
          message: `Cooldown active: wait ${Math.ceil(cooldown - ctx.secondsSinceLastBroadcast)}s before broadcasting again`,
        };
      }

      const maxPerMin = this.config.transactions.maxTxPerMinute;
      if (
        typeof maxPerMin === "number" &&
        maxPerMin > 0 &&
        typeof ctx.broadcastsLastMinute === "number" &&
        ctx.broadcastsLastMinute >= maxPerMin
      ) {
        return {
          decision: "block",
          code: "RATE_LIMIT",
          message: `Rate limit exceeded: ${ctx.broadcastsLastMinute} broadcasts in last minute (max ${maxPerMin})`,
        };
      }
    }

    // 6) basic limits
    if (typeof ctx.amountSol === "number" && typeof this.config.transactions.maxSingleSol === "number") {
      if (ctx.amountSol > this.config.transactions.maxSingleSol) {
        return {
          decision: "confirm",
          code: "AMOUNT_SOL_LARGE",
          message: `Large SOL amount: ${ctx.amountSol.toFixed(4)} SOL`,
          confirmationKey: "amount_sol_large",
        };
      }
    }

    if (typeof ctx.amountUsd === "number" && ctx.amountUsd > this.config.transactions.maxSingleAmountUsd) {
      return {
        decision: "confirm",
        code: "AMOUNT_LARGE",
        message: `Large amount: $${ctx.amountUsd.toFixed(2)}`,
        confirmationKey: "amount_large",
      };
    }

    // Prefer simulation-derived slippage if available (more reality-based than requested).
    const slippageToCheck = typeof ctx.simulatedSlippageBps === "number" ? ctx.simulatedSlippageBps : ctx.slippageBps;
    const slippageLabel = typeof ctx.simulatedSlippageBps === "number" ? "Simulated slippage" : "Requested slippage";

    if (typeof slippageToCheck === "number" && slippageToCheck > this.config.transactions.maxSlippageBps) {
      return {
        decision: "confirm",
        code: typeof ctx.simulatedSlippageBps === "number" ? "SIMULATED_SLIPPAGE_HIGH" : "SLIPPAGE_HIGH",
        message: `${slippageLabel}: ${(slippageToCheck / 100).toFixed(2)}%`,
        confirmationKey: "slippage_high",
      };
    }

    return { decision: "allow" };
  }
}

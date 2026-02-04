import type { PolicyConfig, PolicyContext, PolicyDecision } from "./types.js";
import { evaluateRules } from "./rules.js";

export class PolicyEngine {
  constructor(public readonly config: PolicyConfig) {}

  decide(ctx: PolicyContext): PolicyDecision {
    const reasons: string[] = [];

    // 1) network gates
    if (ctx.network === "mainnet") {
      if (!this.config.networks.mainnet.enabled) {
        return { decision: "block", code: "MAINNET_DISABLED", message: "Mainnet disabled", reasons: ["networks.mainnet.enabled=false"] };
      }
      reasons.push("network=mainnet");
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
        reasons: [
          "networks.mainnet.requireSimulation=true",
          "sideEffect=broadcast",
          "simulationOk!=true",
        ],
      };
    }

    // 3) allowlist by action
    const allowedActions = this.config.allowlist.actions ?? [];
    if (allowedActions.length && !allowedActions.includes(ctx.action)) {
      return {
        decision: "block",
        code: "ACTION_NOT_ALLOWED",
        message: `Action not allowed: ${ctx.action}`,
        reasons: [`allowlist.actions excludes ${ctx.action}`],
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
            reasons: ["allowlist.solanaPrograms set", "programIdsKnown!=true"],
          };
        }

        const used = ctx.programIds ?? [];
        const notAllowed = used.filter((p) => !allowedPrograms.includes(p));
        if (notAllowed.length) {
          return {
            decision: "block",
            code: "PROGRAM_NOT_ALLOWED",
            message: `Solana program not allowed: ${notAllowed[0]}`,
            reasons: ["allowlist.solanaPrograms set", `programId not allowed: ${notAllowed[0]}`],
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
          reasons: ["transactions.cooldownSeconds", `secondsSinceLastBroadcast=${ctx.secondsSinceLastBroadcast}`],
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
          reasons: ["transactions.maxTxPerMinute", `broadcastsLastMinute=${ctx.broadcastsLastMinute}`],
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
          reasons: ["transactions.maxSingleSol", `amountSol=${ctx.amountSol}`],
        };
      }
    }

    if (typeof ctx.amountUsd === "number" && ctx.amountUsd > this.config.transactions.maxSingleAmountUsd) {
      return {
        decision: "confirm",
        code: "AMOUNT_LARGE",
        message: `Large amount: $${ctx.amountUsd.toFixed(2)}`,
        confirmationKey: "amount_large",
        reasons: ["transactions.maxSingleAmountUsd", `amountUsd=${ctx.amountUsd}`],
      };
    }

    // Prefer simulation-derived slippage if available (more reality-based than requested).
    // This check only applies to Solana swaps where we can derive slippage from simulation.
    const requireSimSlip = this.config.transactions.requireSimulatedSlippageOnMainnet === true;
    if (
      requireSimSlip &&
      ctx.chain === "solana" &&
      ctx.network === "mainnet" &&
      ctx.sideEffect === "broadcast" &&
      ctx.action === "swap" &&
      typeof ctx.simulatedSlippageBps !== "number"
    ) {
      return {
        decision: "block",
        code: "SIMULATED_SLIPPAGE_REQUIRED",
        message: "Mainnet swap requires simulation-derived slippage estimate before broadcasting",
        reasons: ["transactions.requireSimulatedSlippageOnMainnet=true", "simulatedSlippageBps missing"],
      };
    }

    const slippageToCheck = typeof ctx.simulatedSlippageBps === "number" ? ctx.simulatedSlippageBps : ctx.slippageBps;
    const slippageLabel = typeof ctx.simulatedSlippageBps === "number" ? "Simulated slippage" : "Requested slippage";

    if (typeof slippageToCheck === "number" && slippageToCheck > this.config.transactions.maxSlippageBps) {
      return {
        decision: "confirm",
        code: typeof ctx.simulatedSlippageBps === "number" ? "SIMULATED_SLIPPAGE_HIGH" : "SLIPPAGE_HIGH",
        message: `${slippageLabel}: ${(slippageToCheck / 100).toFixed(2)}%`,
        confirmationKey: "slippage_high",
        reasons: ["transactions.maxSlippageBps", `${slippageLabel}=${slippageToCheck}`],
      };
    }

    // 7) Custom rules DSL evaluation
    if (this.config.rules && this.config.rules.length > 0) {
      const ruleResult = evaluateRules(this.config.rules, ctx);
      if (ruleResult && ruleResult.matched) {
        const message = ruleResult.message ?? `Rule matched: ${ruleResult.ruleName}`;
        switch (ruleResult.action) {
          case "block":
            return {
              decision: "block",
              code: `RULE_${ruleResult.ruleName?.toUpperCase() ?? "BLOCKED"}`,
              message,
              reasons: [`rule:${ruleResult.ruleName}`],
            };
          case "confirm":
            return {
              decision: "confirm",
              code: `RULE_${ruleResult.ruleName?.toUpperCase() ?? "CONFIRM"}`,
              message,
              confirmationKey: `rule_${ruleResult.ruleName ?? "confirm"}`,
              reasons: [`rule:${ruleResult.ruleName}`],
            };
          case "warn":
            return {
              decision: "warn",
              code: `RULE_${ruleResult.ruleName?.toUpperCase() ?? "WARN"}`,
              message,
              reasons: [`rule:${ruleResult.ruleName}`],
            };
        }
      }
    }

    return { decision: "allow", reasons };
  }
}

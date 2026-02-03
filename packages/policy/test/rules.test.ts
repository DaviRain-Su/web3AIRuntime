import { describe, test, expect } from "bun:test";
import { evaluateCondition, evaluateRule, evaluateRules } from "../src/rules.js";
import type { PolicyRule, PolicyContext } from "../src/types.js";

describe("evaluateCondition", () => {
  test("simple comparison ==", () => {
    expect(evaluateCondition("amount == 100", { amount: 100 })).toBe(true);
    expect(evaluateCondition("amount == 100", { amount: 50 })).toBe(false);
  });

  test("simple comparison !=", () => {
    expect(evaluateCondition("status != 'ok'", { status: "error" })).toBe(true);
    expect(evaluateCondition("status != 'ok'", { status: "ok" })).toBe(false);
  });

  test("numeric comparisons", () => {
    expect(evaluateCondition("amount > 100", { amount: 150 })).toBe(true);
    expect(evaluateCondition("amount > 100", { amount: 50 })).toBe(false);
    expect(evaluateCondition("amount >= 100", { amount: 100 })).toBe(true);
    expect(evaluateCondition("amount < 100", { amount: 50 })).toBe(true);
    expect(evaluateCondition("amount <= 100", { amount: 100 })).toBe(true);
  });

  test("string literals", () => {
    expect(evaluateCondition("chain == 'solana'", { chain: "solana" })).toBe(true);
    expect(evaluateCondition('chain == "ethereum"', { chain: "ethereum" })).toBe(true);
  });

  test("boolean literals", () => {
    expect(evaluateCondition("enabled == true", { enabled: true })).toBe(true);
    expect(evaluateCondition("enabled == false", { enabled: false })).toBe(true);
  });

  test("dot path access", () => {
    expect(evaluateCondition("ctx.amount > 50", { ctx: { amount: 100 } })).toBe(true);
    expect(evaluateCondition("user.wallet.balance >= 10", { user: { wallet: { balance: 15 } } })).toBe(true);
  });

  test("AND operator", () => {
    expect(evaluateCondition("amount > 50 && chain == 'solana'", { amount: 100, chain: "solana" })).toBe(true);
    expect(evaluateCondition("amount > 50 && chain == 'solana'", { amount: 100, chain: "eth" })).toBe(false);
    expect(evaluateCondition("amount > 50 and chain == 'solana'", { amount: 100, chain: "solana" })).toBe(true);
  });

  test("OR operator", () => {
    expect(evaluateCondition("amount > 100 || chain == 'solana'", { amount: 50, chain: "solana" })).toBe(true);
    expect(evaluateCondition("amount > 100 || chain == 'solana'", { amount: 50, chain: "eth" })).toBe(false);
  });

  test("NOT operator", () => {
    expect(evaluateCondition("!enabled", { enabled: false })).toBe(true);
    expect(evaluateCondition("not enabled", { enabled: false })).toBe(true);
    expect(evaluateCondition("!enabled", { enabled: true })).toBe(false);
  });

  test("parentheses", () => {
    expect(evaluateCondition("(amount > 50) && (chain == 'solana')", { amount: 100, chain: "solana" })).toBe(true);
    expect(evaluateCondition("(amount > 100 || amount < 10) && chain == 'solana'", { amount: 5, chain: "solana" })).toBe(true);
  });

  test("complex expression", () => {
    const ctx = { amountUsd: 5000, chain: "solana", action: "swap" };
    expect(evaluateCondition("amountUsd > 1000 && chain == 'solana' && action == 'swap'", ctx)).toBe(true);
  });

  test("undefined path returns falsy", () => {
    expect(evaluateCondition("missing.path == 'value'", {})).toBe(false);
    expect(evaluateCondition("missing.path > 0", {})).toBe(false);
  });
});

describe("evaluateRule", () => {
  test("matches rule and returns action", () => {
    const rule: PolicyRule = {
      name: "large_amount",
      condition: "amountUsd > 5000",
      action: "confirm",
      message: "Large transaction requires confirmation",
    };

    const ctx = { amountUsd: 10000 } as any as PolicyContext;
    const result = evaluateRule(rule, ctx);

    expect(result.matched).toBe(true);
    expect(result.action).toBe("confirm");
    expect(result.message).toBe("Large transaction requires confirmation");
    expect(result.ruleName).toBe("large_amount");
  });

  test("does not match rule", () => {
    const rule: PolicyRule = {
      name: "large_amount",
      condition: "amountUsd > 5000",
      action: "block",
    };

    const ctx = { amountUsd: 100 } as any as PolicyContext;
    const result = evaluateRule(rule, ctx);

    expect(result.matched).toBe(false);
  });
});

describe("evaluateRules", () => {
  const rules: PolicyRule[] = [
    {
      name: "block_huge",
      condition: "amountUsd > 10000",
      action: "block",
      message: "Amount too large",
    },
    {
      name: "confirm_large",
      condition: "amountUsd > 1000",
      action: "confirm",
      message: "Requires confirmation",
    },
    {
      name: "allow_small",
      condition: "amountUsd <= 1000",
      action: "allow",
    },
  ];

  test("returns first blocking rule", () => {
    const ctx = { amountUsd: 15000 } as any as PolicyContext;
    const result = evaluateRules(rules, ctx);

    expect(result?.matched).toBe(true);
    expect(result?.action).toBe("block");
    expect(result?.ruleName).toBe("block_huge");
  });

  test("returns first non-allow rule", () => {
    const ctx = { amountUsd: 5000 } as any as PolicyContext;
    const result = evaluateRules(rules, ctx);

    expect(result?.matched).toBe(true);
    expect(result?.action).toBe("confirm");
    expect(result?.ruleName).toBe("confirm_large");
  });

  test("returns null if only allow rules match", () => {
    const ctx = { amountUsd: 500 } as any as PolicyContext;
    const result = evaluateRules(rules, ctx);

    expect(result).toBe(null);
  });
});

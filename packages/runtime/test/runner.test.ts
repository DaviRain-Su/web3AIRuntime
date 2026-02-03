import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runWorkflow } from "../src/runner.js";

function readJsonl(path: string) {
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("runWorkflow (new runner)", () => {
  test("runs mock workflow with new engine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w3rt-runner-test-"));
    const wf = resolve(new URL("../../../workflows/mock-arb.yaml", import.meta.url).pathname);

    // Create a permissive policy for testing
    const policyDir = dir;
    mkdirSync(policyDir, { recursive: true });
    writeFileSync(
      join(policyDir, "policy.yaml"),
      `
networks:
  mainnet:
    enabled: true
    requireApproval: false
    requireSimulation: false
    maxDailyVolumeUsd: 10000
  testnet:
    enabled: true
    requireApproval: false
transactions:
  maxSingleAmountUsd: 1000
  maxSlippageBps: 500
  requireConfirmation: never
allowlist:
  actions: []
rules: []
`
    );

    const result = await runWorkflow(wf, {
      w3rtDir: dir,
      approve: async () => true,
    });

    if (!result.ok) {
      console.log("Runner failed:", result.error);
      console.log("Context:", JSON.stringify(result.context, null, 2).slice(0, 500));
    }

    expect(result.ok).toBe(true);
    expect(result.runId).toBeDefined();

    // Check trace was written
    const tracePath = join(dir, "runs", result.runId, "trace.jsonl");
    const events = readJsonl(tracePath);

    expect(events[0].type).toBe("run.started");
    expect(events[events.length - 1].type).toBe("run.finished");
    expect(events[events.length - 1].data.ok).toBe(true);

    // Check intermediate events exist
    const stepEvents = events.filter((e: any) => e.type === "step.started");
    expect(stepEvents.length).toBeGreaterThan(0);

    const toolEvents = events.filter((e: any) => e.type === "tool.called");
    expect(toolEvents.length).toBeGreaterThan(0);
  });

  test("policy blocks when action not allowed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w3rt-runner-policy-"));
    const wf = resolve(new URL("../../../workflows/mock-arb.yaml", import.meta.url).pathname);

    // Create restrictive policy
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "policy.yaml"),
      `
networks:
  mainnet:
    enabled: true
    requireApproval: false
    requireSimulation: false
    maxDailyVolumeUsd: 10000
  testnet:
    enabled: true
    requireApproval: false
transactions:
  maxSingleAmountUsd: 1000
  maxSlippageBps: 500
  requireConfirmation: never
allowlist:
  actions:
    - balance
    - quote
rules: []
`
    );

    const result = await runWorkflow(wf, {
      w3rtDir: dir,
      approve: async () => true,
    });

    // Should fail because swap action is not allowed
    expect(result.ok).toBe(false);
    expect(result.error).toContain("ACTION_NOT_ALLOWED");
  });
});

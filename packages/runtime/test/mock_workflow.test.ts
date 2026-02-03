import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { runWorkflowFromFile } from "../src/run";

function readJsonl(path: string) {
  const raw = readFileSync(path, "utf-8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("w3rt core runner", () => {
  test("runs mock workflow and writes trace", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w3rt-test-"));
    const wf = resolve(new URL("../../../workflows/mock-arb.yaml", import.meta.url).pathname);

    // The legacy runner loads policy from process.cwd()/.w3rt/policy.yaml.
    // Create a permissive policy in an isolated cwd so tests don't depend on repo-level policy.
    const prevCwd = process.cwd();
    process.chdir(dir);
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(join(dir, ".w3rt"), { recursive: true });
      writeFileSync(
        join(dir, ".w3rt", "policy.yaml"),
        `
networks:
  mainnet:
    enabled: true
    requireApproval: false
    requireSimulation: false
  testnet:
    enabled: true
    requireApproval: false
transactions:
  maxSingleAmountUsd: 100000
  maxSlippageBps: 1000
  requireConfirmation: never
allowlist:
  actions: []
rules: []
`
      );

      // Also force a non-mainnet RPC for test determinism.
      process.env.W3RT_SOLANA_RPC_URL = "https://api.devnet.solana.com";

      const { runId } = await runWorkflowFromFile(wf, {
        w3rtDir: dir,
        approve: async () => true,
      });

      const tracePath = join(dir, "runs", runId, "trace.jsonl");
      const events = readJsonl(tracePath);

      expect(events[0].type).toBe("run.started");
      expect(events[events.length - 1].type).toBe("run.finished");
      expect(events[events.length - 1].data.ok).toBe(true);
    } finally {
      process.chdir(prevCwd);
    }
  });
});

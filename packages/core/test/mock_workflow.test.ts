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

    const { runId } = await runWorkflowFromFile(wf, {
      w3rtDir: dir,
      approve: async () => true,
    });

    const tracePath = join(dir, "runs", runId, "trace.jsonl");
    const events = readJsonl(tracePath);

    expect(events[0].type).toBe("run.started");
    expect(events[events.length - 1].type).toBe("run.finished");
    expect(events[events.length - 1].data.ok).toBe(true);
  });
});

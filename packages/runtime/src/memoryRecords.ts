import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalizeJson, sha256Hex } from "./artifactHash.js";

export type MemoryRecordV1 = {
  // minimal required fields (keep names stable)
  run_id: string;
  reasoning_hash: string;
  artifacts_hash: string;
  policy_decision: string;
  outcome: "success" | "fail";
  ts: string; // ISO timestamp

  // helpful metadata (optional)
  idempotency_key?: string;
  schema_version?: "v1";
  hash_alg?: "sha256";
};

export function computeMemoryRecordIdempotencyKey(record: Pick<MemoryRecordV1, "run_id" | "reasoning_hash" | "artifacts_hash">): string {
  // simple, deterministic key; can be replaced later if AgentMemory specifies different semantics
  return sha256Hex(`${record.run_id}${record.reasoning_hash}${record.artifacts_hash}`);
}

export function canonicalizeMemoryRecord(record: MemoryRecordV1): string {
  // stable JSON for hashing / future signature binding
  return canonicalizeJson(record);
}

export function writeMemoryRecord(w3rtDir: string, record: MemoryRecordV1): {
  path: string;
  idempotency_key: string;
  canonical_json: string;
} {
  const dir = join(w3rtDir, "memory_records");
  mkdirSync(dir, { recursive: true });

  const idempotency_key = record.idempotency_key ?? computeMemoryRecordIdempotencyKey(record);
  const out: MemoryRecordV1 = {
    schema_version: record.schema_version ?? "v1",
    hash_alg: record.hash_alg ?? "sha256",
    ...record,
    idempotency_key,
  };

  const canonical_json = canonicalizeMemoryRecord(out);
  const path = join(dir, `${record.run_id}.json`);

  // Write a readable copy; hash/canonicalization is derived from `canonical_json`.
  writeFileSync(path, JSON.stringify(out, null, 2), { flag: "w" });

  return { path, idempotency_key, canonical_json };
}

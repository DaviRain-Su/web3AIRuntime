import crypto from "node:crypto";

// Canonical JSON (stable) for hashing.
// - Sort object keys lexicographically
// - Preserve array order
// - Remove undefined
// - Convert BigInt -> string
// - No whitespace
export function canonicalizeJson(value: any): string {
  return JSON.stringify(sortAndClean(value));
}

export function canonicalizeObject(value: any): any {
  return sortAndClean(value);
}

function sortAndClean(v: any): any {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (typeof v === "bigint") return v.toString();
  if (typeof v !== "object") return v;
  if (Array.isArray(v)) {
    return v.map(sortAndClean).filter((x) => x !== undefined);
  }
  const out: any = {};
  const keys = Object.keys(v).sort();
  for (const k of keys) {
    const vv = sortAndClean(v[k]);
    if (vv !== undefined) out[k] = vv;
  }
  return out;
}

export function sha256Hex(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

export const ARTIFACT_SCHEMA_VERSION = "v1" as const;

export function computeArtifactHash(artifact: any): {
  schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  hashAlg: "sha256";
  artifactHash: string;
  canonicalJson: string;
} {
  const canonicalJson = canonicalizeJson(artifact);
  const artifactHash = sha256Hex(canonicalJson);
  return { schemaVersion: ARTIFACT_SCHEMA_VERSION, hashAlg: "sha256", artifactHash, canonicalJson };
}

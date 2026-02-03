import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";

import { Connection, Keypair, PublicKey, VersionedTransaction, type Commitment } from "@solana/web3.js";

import { defaultRegistry, jupiterAdapter } from "@w3rt/adapters";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";
import { TraceStore } from "@w3rt/trace";

import { loadSolanaKeypair, resolveSolanaRpc } from "./run.js";

type Dict = Record<string, any>;

type Prepared = {
  preparedId: string;
  createdAt: number;
  expiresAt: number;
  traceId: string;
  chain: "solana";
  adapter: string;
  action: string;
  params: Dict;
  txB64: string;
  // extra signers (secret keys); NEVER returned to client; memory-only
  extraSigners?: Uint8Array[];
  simulation?: { ok: boolean; logs?: string[]; unitsConsumed?: number | null };
  programIds?: string[];
  programIdsKnown: boolean;
  network: "mainnet" | "devnet" | "testnet" | "unknown";
};

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function loadYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw) as T;
}

function inferNetworkFromRpcUrl(rpcUrl: string): Prepared["network"] {
  const u = rpcUrl.toLowerCase();
  if (u.includes("devnet")) return "devnet";
  if (u.includes("testnet")) return "testnet";
  // heuristic; many private RPCs are mainnet
  if (u.includes("mainnet")) return "mainnet";
  return "unknown";
}

async function extractSolanaProgramIdsFromTxB64(txB64: string, rpcUrl: string): Promise<{ programIds: string[]; known: boolean }> {
  try {
    const raw = Buffer.from(txB64, "base64");
    const tx = VersionedTransaction.deserialize(raw);

    const conn = new Connection(rpcUrl, { commitment: "processed" as Commitment });

    // Resolve ALTs
    const lookups = tx.message.addressTableLookups ?? [];
    const altAccounts: any[] = [];

    for (const l of lookups) {
      const key = new PublicKey(l.accountKey);
      const res = await conn.getAddressLookupTable(key);
      if (res.value) altAccounts.push(res.value);
    }

    const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: altAccounts });

    const programIds = new Set<string>();
    for (const ix of tx.message.compiledInstructions) {
      const pk = keys.get(ix.programIdIndex);
      if (pk) programIds.add(pk.toBase58());
    }

    return { programIds: [...programIds], known: true };
  } catch {
    return { programIds: [], known: false };
  }
}

async function readJsonBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw) return {};
  return JSON.parse(raw);
}

function sendJson(res: http.ServerResponse, code: number, body: any) {
  const data = JSON.stringify(body, null, 2);
  res.statusCode = code;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(data);
}

function notFound(res: http.ServerResponse) {
  sendJson(res, 404, { ok: false, error: "NOT_FOUND" });
}

function registerAdapters() {
  // Keep adapter registration minimal.
  // Meteora DLMM SDK currently crashes under Node v24 in this environment; register it elsewhere when supported.
  for (const a of [jupiterAdapter]) {
    try {
      defaultRegistry.register(a);
    } catch {
      // ignore duplicate
    }
  }
}

export async function startDaemon(opts: { port?: number; host?: string; w3rtDir?: string; preparedTtlMs?: number } = {}) {
  registerAdapters();

  const port = opts.port ?? Number(process.env.W3RT_DAEMON_PORT ?? 8787);
  const host = opts.host ?? String(process.env.W3RT_DAEMON_HOST ?? "127.0.0.1");
  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  const ttlMs = opts.preparedTtlMs ?? 15 * 60 * 1000;

  mkdirSync(w3rtDir, { recursive: true });

  // policy config (optional)
  let policy: PolicyEngine | undefined;
  try {
    const policyCfg = loadYamlFile<PolicyConfig>(join(process.cwd(), ".w3rt", "policy.yaml"));
    policy = new PolicyEngine(policyCfg);
  } catch {
    policy = undefined;
  }

  const prepared = new Map<string, Prepared>();

  // cleanup timer
  setInterval(() => {
    const now = Date.now();
    for (const [k, v] of prepared.entries()) {
      if (v.expiresAt <= now) prepared.delete(k);
    }
  }, 10_000).unref();

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

      // health
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions/prepare") {
        const body = await readJsonBody(req);
        const chain = String(body.chain || "solana");
        const adapter = String(body.adapter || "");
        const action = String(body.action || "");
        const params = (body.params ?? {}) as Dict;

        if (chain !== "solana") return sendJson(res, 400, { ok: false, error: "UNSUPPORTED_CHAIN" });
        if (!adapter) return sendJson(res, 400, { ok: false, error: "MISSING_ADAPTER" });
        if (!action) return sendJson(res, 400, { ok: false, error: "MISSING_ACTION" });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "processed" as Commitment });

        const traceId = crypto.randomUUID();
        const trace = new TraceStore(w3rtDir);

        trace.emit({ ts: Date.now(), type: "run.started", runId: traceId, data: { mode: "prepare", chain, adapter, action, network } });

        // build tx
        const built = await defaultRegistry.get(adapter).buildTx(action, params, {
          userPublicKey: kp.publicKey.toBase58(),
          rpcUrl,
        });

        const txB64 = built.txB64;
        const extraSigners = (built as any).signers as Uint8Array[] | undefined;

        // simulate
        let simulation: Prepared["simulation"] = { ok: true };
        try {
          const raw = Buffer.from(txB64, "base64");
          const vtx = VersionedTransaction.deserialize(raw);
          const sim = await conn.simulateTransaction(vtx, {
            sigVerify: false,
            replaceRecentBlockhash: true,
            commitment: "processed",
          } as any);

          if (sim.value.err) {
            simulation = { ok: false, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed ?? null };
          } else {
            simulation = { ok: true, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed ?? null };
          }
        } catch (e: any) {
          simulation = { ok: false, logs: [String(e?.message ?? e)] };
        }

        // program ids (best-effort)
        const { programIds, known } = await extractSolanaProgramIdsFromTxB64(txB64, rpcUrl);

        // policy
        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: String((built as any)?.meta?.action ?? action),
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIds,
              programIdsKnown: known,
            } as any)
          : { decision: "allow" };

        const requiresApproval = decision.decision === "confirm";
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();

        prepared.set(preparedId, {
          preparedId,
          createdAt: now,
          expiresAt: now + ttlMs,
          traceId,
          chain: "solana",
          adapter,
          action,
          params,
          txB64,
          extraSigners,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
        });

        trace.emit({
          ts: Date.now(),
          type: "step.finished",
          runId: traceId,
          stepId: "prepare",
          data: {
            ok: true,
            adapter,
            action,
            meta: built.meta,
            simulation: { ok: simulation.ok, unitsConsumed: simulation.unitsConsumed ?? null },
            policy: decision,
            programIdsKnown: known,
            programIds,
          },
        });
        trace.emit({ ts: Date.now(), type: "run.finished", runId: traceId, data: { ok: true } });

        return sendJson(res, 200, {
          ok: true,
          allowed,
          requiresApproval,
          preparedId,
          txB64,
          traceId,
          policyReport: decision,
          simulation,
        });
      }

      if (req.method === "POST" && url.pathname === "/v1/actions/execute") {
        const body = await readJsonBody(req);
        const preparedId = String(body.preparedId || "");
        const confirm = body.confirm === true;
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        const item = prepared.get(preparedId);
        if (!item) return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        if (item.expiresAt <= Date.now()) {
          prepared.delete(preparedId);
          return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        }

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });

        const traceId = item.traceId; // reuse prepare traceId for now
        const trace = new TraceStore(defaultW3rtDir());

        // policy gate for broadcast
        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: String(item.action),
              sideEffect: "broadcast",
              simulationOk: item.simulation?.ok === true,
              programIds: item.programIds ?? [],
              programIdsKnown: item.programIdsKnown === true,
            } as any)
          : { decision: "allow" };

        if (decision.decision === "block") {
          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: false, policy: decision } });
          return sendJson(res, 403, { ok: false, error: "POLICY_BLOCK", policyReport: decision, traceId });
        }

        if (decision.decision === "confirm") {
          // caller already confirmed; proceed
        }

        // sign + send
        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);
        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });

        trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: true, signature: sig } });

        // one-shot use by default
        prepared.delete(preparedId);

        return sendJson(res, 200, { ok: true, signature: sig, traceId });
      }

      if (req.method === "GET" && url.pathname.startsWith("/v1/traces/")) {
        const traceId = decodeURIComponent(url.pathname.split("/").pop() || "");
        if (!traceId) return sendJson(res, 400, { ok: false, error: "MISSING_TRACE_ID" });

        const p = join(defaultW3rtDir(), "runs", traceId, "trace.jsonl");
        try {
          const raw = readFileSync(p, "utf-8");
          const lines = raw
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return { raw: l };
              }
            });
          return sendJson(res, 200, { ok: true, traceId, events: lines });
        } catch {
          return sendJson(res, 404, { ok: false, error: "TRACE_NOT_FOUND" });
        }
      }

      return notFound(res);
    } catch (err: any) {
      return sendJson(res, 500, { ok: false, error: "INTERNAL", message: String(err?.message ?? err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  // eslint-disable-next-line no-console
  console.log(`w3rt daemon listening on http://${host}:${port}`);
}

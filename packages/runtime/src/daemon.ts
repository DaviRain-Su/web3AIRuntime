import http from "node:http";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import { SolanaDriver, EvmDriver, type ChainDriver } from "./driver/index.js";
import { computeArtifactHash, canonicalizeObject } from "./artifactHash.js";
import { writeMemoryRecord } from "./memoryRecords.js";

import { defaultRegistry, jupiterAdapter, meteoraDlmmAdapter, solendAdapter } from "@w3rt/adapters";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";
import { TraceStore } from "@w3rt/trace";

import { loadSolanaKeypair, resolveSolanaRpc } from "./run.js";

// Minimal SPL helpers (copied from runtime solana tool):
const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  // ATA = findProgramAddress([owner, tokenProgram, mint], associatedTokenProgram)
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx(params: { payer: PublicKey; ata: PublicKey; owner: PublicKey; mint: PublicKey }): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createSplTransferIx(params: { source: PublicKey; dest: PublicKey; owner: PublicKey; amount: bigint }): TransactionInstruction {
  // SPL Token Transfer (instruction=3)
  const data = Buffer.alloc(1 + 8);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(params.amount, 1);
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.source, isSigner: false, isWritable: true },
      { pubkey: params.dest, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: true, isWritable: false },
    ],
    data,
  });
}

type Dict = Record<string, any>;

type PlanAction = {
  id?: string;
  dependsOn?: string[];
  chain?: string;
  adapter?: string;
  action?: string;
  params?: Dict;
};

function makeDriverRegistry(rpcUrl: string): Record<string, ChainDriver> {
  // Future: allow per-chain rpcUrl overrides in ctx.
  return {
    solana: new SolanaDriver(),
    evm: new EvmDriver(),
  };
}

function normalizeActions(raw: any): PlanAction[] {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((a, i) => ({
    id: String(a?.id ?? `a${i}`),
    dependsOn: Array.isArray(a?.dependsOn) ? a.dependsOn.map((x: any) => String(x)) : [],
    chain: String(a?.chain ?? "solana"),
    adapter: String(a?.adapter ?? ""),
    action: String(a?.action ?? ""),
    params: (a?.params ?? {}) as Dict,
  }));
}

function topoOrderActions(actions: PlanAction[]): { ordered: PlanAction[]; cycles: string[] } {
  const byId = new Map(actions.map((a) => [String(a.id), a]));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();

  for (const a of actions) {
    const id = String(a.id);
    indeg.set(id, 0);
    out.set(id, []);
  }

  for (const a of actions) {
    const id = String(a.id);
    for (const dep of a.dependsOn ?? []) {
      if (!byId.has(dep)) continue; // ignore missing deps for now
      indeg.set(id, (indeg.get(id) ?? 0) + 1);
      out.get(dep)!.push(id);
    }
  }

  const q: string[] = [];
  for (const [id, d] of indeg.entries()) if (d === 0) q.push(id);

  const ordered: PlanAction[] = [];
  while (q.length) {
    const id = q.shift()!;
    const a = byId.get(id);
    if (a) ordered.push(a);
    for (const nxt of out.get(id) ?? []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) q.push(nxt);
    }
  }

  const cycles = [...indeg.entries()].filter(([, d]) => d! > 0).map(([id]) => id);
  return { ordered, cycles };
}

function findRepoRoot(): string {
  // Try cwd first (common when running via repo root).
  const starts = [process.cwd(), dirname(fileURLToPath(import.meta.url))];
  for (const start of starts) {
    let cur = start;
    for (let i = 0; i < 8; i++) {
      const pj = join(cur, "package.json");
      if (existsSync(pj)) {
        try {
          const j = JSON.parse(readFileSync(pj, "utf-8"));
          if (j?.name === "web3-ai-runtime" && Array.isArray(j?.workspaces)) return cur;
        } catch {
          // ignore
        }
      }
      const parent = dirname(cur);
      if (parent === cur) break;
      cur = parent;
    }
  }
  // fallback: assume cwd is good
  return process.cwd();
}

function spawnAsync(cmd: string, args: string[], opts: { cwd?: string; timeoutMs?: number; input?: string } = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolveP, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    const to = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`spawn timeout after ${opts.timeoutMs ?? 30_000}ms`));
    }, opts.timeoutMs ?? 30_000);

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (d) => (stdout += d.toString("utf-8")));
    child.stderr?.on("data", (d) => (stderr += d.toString("utf-8")));

    child.on("error", (e) => {
      clearTimeout(to);
      const err: any = new Error(`spawn failed: ${e.message}`);
      err.stdout = stdout;
      err.stderr = stderr;
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(to);
      if (code !== 0) {
        const err: any = new Error(`spawn exit ${code}`);
        err.stdout = stdout;
        err.stderr = stderr;
        return reject(err);
      }
      resolveP({ stdout, stderr });
    });

    if (opts.input != null) {
      child.stdin?.write(opts.input);
    }
    child.stdin?.end();
  });
}

async function solendPrepareDepositTx(params: {
  rpcUrl: string;
  userPublicKey: string;
  amountBase: string;
  symbol?: string;
}): Promise<{ txB64: string; simulation: Prepared["simulation"]; meta?: any; programIds?: string[] }> {
  const repoRoot = findRepoRoot();
  const workerDir = join(repoRoot, "packages", "solend-worker");
  const workerPath = join(workerDir, "worker.js");

  const input = {
    rpcUrl: params.rpcUrl,
    userPublicKey: params.userPublicKey,
    amountBase: params.amountBase,
    symbol: params.symbol ?? "USDC",
  };

  const { stdout } = await spawnAsync(process.execPath, [workerPath], {
    cwd: workerDir,
    timeoutMs: 60_000,
    input: JSON.stringify(input),
  });

  // worker prints single-line JSON
  const raw = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const j = raw ? JSON.parse(raw) : null;
  if (!j?.ok) {
    throw new Error(`solend-worker failed: ${j?.error ?? "UNKNOWN"} ${j?.message ?? ""}`.trim());
  }

  const simulation: Prepared["simulation"] = j.simulation
    ? {
        ok: j.simulation.err == null,
        err: j.simulation.err ?? undefined,
        logs: j.simulation.logs ?? [],
        unitsConsumed: j.simulation.unitsConsumed ?? null,
      }
    : undefined;

  return { txB64: String(j.txB64), simulation, meta: j.meta, programIds: j.programIds };
}

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
  recentBlockhash?: string;
  lastValidBlockHeight?: number;
  // extra signers (secret keys); NEVER returned to client; memory-only
  extraSigners?: Uint8Array[];
  simulation?: { ok: boolean; err?: any; logs?: string[]; unitsConsumed?: number | null };
  programIds?: string[];
  programIdsKnown: boolean;
  network: "mainnet" | "devnet" | "testnet" | "unknown";

  // Public verification helpers
  artifactSchemaVersion?: string;
  hashAlg?: string;
  artifactHash?: string;
  artifactCanonicalJson?: string;
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

function normalizePolicyAction(action: string): string {
  const a = String(action || "").toLowerCase();
  if (a.includes("swap")) return "swap";
  if (a.includes("transfer")) return "transfer";
  if (a.includes("balance")) return "balance";
  if (a.includes("quote")) return "quote";
  if (a.includes("simulate")) return "simulate";
  if (a.includes("confirm")) return "confirm";
  if (a.includes("metrics")) return "metrics.get";
  return String(action || "");
}

// (moved to SolanaDriver)

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
  for (const a of [jupiterAdapter, meteoraDlmmAdapter, solendAdapter]) {
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

  // executed (idempotency): preparedId -> { signature, ts }
  const executedPath = join(w3rtDir, "executed.json");
  const executed = new Map<string, { signature: string; ts: number }>();
  try {
    const raw = readFileSync(executedPath, "utf-8");
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      for (const [k, v] of Object.entries(j)) {
        const sig = (v as any)?.signature;
        const ts = (v as any)?.ts;
        if (typeof sig === "string") executed.set(String(k), { signature: sig, ts: typeof ts === "number" ? ts : 0 });
      }
    }
  } catch {
    // ignore if missing/corrupt
  }

  function persistExecuted() {
    try {
      const obj: Record<string, any> = {};
      for (const [k, v] of executed.entries()) obj[k] = v;
      writeFileSync(executedPath, JSON.stringify(obj, null, 2));
    } catch {
      // best-effort
    }
  }

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

      // Solana: balance (single-user convenience). If no address is provided, use default local keypair.
      // POST /v1/solana/balance
      if (req.method === "POST" && url.pathname === "/v1/solana/balance") {
        const body = await readJsonBody(req);
        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);

        let address = String(body?.address ?? body?.owner ?? "").trim();
        if (!address) {
          const kp = loadSolanaKeypair();
          if (!kp) {
            return sendJson(res, 400, {
              ok: false,
              error: "MISSING_ADDRESS",
              message: "No address provided and no local Solana keypair configured",
              hint: "Provide {address} or set W3RT_SOLANA_PRIVATE_KEY / W3RT_SOLANA_KEYPAIR_PATH (or Solana CLI keypair path).",
            });
          }
          address = kp.publicKey.toBase58();
        }

        let pubkey: PublicKey;
        try {
          pubkey = new PublicKey(address);
        } catch {
          return sendJson(res, 400, { ok: false, error: "INVALID_ADDRESS", address });
        }

        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const lamports = await conn.getBalance(pubkey);
        const sol = lamports / 1_000_000_000;

        return sendJson(res, 200, {
          ok: true,
          chain: "solana",
          network,
          rpcUrl,
          address: pubkey.toBase58(),
          lamports,
          sol,
        });
      }

      // Solana: transfer prepare (build unsigned tx + simulate + policy + returns preparedId). Does NOT broadcast.
      // POST /v1/solana/transfer/prepare
      if (req.method === "POST" && url.pathname === "/v1/solana/transfer/prepare") {
        const body = await readJsonBody(req);

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);

        const toRaw = String(body?.to ?? "").trim();
        if (!toRaw) return sendJson(res, 400, { ok: false, error: "MISSING_TO" });

        let to: PublicKey;
        try {
          to = new PublicKey(toRaw);
        } catch {
          return sendJson(res, 400, { ok: false, error: "INVALID_TO", to: toRaw });
        }

        const amountUi = Number(body?.amount);
        if (!Number.isFinite(amountUi) || amountUi <= 0) {
          return sendJson(res, 400, { ok: false, error: "INVALID_AMOUNT", amount: body?.amount });
        }

        const tokenMintRaw = body?.tokenMint ? String(body.tokenMint).trim() : "";
        const createAta = body?.createAta !== false;

        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });

        const instructions: TransactionInstruction[] = [];
        const summary: any = { from: kp.publicKey.toBase58(), to: to.toBase58() };

        if (!tokenMintRaw) {
          // SOL transfer
          const lamports = Math.round(amountUi * 1_000_000_000);
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: to,
              lamports,
            })
          );
          summary.kind = "sol_transfer";
          summary.amountUi = amountUi;
          summary.lamports = lamports;
        } else {
          // SPL transfer
          let tokenMint: PublicKey;
          try {
            tokenMint = new PublicKey(tokenMintRaw);
          } catch {
            return sendJson(res, 400, { ok: false, error: "INVALID_TOKEN_MINT", tokenMint: tokenMintRaw });
          }

          const mintAcc = await conn.getParsedAccountInfo(tokenMint, "confirmed");
          const decimals = (mintAcc.value?.data as any)?.parsed?.info?.decimals;
          if (typeof decimals !== "number") {
            return sendJson(res, 400, { ok: false, error: "TOKEN_DECIMALS_NOT_FOUND", tokenMint: tokenMint.toBase58() });
          }

          const amountBase = BigInt(Math.round(amountUi * Math.pow(10, decimals)));
          const fromAta = getAssociatedTokenAddressSync(tokenMint, kp.publicKey);
          const toAta = getAssociatedTokenAddressSync(tokenMint, to);

          let willCreateAta = false;
          if (createAta) {
            const info = await conn.getAccountInfo(toAta, "confirmed");
            if (!info) {
              willCreateAta = true;
              instructions.push(
                createAssociatedTokenAccountIx({
                  payer: kp.publicKey,
                  ata: toAta,
                  owner: to,
                  mint: tokenMint,
                })
              );
            }
          }

          instructions.push(createSplTransferIx({ source: fromAta, dest: toAta, owner: kp.publicKey, amount: amountBase }));

          summary.kind = "spl_transfer";
          summary.amountUi = amountUi;
          summary.amountBase = amountBase.toString();
          summary.decimals = decimals;
          summary.tokenMint = tokenMint.toBase58();
          summary.fromAta = fromAta.toBase58();
          summary.toAta = toAta.toBase58();
          summary.willCreateAta = willCreateAta;
        }

        const latest = await conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({
          payerKey: kp.publicKey,
          recentBlockhash: latest.blockhash,
          instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        const txB64 = Buffer.from(tx.serialize()).toString("base64");

        const drivers = makeDriverRegistry(rpcUrl);
        const driver = drivers.solana;
        const simulation = await driver.simulateTxB64(txB64, { rpcUrl });
        const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              // Policy allowlist expects generic verbs like "transfer".
              action: "transfer",
              // This endpoint is prepare-only (no broadcast).
              sideEffect: "none",
              simulationOk: simulation.ok,
              programIdsKnown: known,
              programIds,
            } as any)
          : { decision: simulation.ok ? "confirm" : "block" };

        const requiresApproval = decision.decision === "confirm";
        const allowed = decision.decision === "allow" || decision.decision === "confirm";

        const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
        const now = Date.now();

        const traceId = `trace_${crypto.randomUUID().slice(0, 16)}`;
        const trace = new TraceStore(w3rtDir);
        trace.emit({ ts: now, type: "tx.built", runId: traceId, data: { summary } });
        trace.emit({ ts: now, type: "tx.simulated", runId: traceId, data: { ok: simulation.ok, err: simulation.err, unitsConsumed: simulation.unitsConsumed } });
        trace.emit({ ts: now, type: "policy.decision", runId: traceId, data: { decision } });

        const artifact = {
          chain: "solana",
          adapter: "internal",
          // Keep policy action compatible with allowlist: "transfer"
          action: "transfer",
          params: { to: to.toBase58(), amount: amountUi, tokenMint: tokenMintRaw || null, createAta },
          txB64,
          simulation,
          programIds,
          policy: { decision: decision.decision },
          traceId,
          preparedId,
          summary,
        };
        const hash = computeArtifactHash(artifact);

        prepared.set(preparedId, {
          preparedId,
          createdAt: now,
          expiresAt: now + ttlMs,
          traceId,
          chain: "solana",
          adapter: "internal",
          action: "transfer",
          params: artifact.params,
          txB64,
          recentBlockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          simulation,
          programIds,
          programIdsKnown: known,
          network,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifactCanonicalJson: hash.canonicalJson,
        });

        return sendJson(res, 200, {
          ok: true,
          preparedId,
          allowed,
          requiresApproval,
          network,
          rpcUrl,
          from: kp.publicKey.toBase58(),
          summary,
          simulation,
          programIds,
          programIdsKnown: known,
          policyReport: decision,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
        });
      }

      // Solana: transfer execute (broadcast) by preparedId.
      // POST /v1/solana/transfer/execute
      if (req.method === "POST" && url.pathname === "/v1/solana/transfer/execute") {
        const body = await readJsonBody(req);
        const preparedId = String(body.preparedId || "");
        const confirm = body.confirm === true;
        const waitForConfirmation = body.waitForConfirmation === true;
        const commitment = (body.commitment ? String(body.commitment) : "confirmed") as Commitment;
        const timeoutMs = body.timeoutMs != null ? Number(body.timeoutMs) : 60_000;

        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });
        if (!confirm) return sendJson(res, 400, { ok: false, error: "CONFIRM_REQUIRED" });

        // idempotency: if already executed, return stored signature
        const prior = executed.get(preparedId);
        if (prior) {
          return sendJson(res, 200, { ok: true, signature: prior.signature, idempotent: true });
        }

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
        const conn = new Connection(rpcUrl, { commitment });

        const traceId = item.traceId;
        const trace = new TraceStore(defaultW3rtDir());

        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: normalizePolicyAction(String(item.action)),
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

        const raw = Buffer.from(item.txB64, "base64");
        const tx = VersionedTransaction.deserialize(raw);
        const extra = Array.isArray(item.extraSigners) ? item.extraSigners : [];
        const extraKps = extra.map((sk) => Keypair.fromSecretKey(sk));
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        trace.emit({ ts: Date.now(), type: "tx.submitted", runId: traceId, data: { signature: sig } });

        executed.set(preparedId, { signature: sig, ts: Date.now() });
        persistExecuted();

        if (waitForConfirmation) {
          const blockhash = item.recentBlockhash ?? (tx.message as any).recentBlockhash;
          const lastValidBlockHeight = item.lastValidBlockHeight;
          if (typeof blockhash === "string" && typeof lastValidBlockHeight === "number") {
            const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error("CONFIRM_TIMEOUT")), Math.max(1, timeoutMs)));
            try {
              const conf: any = await Promise.race([
                conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, commitment),
                timeout,
              ]);
              trace.emit({ ts: Date.now(), type: "tx.confirmed", runId: traceId, data: { signature: sig, value: conf.value } });
              prepared.delete(preparedId);
              return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision, confirmation: conf.value });
            } catch (e: any) {
              prepared.delete(preparedId);
              return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision, confirmation: { err: "CONFIRM_TIMEOUT_OR_ERROR", message: String(e?.message ?? e) } });
            }
          }
        }

        prepared.delete(preparedId);
        return sendJson(res, 200, { ok: true, signature: sig, traceId, policyReport: decision });
      }

      // List all available actions (capabilities) across registered adapters.
      if (req.method === "GET" && url.pathname === "/v1/actions") {
        const adapters = defaultRegistry.list().map((a) => {
          const caps = a.capabilities?.() ?? [];
          return {
            id: a.id,
            chain: a.chain,
            capabilities: caps,
          };
        });

        const actions = adapters.flatMap((a) =>
          (a.capabilities ?? []).map((c: any) => ({
            adapter: a.id,
            chain: a.chain,
            ...c,
          }))
        );

        return sendJson(res, 200, { ok: true, adapters, actions });
      }

      // MVP: Stable-yield opportunity discovery (mock providers for now)
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/discover") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC

        const opportunities = [
          {
            id: "solana:lending:mock-a",
            chain: "solana",
            stableMint,
            name: "Lending (mock) — flexible USDC supply",
            provider: "mock",
            apy: 0.06,
            tvlUsd: 50_000_000,
            exit: { kind: "instant" },
            risk: "low",
            notes: "MVP placeholder. Replace with a real lending integration (e.g. Solend).",
            requiredActions: [
              {
                adapter: "solend",
                action: "solana.solend.deposit_usdc",
                params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
              },
            ],
          },
          {
            id: "solana:vault:mock-b",
            chain: "solana",
            stableMint,
            name: "Vault (mock) — auto-compound USDC",
            provider: "mock",
            apy: 0.075,
            tvlUsd: 12_000_000,
            exit: { kind: "instant" },
            risk: "medium",
            notes: "MVP placeholder. Replace with a real vault integration.",
            requiredActions: [
              {
                adapter: "solend",
                action: "solana.solend.deposit_usdc",
                params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
              },
            ],
          },
        ];

        // Basic ranking: higher APY first, then TVL
        opportunities.sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd);

        return sendJson(res, 200, { ok: true, opportunities });
      }

      // MVP: Plan a stable-yield strategy from discovery results.
      // Returns an execution plan (action intents) that can later be compiled into workflow/transactions.
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/plan") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const riskPreference = String(body.risk ?? "low"); // low|medium
        const mode = String(body.mode ?? "deposit"); // deposit|migrate

        // Reuse the discovery logic (mock) for now.
        const disc = await (async () => {
          const opportunities = [
            {
              id: "solana:lending:mock-a",
              chain: "solana",
              stableMint,
              name: "Lending (mock) — flexible USDC supply",
              provider: "mock",
              apy: 0.06,
              tvlUsd: 50_000_000,
              exit: { kind: "instant" },
              risk: "low",
              notes: "MVP placeholder. Replace with a real lending integration (e.g. Solend).",
              requiredActions: [
                {
                  adapter: "solend",
                  action: "solana.solend.deposit_usdc",
                  params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
                },
              ],
            },
            {
              id: "solana:vault:mock-b",
              chain: "solana",
              stableMint,
              name: "Vault (mock) — auto-compound USDC",
              provider: "mock",
              apy: 0.075,
              tvlUsd: 12_000_000,
              exit: { kind: "instant" },
              risk: "medium",
              notes: "MVP placeholder. Replace with a real vault integration.",
              requiredActions: [
                {
                  adapter: "solend",
                  action: "solana.solend.deposit_usdc",
                  params: { amountBase: String(Math.max(0, Math.floor(amountUsd * 1_000_000))) },
                },
              ],
            },
          ];
          opportunities.sort((a, b) => b.apy - a.apy || b.tvlUsd - a.tvlUsd);
          return opportunities;
        })();

        // Filter by risk preference (simple): low only allows low-risk opps.
        const candidates = riskPreference === "low" ? disc.filter((o: any) => o.risk === "low") : disc;
        const chosen = candidates[0] ?? disc[0];
        if (!chosen) return sendJson(res, 400, { ok: false, error: "NO_OPPORTUNITIES" });

        if (mode !== "deposit") {
          return sendJson(res, 400, {
            ok: false,
            error: "UNSUPPORTED_MODE",
            message: "MVP only supports mode=deposit for now",
          });
        }

        const planId = `plan_${crypto.randomUUID().slice(0, 16)}`;
        const plan = {
          id: planId,
          kind: "stable_yield",
          chain: "solana",
          mode: "deposit",
          input: { stableMint, amountUsd, riskPreference },
          chosenOpportunity: chosen,
          // Action intents (to be compiled). This is the "composability" layer.
          actions: chosen.requiredActions,
          explanation: `Pick ${chosen.name} with estimated APY ${(chosen.apy * 100).toFixed(2)}% and ${chosen.exit.kind} exit`,
        };

        return sendJson(res, 200, { ok: true, plan });
      }

      // Composable: stable-yield "prepare" should return an action plan (DAG), not a chain-specific tx.
      // Use /v1/plan/compile to compile plans into PreparedTx artifacts.
      if (req.method === "POST" && url.pathname === "/v1/strategies/stable-yield/prepare") {
        const body = await readJsonBody(req);
        const amountUsd = Number(body.amountUsd ?? 0);
        const stableMint = String(body.stableMint ?? "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
        const riskPreference = String(body.risk ?? "low");

        const planId = `plan_${crypto.randomUUID().slice(0, 16)}`;
        const amountBase = String(Math.max(0, Math.floor(amountUsd * 1_000_000))); // USDC base units

        // For now we only support USDC deposit via Solend as the real integration.
        // Future: add swap action when stableMint != USDC, multi-step DAG, multi-chain strategies.
        const plan = {
          id: planId,
          kind: "stable_yield",
          chain: "solana",
          mode: "deposit",
          input: { amountUsd, stableMint, riskPreference },
          actions: [
            {
              id: "deposit",
              dependsOn: [],
              chain: "solana",
              adapter: "solend",
              action: "solana.solend.deposit_usdc",
              params: { amountBase },
            },
          ],
        };

        return sendJson(res, 200, { ok: true, plan, next: { compile: "/v1/plan/compile" } });
      }

      // Compile a plan (list/DAG of action intents) into chain-specific prepared artifacts.
      // For now: sequential compile for Solana; future: DAG execution + multi-chain drivers.
      if (req.method === "POST" && url.pathname === "/v1/plan/compile") {
        const body = await readJsonBody(req);
        const actions = normalizeActions(body.actions ?? body.plan?.actions);

        if (!actions.length) return sendJson(res, 400, { ok: false, error: "MISSING_ACTIONS" });

        const { ordered, cycles } = topoOrderActions(actions);
        if (cycles.length) return sendJson(res, 400, { ok: false, error: "PLAN_CYCLE", cycles });

        const kp = loadSolanaKeypair();
        if (!kp) return sendJson(res, 400, { ok: false, error: "MISSING_SOLANA_KEYPAIR" });

        const rpcUrl = resolveSolanaRpc();
        const network = inferNetworkFromRpcUrl(rpcUrl);
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const drivers = makeDriverRegistry(rpcUrl);

        const traceId = crypto.randomUUID();
        const trace = new TraceStore(w3rtDir);
        trace.emit({ ts: Date.now(), type: "run.started", runId: traceId, data: { mode: "plan.compile", network, count: ordered.length } });

        const results: any[] = [];
        const resultById = new Map<string, any>();

        for (const [idx, a] of ordered.entries()) {
          const id = String(a.id);
          const adapter = String(a.adapter || "");
          const action = String(a.action || "");
          const params = (a.params ?? {}) as Dict;
          const chain = String(a.chain || "solana");

          // Dependency check: if any dep failed/blocked, skip compile.
          const deps = a.dependsOn ?? [];
          const depFailed = deps.some((d) => {
            const r = resultById.get(String(d));
            return r && (r.ok === false || r.allowed === false);
          });
          if (depFailed) {
            const r = { ok: false, id, error: "DEP_FAILED", dependsOn: deps };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          const driver = drivers[chain];
          if (!driver) {
            const r = { ok: false, id, error: "UNSUPPORTED_CHAIN", chain, adapter, action };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          // build tx
          let built: any;
          try {
            built = await defaultRegistry.get(adapter).buildTx(action, params, {
              userPublicKey: kp.publicKey.toBase58(),
              rpcUrl,
            });
          } catch (e: any) {
            const r = { ok: false, id, error: "UNKNOWN_ADAPTER", adapter, action, message: String(e?.message ?? e) };
            results.push(r);
            resultById.set(id, r);
            continue;
          }

          const txB64 = built.txB64;

          // simulate (chain driver)
          const simulation = await driver.simulateTxB64(txB64, { rpcUrl });

          const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

          const decision = policy
            ? policy.decide({
                chain: "solana",
                network,
                action: normalizePolicyAction(action),
                sideEffect: "none",
                simulationOk: simulation.ok,
                programIdsKnown: known,
                programIds,
              } as any)
            : { decision: "allow" };

          const requiresApproval = decision.decision === "confirm";
          const allowed = decision.decision === "allow" || decision.decision === "confirm";

          const preparedId = `prep_${crypto.randomUUID().slice(0, 16)}`;
          const now = Date.now();

          const artifact = {
            chain,
            adapter,
            action,
            params,
            txB64,
            simulation,
            programIds,
            policy: { decision: decision.decision },
            traceId,
            preparedId,
          };

          const hash = computeArtifactHash(artifact);

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
            simulation,
            programIds,
            programIdsKnown: known,
            network,
            artifactSchemaVersion: hash.schemaVersion,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
            artifactCanonicalJson: hash.canonicalJson,
          });

          const out = {
            ok: true,
            id,
            index: idx,
            dependsOn: deps,
            adapter,
            action,
            preparedId,
            allowed,
            requiresApproval,
            simulation,
            programIds,
            programIdsKnown: known,
            meta: built.meta ?? {},
            policyReport: decision,
            artifactSchemaVersion: hash.schemaVersion,
            hashAlg: hash.hashAlg,
            artifactHash: hash.artifactHash,
          };
          results.push(out);
          resultById.set(id, out);

          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: `compile_${id}`, data: { ok: true, id, adapter, action, simulationOk: simulation.ok, policy: decision } });
        }

        trace.emit({ ts: Date.now(), type: "run.finished", runId: traceId, data: { ok: true } });

        return sendJson(res, 200, { ok: true, traceId, order: ordered.map((a) => a.id), results });
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
        const conn = new Connection(rpcUrl, { commitment: "confirmed" as Commitment });
        const drivers = makeDriverRegistry(rpcUrl);
        const driver = drivers[chain];
        if (!driver) return sendJson(res, 400, { ok: false, error: "UNSUPPORTED_CHAIN" });

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

        // simulate (chain driver)
        const simulation = await driver.simulateTxB64(txB64, { rpcUrl });

        // program ids (best-effort)
        const { ids: programIds, known } = await driver.extractIdsFromTxB64(txB64, { rpcUrl });

        // policy
        const decision = policy
          ? policy.decide({
              chain: "solana",
              network,
              action: normalizePolicyAction(String((built as any)?.meta?.action ?? action)),
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

        const artifact = {
          chain,
          adapter,
          action: String((built as any)?.meta?.action ?? action),
          params,
          txB64,
          simulation,
          programIds,
          policy: { decision: decision.decision },
          traceId,
          preparedId,
        };
        const hash = computeArtifactHash(artifact);

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
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifactCanonicalJson: hash.canonicalJson,
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

        // Local AgentMemory payload (best-effort). For now, we use artifactHash as the reasoning_hash placeholder.
        try {
          writeMemoryRecord(w3rtDir, {
            run_id: traceId,
            reasoning_hash: hash.artifactHash,
            artifacts_hash: hash.artifactHash,
            policy_decision: String(decision.decision ?? "allow"),
            outcome: decision.decision === "block" ? "fail" : "success",
            ts: new Date().toISOString(),
          });
        } catch {
          // best-effort
        }

        return sendJson(res, 200, {
          ok: true,
          allowed,
          requiresApproval,
          preparedId,
          txB64,
          traceId,
          policyReport: decision,
          simulation,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
        });
      }

      // Fetch a prepared artifact for verification (hash checking / escrow / attestations).
      if (req.method === "GET" && url.pathname.startsWith("/v1/artifacts/")) {
        const preparedId = decodeURIComponent(url.pathname.split("/").pop() || "");
        if (!preparedId) return sendJson(res, 400, { ok: false, error: "MISSING_PREPARED_ID" });

        const item = prepared.get(preparedId);
        if (!item) return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        if (item.expiresAt <= Date.now()) {
          prepared.delete(preparedId);
          return sendJson(res, 404, { ok: false, error: "PREPARED_NOT_FOUND_OR_EXPIRED" });
        }

        // Never include secrets (extra signers) here.
        const artifact = {
          chain: item.chain,
          adapter: item.adapter,
          action: item.action,
          params: item.params,
          txB64: item.txB64,
          simulation: item.simulation,
          programIds: item.programIds ?? [],
          traceId: item.traceId,
          preparedId: item.preparedId,
          createdAt: item.createdAt,
          expiresAt: item.expiresAt,
        };

        // Recompute hash from canonical artifact object.
        const canonObj = canonicalizeObject(artifact);
        const hash = computeArtifactHash(canonObj);

        return sendJson(res, 200, {
          ok: true,
          artifactSchemaVersion: hash.schemaVersion,
          hashAlg: hash.hashAlg,
          artifactHash: hash.artifactHash,
          artifact: canonObj,
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
              action: normalizePolicyAction(String(item.action)),
              sideEffect: "broadcast",
              simulationOk: item.simulation?.ok === true,
              programIds: item.programIds ?? [],
              programIdsKnown: item.programIdsKnown === true,
            } as any)
          : { decision: "allow" };

        if (decision.decision === "block") {
          trace.emit({ ts: Date.now(), type: "step.finished", runId: traceId, stepId: "execute", data: { ok: false, policy: decision } });

          // Local AgentMemory payload (best-effort)
          try {
            writeMemoryRecord(defaultW3rtDir(), {
              run_id: traceId,
              reasoning_hash: String(item.artifactHash ?? ""),
              artifacts_hash: String(item.artifactHash ?? ""),
              policy_decision: String(decision.decision ?? "block"),
              outcome: "fail",
              ts: new Date().toISOString(),
            });
          } catch {
            // best-effort
          }

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

        // Local AgentMemory payload (best-effort)
        try {
          writeMemoryRecord(defaultW3rtDir(), {
            run_id: traceId,
            reasoning_hash: String(item.artifactHash ?? ""),
            artifacts_hash: String(item.artifactHash ?? ""),
            policy_decision: String(decision.decision ?? "allow"),
            outcome: "success",
            ts: new Date().toISOString(),
          });
        } catch {
          // best-effort
        }

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

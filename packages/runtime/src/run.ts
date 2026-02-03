import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import yaml from "js-yaml";

import type { Workflow, WorkflowStage, WorkflowAction } from "@w3rt/workflow";
import { TraceStore } from "@w3rt/trace";
import { PolicyEngine, type PolicyConfig } from "@w3rt/policy";

import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  clusterApiUrl,
  type Commitment,
} from "@solana/web3.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");

function u64LE(value: bigint): Buffer {
  const b = Buffer.alloc(8);
  let v = value;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return b;
}

function getAssociatedTokenAddressSync(mint: PublicKey, owner: PublicKey): PublicKey {
  const [ata] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return ata;
}

function createAssociatedTokenAccountIx(params: {
  payer: PublicKey;
  ata: PublicKey;
  owner: PublicKey;
  mint: PublicKey;
}) {
  // Data is empty for CreateAssociatedTokenAccount
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: params.payer, isSigner: true, isWritable: true },
      { pubkey: params.ata, isSigner: false, isWritable: true },
      { pubkey: params.owner, isSigner: false, isWritable: false },
      { pubkey: params.mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    ],
    data: Buffer.alloc(0),
  });
}

function createSplTransferIx(params: {
  source: PublicKey;
  dest: PublicKey;
  owner: PublicKey;
  amount: bigint;
}) {
  // SPL Token Transfer instruction: tag=3, amount u64
  const data = Buffer.concat([Buffer.from([3]), u64LE(params.amount)]);
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

export interface RunOptions {
  w3rtDir?: string;
  approve?: (prompt: string) => Promise<boolean>;
}

type Dict = Record<string, any>;

type SolanaCluster = "mainnet-beta" | "testnet" | "devnet";

function getSolanaCluster(): SolanaCluster {
  return (process.env.W3RT_SOLANA_CLUSTER as SolanaCluster) || "devnet";
}

function getJupiterBaseUrl(): string {
  // New Jupiter endpoints are under https://api.jup.ag
  return process.env.W3RT_JUPITER_BASE_URL || "https://api.jup.ag";
}

function getJupiterApiKey(): string | undefined {
  return process.env.W3RT_JUPITER_API_KEY;
}

function solanaRpcUrl(cluster: SolanaCluster) {
  return process.env.W3RT_SOLANA_RPC_URL || clusterApiUrl(cluster);
}

function loadSolanaCliConfig(): { rpcUrl?: string; keypairPath?: string } {
  try {
    const p = join(os.homedir(), ".config", "solana", "cli", "config.yml");
    const cfg = loadYamlFile<any>(p);
    return { rpcUrl: cfg?.json_rpc_url, keypairPath: cfg?.keypair_path };
  } catch {
    return {};
  }
}

function loadSolanaKeypair(): Keypair | null {
  // Priority:
  // 1) W3RT_SOLANA_PRIVATE_KEY (JSON array)
  // 2) W3RT_SOLANA_KEYPAIR_PATH (file)
  // 3) Solana CLI config.yml -> keypair_path

  const raw = process.env.W3RT_SOLANA_PRIVATE_KEY;
  if (raw) {
    try {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      // fall through
    }
  }

  const kpPath = process.env.W3RT_SOLANA_KEYPAIR_PATH || loadSolanaCliConfig().keypairPath;
  if (kpPath) {
    try {
      const arr = JSON.parse(readFileSync(kpPath, "utf-8"));
      if (Array.isArray(arr)) return Keypair.fromSecretKey(Uint8Array.from(arr));
    } catch {
      // fall through
    }
  }

  return null;
}

function resolveSolanaRpc(): string {
  if (process.env.W3RT_SOLANA_RPC_URL) return process.env.W3RT_SOLANA_RPC_URL;

  // If user has Solana CLI configured, respect it.
  const cli = loadSolanaCliConfig();
  if (cli.rpcUrl) return cli.rpcUrl;

  return solanaRpcUrl(getSolanaCluster());
}

function inferNetworkFromRpcUrl(rpcUrl: string): "mainnet" | "testnet" {
  const u = rpcUrl.toLowerCase();
  if (u.includes("mainnet")) return "mainnet";
  return "testnet";
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

type BroadcastHistoryState = {
  timestampsMs: number[];
};

function loadBroadcastHistory(statePath: string): BroadcastHistoryState {
  try {
    const raw = readFileSync(statePath, "utf-8");
    const j = JSON.parse(raw);
    const ts = Array.isArray(j?.timestampsMs) ? j.timestampsMs.filter((n: any) => Number.isFinite(n)) : [];
    return { timestampsMs: ts };
  } catch {
    return { timestampsMs: [] };
  }
}

function saveBroadcastHistory(statePath: string, st: BroadcastHistoryState) {
  const pruned = st.timestampsMs.filter((n) => Number.isFinite(n)).slice(-1000);
  // best-effort
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify({ timestampsMs: pruned }, null, 2));
  } catch {
    // ignore
  }
}

async function fetchJsonWithRetry(url: URL | string, opts: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
}): Promise<any> {
  const {
    method = "GET",
    headers,
    body,
    timeoutMs = 10_000,
    retries = 2,
    retryDelayMs = 400,
  } = opts;

  let lastErr: any;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      if (res.status >= 500 && res.status < 600) {
        throw new Error(`HTTP ${res.status}: ${await res.text()}`);
      }
      if (!res.ok) {
        // 4xx should not retry
        const t = await res.text();
        throw Object.assign(new Error(`HTTP ${res.status}: ${t}`), { noRetry: true });
      }
      return await res.json();
    } catch (e: any) {
      lastErr = e;
      const noRetry = e?.noRetry === true;
      const aborted = e?.name === "AbortError";
      clearTimeout(timer);

      if (attempt >= retries || noRetry) throw e;

      // exponential-ish backoff
      const wait = retryDelayMs * Math.pow(2, attempt) + (aborted ? 200 : 0);
      await sleep(wait);
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function extractSolanaProgramIdsFromTxB64(txB64: string, rpcUrl: string): Promise<string[]> {
  const raw = Buffer.from(txB64, "base64");
  const tx = VersionedTransaction.deserialize(raw);

  const conn = new Connection(rpcUrl, { commitment: "processed" as Commitment });

  // Resolve address lookup tables (ALT) so we can map programIdIndex correctly.
  const lookups = tx.message.addressTableLookups ?? [];
  const altAccounts: AddressLookupTableAccount[] = [];

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

  return [...programIds];
}

function defaultW3rtDir() {
  return join(os.homedir(), ".w3rt");
}

function loadYamlFile<T>(path: string): T {
  const raw = readFileSync(path, "utf-8");
  return yaml.load(raw) as T;
}

function getByPath(obj: any, path: string): any {
  const parts = path.split(".").filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p];
  }
  return cur;
}

function renderTemplate(value: any, ctx: Dict): any {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+)\s*\}\}/g, (_, expr) => {
      const v = getByPath(ctx, String(expr).trim());
      return v == null ? "" : String(v);
    });
  }
  if (Array.isArray(value)) return value.map((v) => renderTemplate(v, ctx));
  if (value && typeof value === "object") {
    const out: Dict = {};
    for (const [k, v] of Object.entries(value)) out[k] = renderTemplate(v, ctx);
    return out;
  }
  return value;
}

// MVP: tiny expression evaluator supporting:
// - path op number/bool
// - op in: >, >=, <, <=, ==
function evalWhen(expr: string, ctx: Dict): boolean {
  const m = expr.trim().match(/^([a-zA-Z0-9_\.]+)\s*(==|>=|<=|>|<)\s*(.+)$/);
  if (!m) return false;
  const [, leftPath, op, rightRaw] = m;
  const left = getByPath(ctx, leftPath);

  let right: any = rightRaw.trim();
  if (right === "true") right = true;
  else if (right === "false") right = false;
  else if (!Number.isNaN(Number(right))) right = Number(right);
  else right = right.replace(/^['\"]|['\"]$/g, "");

  switch (op) {
    case "==":
      return left === right;
    case ">":
      return Number(left) > Number(right);
    case ">=":
      return Number(left) >= Number(right);
    case "<":
      return Number(left) < Number(right);
    case "<=":
      return Number(left) <= Number(right);
    default:
      return false;
  }
}

interface Tool {
  name: string;
  meta: { action: string; sideEffect: "none" | "broadcast"; chain?: string; risk?: "low" | "high" };
  execute: (params: Dict, ctx: Dict) => Promise<any>;
}

function createMockTools(): Tool[] {
  return [
    // ----- generic mock tools (used by mock-arb.yaml)
    {
      name: "price_check",
      meta: { action: "price_check", sideEffect: "none", risk: "low" },
      async execute(params) {
        const tokens = params.tokens ?? [];
        const chains = params.chains ?? [];
        return {
          tokens,
          chains,
          prices: {
            SUI: 1.2,
            USDC: 1.0,
          },
        };
      },
    },
    {
      name: "calculate_opportunity",
      meta: { action: "calc_opportunity", sideEffect: "none", risk: "low" },
      async execute(params) {
        const minProfit = Number(params.minProfit ?? 0);
        // mocked opportunity
        return {
          ok: true,
          profit: Math.max(minProfit + 5, 15),
          sourceChain: "sui",
          targetChain: "bnb",
          sourceToken: "SUI",
          targetToken: "USDC",
          amount: "100",
        };
      },
    },
    {
      name: "simulate_swap",
      meta: { action: "swap", sideEffect: "none", risk: "low" },
      async execute(params) {
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd: 60,
        };
      },
    },
    {
      name: "swap",
      meta: { action: "swap", sideEffect: "broadcast", risk: "high" },
      async execute(params, ctx) {
        const profitUsd = Number(ctx?.simulation?.profitUsd ?? 0);
        return {
          ok: true,
          chain: params.chain,
          from: params.from,
          to: params.to,
          amount: params.amount,
          profitUsd,
          txHash: "mock_tx_" + crypto.randomBytes(4).toString("hex"),
        };
      },
    },
    {
      name: "verify_balance",
      meta: { action: "verify_balance", sideEffect: "none", risk: "low" },
      async execute() {
        return { ok: true };
      },
    },
    {
      name: "notify",
      meta: { action: "notify", sideEffect: "none", risk: "low" },
      async execute(params) {
        return { ok: true, message: params.message };
      },
    },

    // ----- solana tools
    {
      name: "solana_balance",
      meta: { action: "balance", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const address = params.address
          ? new PublicKey(String(params.address))
          : (loadSolanaKeypair()?.publicKey ?? null);

        if (!address) {
          throw new Error(
            "Missing Solana address. Provide params.address or configure Solana CLI keypair."
          );
        }

        const lamports = await conn.getBalance(address, "confirmed");
        const sol = lamports / 1_000_000_000;

        const out: any = {
          ok: true,
          address: address.toBase58(),
          sol: { lamports, sol },
        };

        const includeTokens = params.includeTokens === true;
        const tokenMint = params.tokenMint ? String(params.tokenMint) : undefined;
        if (includeTokens) {
          const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
          if (tokenMint) {
            const mint = new PublicKey(tokenMint);
            const res = await conn.getParsedTokenAccountsByOwner(address, { mint });
            out.tokens = res.value.map((v) => ({
              pubkey: v.pubkey.toBase58(),
              mint: v.account.data.parsed.info.mint,
              amount: v.account.data.parsed.info.tokenAmount.amount,
              decimals: v.account.data.parsed.info.tokenAmount.decimals,
              uiAmount: v.account.data.parsed.info.tokenAmount.uiAmount,
            }));
          } else {
            const res = await conn.getParsedTokenAccountsByOwner(address, { programId: tokenProgram });
            out.tokens = res.value.map((v) => ({
              pubkey: v.pubkey.toBase58(),
              mint: v.account.data.parsed.info.mint,
              amount: v.account.data.parsed.info.tokenAmount.amount,
              decimals: v.account.data.parsed.info.tokenAmount.decimals,
              uiAmount: v.account.data.parsed.info.tokenAmount.uiAmount,
            }));
          }
        }

        return out;
      },
    },
    {
      name: "solana_token_accounts",
      meta: { action: "token_accounts", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const owner = params.address
          ? new PublicKey(String(params.address))
          : (loadSolanaKeypair()?.publicKey ?? null);

        if (!owner) {
          throw new Error(
            "Missing Solana address. Provide params.address or configure Solana CLI keypair."
          );
        }

        const tokenMint = params.tokenMint ? String(params.tokenMint) : undefined;
        const includeZero = params.includeZero === true;

        const tokenProgram = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
        const res = tokenMint
          ? await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(tokenMint) })
          : await conn.getParsedTokenAccountsByOwner(owner, { programId: tokenProgram });

        let accounts = res.value.map((v) => {
          const info = v.account.data.parsed.info;
          const ta = info.tokenAmount;
          return {
            pubkey: v.pubkey.toBase58(),
            mint: info.mint,
            owner: info.owner,
            amount: ta.amount,
            decimals: ta.decimals,
            uiAmount: ta.uiAmount,
          };
        });

        if (!includeZero) {
          accounts = accounts.filter((a) => Number(a.amount) > 0);
        }

        return {
          ok: true,
          owner: owner.toBase58(),
          count: accounts.length,
          accounts,
        };
      },
    },
    {
      name: "solana_build_transfer_tx",
      meta: { action: "transfer", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const kp = loadSolanaKeypair();
        if (!kp) {
          throw new Error(
            "Missing Solana keypair. Configure Solana CLI (solana config set --keypair ...)"
          );
        }

        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const to = new PublicKey(String(params.to));
        const amountUi = Number(params.amount);
        if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error("Invalid amount");

        const tokenMint = params.tokenMint ? new PublicKey(String(params.tokenMint)) : null;
        const createAta = params.createAta !== false;

        const instructions = [] as any[];

        if (!tokenMint) {
          // SOL transfer
          const lamports = Math.round(amountUi * 1_000_000_000);
          instructions.push(
            SystemProgram.transfer({
              fromPubkey: kp.publicKey,
              toPubkey: to,
              lamports,
            })
          );
        } else {
          // SPL transfer
          // Fetch mint decimals via parsed account
          const mintAcc = await conn.getParsedAccountInfo(tokenMint, "confirmed");
          const decimals = (mintAcc.value?.data as any)?.parsed?.info?.decimals;
          if (typeof decimals !== "number") throw new Error("Unable to fetch token decimals");

          const amount = BigInt(Math.round(amountUi * Math.pow(10, decimals)));

          const fromAta = getAssociatedTokenAddressSync(tokenMint, kp.publicKey);
          const toAta = getAssociatedTokenAddressSync(tokenMint, to);

          if (createAta) {
            const info = await conn.getAccountInfo(toAta, "confirmed");
            if (!info) {
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

          instructions.push(createSplTransferIx({ source: fromAta, dest: toAta, owner: kp.publicKey, amount }));
        }

        const latest = await conn.getLatestBlockhash("confirmed");
        const msg = new TransactionMessage({
          payerKey: kp.publicKey,
          recentBlockhash: latest.blockhash,
          instructions,
        }).compileToV0Message();

        const tx = new VersionedTransaction(msg);
        const txB64 = Buffer.from(tx.serialize()).toString("base64");

        return {
          ok: true,
          txB64,
          summary: {
            kind: tokenMint ? "spl_transfer" : "sol_transfer",
            to: to.toBase58(),
            amount: amountUi,
            tokenMint: tokenMint ? tokenMint.toBase58() : "SOL",
          },
        };
      },
    },

  // ----- solana/jupiter tools (used by solana_swap_exact_in.yaml)
    {
      name: "solana_jupiter_quote",
      meta: { action: "quote", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        // Jupiter quote
        const base = getJupiterBaseUrl();
        const url = new URL("/swap/v1/quote", base);
        url.searchParams.set("inputMint", String(params.inputMint));
        url.searchParams.set("outputMint", String(params.outputMint));
        url.searchParams.set("amount", String(params.amount));
        const requestedSlippageBps = params.slippageBps != null ? Number(params.slippageBps) : undefined;
        if (requestedSlippageBps != null) url.searchParams.set("slippageBps", String(requestedSlippageBps));

        const apiKey = getJupiterApiKey();
        let quoteResponse: any;
        try {
          quoteResponse = await fetchJsonWithRetry(url, {
            headers: apiKey ? { "x-api-key": apiKey } : undefined,
            timeoutMs: 10_000,
            retries: 2,
          });
        } catch (e: any) {
          // preserve old error shape
          throw new Error(`Jupiter quote failed: ${e?.message ?? String(e)}`);
        }

        const quoteId = "q_" + crypto.randomBytes(6).toString("hex");
        ctx.__jupQuotes = ctx.__jupQuotes || {};
        ctx.__jupQuotes[quoteId] = quoteResponse;

        return { ok: true, quoteId, requestedSlippageBps, quoteResponse };
      },
    },
    {
      name: "solana_jupiter_build_tx",
      meta: { action: "build_tx", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const kp = loadSolanaKeypair();
        if (!kp) {
          throw new Error(
            "Missing W3RT_SOLANA_PRIVATE_KEY (JSON array). Needed to build a swap tx via Jupiter v6 /swap"
          );
        }

        const quote = ctx.__jupQuotes?.[String(params.quoteId)];
        if (!quote) throw new Error(`Unknown quoteId: ${params.quoteId}`);

        const body = {
          quoteResponse: quote,
          userPublicKey: kp.publicKey.toBase58(),
          wrapAndUnwrapSol: true,
        };

        const base = getJupiterBaseUrl();
        const apiKey = getJupiterApiKey();

        let out: any;
        try {
          out = await fetchJsonWithRetry(new URL("/swap/v1/swap", base), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              ...(apiKey ? { "x-api-key": apiKey } : {}),
            },
            body: JSON.stringify(body),
            timeoutMs: 15_000,
            retries: 2,
          });
        } catch (e: any) {
          throw new Error(`Jupiter swap build failed: ${e?.message ?? String(e)}`);
        }

        const txB64 = out.swapTransaction;
        if (!txB64) throw new Error("Jupiter response missing swapTransaction");

        return { ok: true, quoteId: params.quoteId, txB64 };
      },
    },
    {
      name: "solana_simulate_tx",
      meta: { action: "simulate", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "processed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);

        // Optional: derive a simulated output amount for Jupiter swaps.
        // This lets policy compare quote.outAmount vs simulatedOutAmount.
        let simMeta: any = {};
        try {
          const quote = ctx.quote?.quoteResponse;
          const kp = loadSolanaKeypair();
          if (quote && kp) {
            const outputMint = new PublicKey(String(quote.outputMint));
            const owner = kp.publicKey;
            const outAta = getAssociatedTokenAddressSync(outputMint, owner);

            // Fetch pre-sim balance from chain (best-effort).
            let preAmount = 0n;
            try {
              const bal = await conn.getTokenAccountBalance(outAta, "processed");
              preAmount = BigInt(bal.value.amount);
            } catch {
              preAmount = 0n;
            }

            const sim = await conn.simulateTransaction(tx, {
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: "processed",
              accounts: {
                addresses: [outAta.toBase58()],
                encoding: "jsonParsed",
              },
            } as any);

            if (sim.value.err) {
              return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [] };
            }

            const postAcc = sim.value.accounts?.[0] as any;
            const postAmountStr = postAcc?.data?.parsed?.info?.tokenAmount?.amount;
            const postAmount = typeof postAmountStr === "string" ? BigInt(postAmountStr) : preAmount;
            const delta = postAmount - preAmount;

            simMeta = {
              outputMint: outputMint.toBase58(),
              outAta: outAta.toBase58(),
              preOutAmount: preAmount.toString(),
              postOutAmount: postAmount.toString(),
              simulatedOutAmount: delta > 0n ? delta.toString() : "0",
            };

            return {
              ok: true,
              unitsConsumed: sim.value.unitsConsumed ?? null,
              logs: sim.value.logs ?? [],
              ...simMeta,
            };
          }
        } catch {
          // fall through to plain simulation
        }

        const sim = await conn.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "processed",
        });

        if (sim.value.err) {
          return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [] };
        }

        return {
          ok: true,
          unitsConsumed: sim.value.unitsConsumed ?? null,
          logs: sim.value.logs ?? [],
          ...simMeta,
        };
      },
    },
    {
      name: "solana_send_tx",
      meta: { action: "swap", sideEffect: "broadcast", chain: "solana", risk: "high" },
      async execute(params) {
        const kp = loadSolanaKeypair();
        if (!kp) {
          throw new Error(
            "Missing Solana keypair. Set W3RT_SOLANA_PRIVATE_KEY, or W3RT_SOLANA_KEYPAIR_PATH, or configure Solana CLI (solana config set --keypair ...)"
          );
        }

        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);
        tx.sign([kp]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        return { ok: true, signature: sig };
      },
    },
    {
      name: "solana_confirm_tx",
      meta: { action: "confirm", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = resolveSolanaRpc();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const sig = String(params.signature);
        const latest = await conn.getLatestBlockhash("confirmed");
        const conf = await conn.confirmTransaction(
          {
            signature: sig,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        );

        if (conf.value.err) return { ok: false, signature: sig, err: conf.value.err };
        return { ok: true, signature: sig };
      },
    },
  ];
}

function toolMap(tools: Tool[]) {
  return new Map(tools.map((t) => [t.name, t] as const));
}

async function runStage(stage: WorkflowStage, tools: Map<string, Tool>, ctx: Dict, trace: TraceStore, runId: string) {
  if (stage.when) {
    const ok = evalWhen(stage.when, ctx);
    if (!ok) return;
  }

  const stepId = stage.name;
  trace.emit({ ts: Date.now(), type: "step.started", runId, stepId, data: { stageType: stage.type } });

  if (stage.type === "approval") {
    const required = stage.approval?.required ?? false;
    if (required) {
      const conditions = stage.approval?.conditions ?? [];
      const allOk = conditions.every((c: string) => evalWhen(c, ctx));
      if (!allOk) {
        trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId, data: { approved: false, reason: "conditions_failed" } });
        throw new Error(`Approval conditions failed for stage ${stage.name}`);
      }

      const approveFn = ctx.__approve as RunOptions["approve"] | undefined;
      const prompt = `Approve stage '${stage.name}'?`;
      const approved = approveFn ? await approveFn(prompt) : false;
      trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId, data: { approved } });
      if (!approved) throw new Error("User rejected approval");
      return;
    }
  }

  for (const action of stage.actions) {
    await runAction(action, tools, ctx, trace, runId, stepId);
  }

  trace.emit({ ts: Date.now(), type: "step.finished", runId, stepId });
}

async function runAction(action: WorkflowAction, tools: Map<string, Tool>, ctx: Dict, trace: TraceStore, runId: string, stepId: string) {
  const t = tools.get(action.tool);
  if (!t) throw new Error(`Unknown tool: ${action.tool}`);

  const params = renderTemplate(action.params ?? {}, ctx);
  trace.emit({ ts: Date.now(), type: "tool.called", runId, stepId, tool: t.name, data: { params } });

  // Policy gate: only for side-effect tools in MVP
  if (t.meta.sideEffect === "broadcast") {
    const engine = ctx.__policy as PolicyEngine | undefined;
    if (engine) {
      // For now, infer network from Solana RPC if this is a Solana tool.
      const rpc = t.meta.chain === "solana" ? resolveSolanaRpc() : "";
      const network = t.meta.chain === "solana" ? inferNetworkFromRpcUrl(rpc) : "mainnet";

      // Rate limiting state (best-effort)
      const w3rtDir = String((ctx as any).__w3rtDir || defaultW3rtDir());
      const statePath = join(w3rtDir, "policy_broadcast_history.json");
      const hist = loadBroadcastHistory(statePath);
      const now = Date.now();
      const last = hist.timestampsMs.length ? hist.timestampsMs[hist.timestampsMs.length - 1] : undefined;
      const secondsSinceLastBroadcast = typeof last === "number" ? (now - last) / 1000 : undefined;
      const broadcastsLastMinute = hist.timestampsMs.filter((ts) => now - ts < 60_000).length;

      let programIds: string[] | undefined;
      let programIdsKnown: boolean | undefined;
      if (t.meta.chain === "solana" && typeof (params as any).txB64 === "string") {
        try {
          programIds = await extractSolanaProgramIdsFromTxB64((params as any).txB64, resolveSolanaRpc());
          programIdsKnown = true;
        } catch {
          programIdsKnown = false;
        }
      }

      // best-effort amount/slippage context
      const quoteResult = ctx.quote;
      const quote = quoteResult?.quoteResponse;

      // Known stablecoin mints (USDC/USDT) where ui amount == USD amount.
      const USD_MINTS_6 = new Set<string>();
      if (network === "mainnet") {
        USD_MINTS_6.add("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"); // USDC
        USD_MINTS_6.add("Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"); // USDT
      } else {
        // devnet USDC (commonly used)
        USD_MINTS_6.add("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
      }

      // Prefer the user-requested slippage (deterministic) over any quote field shape.
      const slippageBps = typeof quoteResult?.requestedSlippageBps === "number"
        ? quoteResult.requestedSlippageBps
        : undefined;

      // Deterministic SOL size (no USD conversion)
      const WSOL_MINT = "So11111111111111111111111111111111111111112";
      const inMint = quote?.inputMint;
      const inAmount = quote?.inAmount;
      let amountSol: number | undefined;
      let amountLamports: number | undefined;
      if (typeof inMint === "string" && inMint === WSOL_MINT && typeof inAmount === "string") {
        const lamports = Number(inAmount);
        if (Number.isFinite(lamports)) {
          amountLamports = lamports;
          amountSol = lamports / 1_000_000_000;
        }
      }

      // Prefer swap quote inAmount for stablecoins (deterministic USD value).
      let amountUsd: number | undefined;
      if (typeof inMint === "string" && USD_MINTS_6.has(inMint) && typeof inAmount === "string") {
        const n = Number(inAmount);
        if (Number.isFinite(n)) amountUsd = n / 1_000_000;
      }

      // If this is a transfer built by our tool, use its summary.
      const builtSummary = ctx.built?.summary;
      if (builtSummary && builtSummary.kind === "sol_transfer") {
        const amtUi = Number(builtSummary.amount);
        if (Number.isFinite(amtUi)) {
          amountSol = amtUi;
          amountLamports = Math.round(amtUi * 1_000_000_000);
        }
      }
      if (amountUsd == null && builtSummary && builtSummary.kind === "spl_transfer") {
        const mint = String(builtSummary.tokenMint);
        const amtUi = Number(builtSummary.amount);
        if (USD_MINTS_6.has(mint) && Number.isFinite(amtUi)) amountUsd = amtUi;
      }

      // Simulation-derived implied slippage (best-effort): compare quote.outAmount vs simulatedOutAmount.
      let simulatedSlippageBps: number | undefined;
      try {
        const expOut = Number(quote?.outAmount);
        const simOut = Number(ctx.simulation?.simulatedOutAmount);
        if (Number.isFinite(expOut) && expOut > 0 && Number.isFinite(simOut) && simOut >= 0) {
          const slip = (expOut - simOut) / expOut;
          if (Number.isFinite(slip)) simulatedSlippageBps = Math.max(0, Math.round(slip * 10_000));
        }
      } catch {
        // ignore
      }

      const decision = engine.decide({
        chain: t.meta.chain ?? "unknown",
        network,
        action: t.meta.action,
        sideEffect: t.meta.sideEffect,
        simulationOk: ctx.simulation?.ok === true,
        programIds,
        programIdsKnown,
        amountUsd,
        slippageBps: typeof slippageBps === "number" ? slippageBps : undefined,
        simulatedSlippageBps,
        secondsSinceLastBroadcast,
        broadcastsLastMinute,
        amountSol,
        amountLamports,
      });

      trace.emit({
        ts: Date.now(),
        type: "policy.decision",
        runId,
        stepId,
        tool: t.name,
        data: { ...(decision as any), ...(programIds ? { programIds } : {}) },
      });

      if (decision.decision === "block") throw new Error(`Policy blocked: ${decision.code}`);
      if (decision.decision === "confirm") {
        const approveFn = ctx.__approve as RunOptions["approve"] | undefined;
        const ok = approveFn ? await approveFn(`Policy confirm: ${decision.message}`) : false;
        if (!ok) throw new Error("Policy confirm rejected");
      }

      // stash for after-send bookkeeping
      (ctx as any).__broadcastHistory = { statePath, hist };
    }
  }

  try {
    const result = await t.execute(params, ctx);

    // Persist large artifacts for audit/replay (MVP)
    const artifactRefs = [] as any[];
    if (t.name === "solana_balance") {
      artifactRefs.push(trace.writeArtifact(runId, `balance_${stepId}`, result));
    }
    if (t.name === "solana_token_accounts") {
      artifactRefs.push(trace.writeArtifact(runId, `token_accounts_${stepId}`, result));
    }
    if (t.name === "solana_build_transfer_tx") {
      artifactRefs.push(trace.writeArtifact(runId, `built_${stepId}`, result));
    }
    if (t.name === "solana_jupiter_quote") {
      artifactRefs.push(trace.writeArtifact(runId, `quote_${stepId}`, result));
    }
    if (t.name === "solana_jupiter_build_tx") {
      // Save full Jupiter swap build response for audit/replay
      artifactRefs.push(trace.writeArtifact(runId, `built_${stepId}`, result));
    }
    if (t.name === "solana_simulate_tx") {
      artifactRefs.push(trace.writeArtifact(runId, `simulation_${stepId}`, result));
    }
    if (t.name === "solana_send_tx") {
      artifactRefs.push(trace.writeArtifact(runId, `submitted_${stepId}`, result));
    }
    if (t.name === "solana_confirm_tx") {
      artifactRefs.push(trace.writeArtifact(runId, `confirmed_${stepId}`, result));
    }

    trace.emit({ ts: Date.now(), type: "tool.result", runId, stepId, tool: t.name, data: { result }, artifactRefs: artifactRefs.length ? artifactRefs : undefined });

    // Policy bookkeeping: update broadcast history only after a successful broadcast tool runs.
    if (t.meta.sideEffect === "broadcast" && result?.ok !== false) {
      const bh = (ctx as any).__broadcastHistory as { statePath: string; hist: BroadcastHistoryState } | undefined;
      if (bh?.statePath && bh?.hist) {
        bh.hist.timestampsMs.push(Date.now());
        saveBroadcastHistory(bh.statePath, bh.hist);
      }
    }

    // Convention: store key results for templating
    if (t.name === "calculate_opportunity") ctx.opportunity = result;
    if (t.name === "simulate_swap") ctx.simulation = result;
    if (t.name === "swap") ctx.result = { ...(ctx.result ?? {}), ...(result ?? {}) };

    // Solana bindings
    if (t.name === "solana_balance") ctx.balance = result;
    if (t.name === "solana_token_accounts") ctx.tokenAccounts = result;
    if (t.name === "solana_build_transfer_tx") ctx.built = result;

    // Solana swap workflow bindings
    if (t.name === "solana_jupiter_quote") ctx.quote = result;
    if (t.name === "solana_jupiter_build_tx") ctx.built = result;
    if (t.name === "solana_simulate_tx") ctx.simulation = result;
    if (t.name === "solana_send_tx") ctx.submitted = result;
    if (t.name === "solana_confirm_tx") ctx.confirmed = result;

    return result;
  } catch (err: any) {
    trace.emit({ ts: Date.now(), type: "tool.error", runId, stepId, tool: t.name, data: { error: String(err?.message ?? err) } });
    throw err;
  }
}

export async function runWorkflowFromFile(workflowPath: string, opts: RunOptions = {}) {
  const wf = loadYamlFile<Workflow>(workflowPath);

  const w3rtDir = opts.w3rtDir ?? defaultW3rtDir();
  mkdirSync(w3rtDir, { recursive: true });

  const runId = crypto.randomUUID();
  const trace = new TraceStore(w3rtDir);

  // policy config (optional)
  let policy: PolicyEngine | undefined;
  try {
    const policyCfg = loadYamlFile<PolicyConfig>(join(process.cwd(), ".w3rt", "policy.yaml"));
    policy = new PolicyEngine(policyCfg);
  } catch {
    // ok for now
  }

  const ctx: Dict = {
    __approve: opts.approve,
    __policy: policy,
    __w3rtDir: w3rtDir,
  };

  // run metadata (helps debugging)
  const solana = (() => {
    try {
      const rpcUrl = resolveSolanaRpc();
      const network = inferNetworkFromRpcUrl(rpcUrl);
      const kp = loadSolanaKeypair();
      const pubkey = kp ? kp.publicKey.toBase58() : undefined;
      return { rpcUrl, network, pubkey };
    } catch {
      return {} as any;
    }
  })();

  trace.emit({
    ts: Date.now(),
    type: "run.started",
    runId,
    data: { workflow: wf.name, version: wf.version, solana },
  });

  const tools = toolMap(createMockTools());

  try {
    for (const stage of wf.stages) {
      await runStage(stage, tools, ctx, trace, runId);
    }
    trace.emit({ ts: Date.now(), type: "run.finished", runId, data: { ok: true } });
  } catch (err: any) {
    trace.emit({ ts: Date.now(), type: "run.finished", runId, data: { ok: false, error: String(err?.message ?? err) } });
    throw err;
  }

  // Build a user-friendly summary (best-effort)
  const networkHint = (() => {
    try {
      const rpc = resolveSolanaRpc();
      return inferNetworkFromRpcUrl(rpc);
    } catch {
      return "unknown";
    }
  })();

  const explorerBase = networkHint === "mainnet"
    ? "https://solscan.io/tx/"
    : "https://solscan.io/tx/"; // solscan auto-detects; keep simple for now

  const signature = ctx.submitted?.signature || ctx.confirmed?.signature;

  const summary = {
    workflow: wf.name,
    ok: true,
    chain: "solana",
    network: networkHint,
    signature,
    explorerUrl: signature ? `${explorerBase}${signature}` : undefined,
    quote: ctx.quote?.quoteResponse ? {
      inAmount: ctx.quote.quoteResponse?.inAmount,
      outAmount: ctx.quote.quoteResponse?.outAmount,
      inputMint: ctx.quote.quoteResponse?.inputMint,
      outputMint: ctx.quote.quoteResponse?.outputMint,
    } : undefined,
  };

  return { runId, ctx, summary };
}

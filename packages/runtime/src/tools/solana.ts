import crypto from "node:crypto";
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

import { defaultRegistry } from "@w3rt/adapters";
import type { Tool, Dict } from "./types.js";

const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSVAR_RENT_PUBKEY = new PublicKey("SysvarRent111111111111111111111111111111111");
const WSOL_MINT = "So11111111111111111111111111111111111111112";

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
}): TransactionInstruction {
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
}): TransactionInstruction {
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

export interface SolanaToolsConfig {
  getRpcUrl: () => string;
  getKeypair: () => Keypair | null;
  getJupiterBaseUrl: () => string;
  getJupiterApiKey: () => string | undefined;
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
        const t = await res.text();
        throw Object.assign(new Error(`HTTP ${res.status}: ${t}`), { noRetry: true });
      }
      return await res.json();
    } catch (e: any) {
      lastErr = e;
      const noRetry = e?.noRetry === true;
      clearTimeout(timer);
      if (attempt >= retries || noRetry) throw e;
      const wait = retryDelayMs * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export function createSolanaTools(config: SolanaToolsConfig): Tool[] {
  const { getRpcUrl, getKeypair, getJupiterBaseUrl, getJupiterApiKey } = config;

  return [
    // Balance tool
    {
      name: "solana_balance",
      meta: { action: "balance", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = getRpcUrl();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const address = params.address
          ? new PublicKey(String(params.address))
          : (getKeypair()?.publicKey ?? null);

        if (!address) {
          throw new Error("Missing Solana address. Provide params.address or configure keypair.");
        }

        const lamports = await conn.getBalance(address, "confirmed");
        const sol = lamports / 1_000_000_000;

        const out: any = {
          ok: true,
          address: address.toBase58(),
          sol: { lamports, sol },
        };

        if (params.includeTokens === true) {
          const tokenMint = params.tokenMint ? String(params.tokenMint) : undefined;
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
            const res = await conn.getParsedTokenAccountsByOwner(address, { programId: TOKEN_PROGRAM_ID });
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

    // Token accounts tool
    {
      name: "solana_token_accounts",
      meta: { action: "token_accounts", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = getRpcUrl();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const owner = params.address
          ? new PublicKey(String(params.address))
          : (getKeypair()?.publicKey ?? null);

        if (!owner) {
          throw new Error("Missing Solana address. Provide params.address or configure keypair.");
        }

        const tokenMint = params.tokenMint ? String(params.tokenMint) : undefined;
        const includeZero = params.includeZero === true;

        const res = tokenMint
          ? await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(tokenMint) })
          : await conn.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });

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

    // Build transfer tx
    {
      name: "solana_build_transfer_tx",
      meta: { action: "transfer", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const kp = getKeypair();
        if (!kp) {
          throw new Error("Missing Solana keypair. Configure keypair first.");
        }

        const rpc = getRpcUrl();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const to = new PublicKey(String(params.to));
        const amountUi = Number(params.amount);
        if (!Number.isFinite(amountUi) || amountUi <= 0) throw new Error("Invalid amount");

        const tokenMint = params.tokenMint ? new PublicKey(String(params.tokenMint)) : null;
        const createAta = params.createAta !== false;

        const instructions: TransactionInstruction[] = [];

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

    // Adapter build tx (generic)
    {
      name: "solana_adapter_build_tx",
      meta: { action: "build_tx", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const kp = getKeypair();
        if (!kp) {
          throw new Error("Missing Solana keypair.");
        }

        const adapterId = String(params.adapter);
        const action = String(params.action);
        const adapterParams = params.params ?? {};

        const res = await defaultRegistry.get(adapterId).buildTx(action, adapterParams, {
          userPublicKey: kp.publicKey.toBase58(),
          rpcUrl: getRpcUrl(),
        });

        // Stash extra signers
        if ((res as any).signers && Array.isArray((res as any).signers)) {
          (ctx as any).__extraSigners = (res as any).signers;
          delete (res as any).signers;
        }

        // Populate ctx.quote for swap actions
        if (action === "solana.swap_exact_in") {
          ctx.quote = {
            ok: true,
            quoteId: `ad_${adapterId}_${Date.now()}`,
            requestedSlippageBps: res.meta.slippageBps,
            quoteResponse: {
              inputMint: res.meta.mints?.inputMint,
              outputMint: res.meta.mints?.outputMint,
              inAmount: res.meta.amounts?.inAmount,
              outAmount: res.meta.amounts?.outAmount,
            },
          };
        }

        return { ok: true, txB64: res.txB64, meta: res.meta };
      },
    },

    // Jupiter quote
    {
      name: "solana_jupiter_quote",
      meta: { action: "quote", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
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
          quoteResponse = await fetchJsonWithRetry(url.toString(), {
            headers: apiKey ? { "x-api-key": apiKey } : undefined,
            timeoutMs: 10_000,
            retries: 2,
          });
        } catch (e: any) {
          throw new Error(`Jupiter quote failed: ${e?.message ?? String(e)}`);
        }

        const quoteId = "q_" + crypto.randomBytes(6).toString("hex");
        ctx.__jupQuotes = ctx.__jupQuotes || {};
        ctx.__jupQuotes[quoteId] = quoteResponse;

        return { ok: true, quoteId, requestedSlippageBps, quoteResponse };
      },
    },

    // Jupiter build tx
    {
      name: "solana_jupiter_build_tx",
      meta: { action: "build_tx", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const kp = getKeypair();
        if (!kp) {
          throw new Error("Missing Solana keypair.");
        }

        const quote = ctx.__jupQuotes?.[String(params.quoteId)];
        if (!quote) throw new Error(`Unknown quoteId: ${params.quoteId}`);

        const out = await defaultRegistry.get("jupiter").buildTx(
          "solana.swap_exact_in",
          {
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            amount: quote.inAmount,
            slippageBps: ctx.quote?.requestedSlippageBps ?? 50,
          },
          { userPublicKey: kp.publicKey.toBase58() }
        );

        return { ok: true, quoteId: params.quoteId, txB64: out.txB64, meta: out.meta };
      },
    },

    // Simulate tx
    {
      name: "solana_simulate_tx",
      meta: { action: "simulate", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params, ctx) {
        const rpc = getRpcUrl();
        const conn = new Connection(rpc, { commitment: "processed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);

        let simMeta: any = {};
        try {
          const quote = ctx.quote?.quoteResponse;
          const kp = getKeypair();
          if (quote && kp) {
            const outputMintStr = String(quote.outputMint);
            const outputMint = new PublicKey(outputMintStr);
            const owner = kp.publicKey;

            if (outputMintStr === WSOL_MINT) {
              // SOL output
              const preLamports = await conn.getBalance(owner, "processed");
              const sim = await conn.simulateTransaction(tx, {
                sigVerify: false,
                replaceRecentBlockhash: true,
                commitment: "processed",
                accounts: { addresses: [owner.toBase58()], encoding: "base64" },
              } as any);

              if (sim.value.err) {
                return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [] };
              }

              const postAcc = sim.value.accounts?.[0] as any;
              const postLamports = typeof postAcc?.lamports === "number" ? postAcc.lamports : preLamports;

              let feeLamports = 0;
              try {
                const fee = await conn.getFeeForMessage(tx.message as any, "processed" as any);
                feeLamports = fee?.value ?? 0;
              } catch { feeLamports = 0; }

              const delta = BigInt(postLamports - preLamports + feeLamports);
              const simulatedOutLamports = delta > 0n ? delta : 0n;

              simMeta = {
                outputMint: outputMint.toBase58(),
                owner: owner.toBase58(),
                preLamports: String(preLamports),
                postLamports: String(postLamports),
                feeLamports: String(feeLamports),
                simulatedOutAmount: simulatedOutLamports.toString(),
              };

              return { ok: true, unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [], ...simMeta };
            }

            // SPL token output
            const outAta = getAssociatedTokenAddressSync(outputMint, owner);
            let preAmount = 0n;
            try {
              const bal = await conn.getTokenAccountBalance(outAta, "processed");
              preAmount = BigInt(bal.value.amount);
            } catch { preAmount = 0n; }

            const sim = await conn.simulateTransaction(tx, {
              sigVerify: false,
              replaceRecentBlockhash: true,
              commitment: "processed",
              accounts: { addresses: [outAta.toBase58()], encoding: "jsonParsed" },
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

            return { ok: true, unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [], ...simMeta };
          }
        } catch {
          // fall through
        }

        const sim = await conn.simulateTransaction(tx, {
          sigVerify: false,
          replaceRecentBlockhash: true,
          commitment: "processed",
        });

        if (sim.value.err) {
          return { ok: false, err: sim.value.err, logs: sim.value.logs ?? [] };
        }

        return { ok: true, unitsConsumed: sim.value.unitsConsumed ?? null, logs: sim.value.logs ?? [], ...simMeta };
      },
    },

    // Send tx
    {
      name: "solana_send_tx",
      meta: { action: "swap", sideEffect: "broadcast", chain: "solana", risk: "high" },
      async execute(params, ctx) {
        const kp = getKeypair();
        if (!kp) {
          throw new Error("Missing Solana keypair.");
        }

        const rpc = getRpcUrl();
        const conn = new Connection(rpc, { commitment: "confirmed" as Commitment });

        const raw = Buffer.from(String(params.txB64), "base64");
        const tx = VersionedTransaction.deserialize(raw);

        const extra = (ctx as any)?.__extraSigners as Uint8Array[] | undefined;
        const extraKps = Array.isArray(extra) ? extra.map((sk) => Keypair.fromSecretKey(sk)) : [];
        tx.sign([kp, ...extraKps]);

        const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
        return { ok: true, signature: sig };
      },
    },

    // Confirm tx
    {
      name: "solana_confirm_tx",
      meta: { action: "confirm", sideEffect: "none", chain: "solana", risk: "low" },
      async execute(params) {
        const rpc = getRpcUrl();
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

import {
  AddressLookupTableAccount,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import type { ChainAdapter, Balance, TransferParams, UnsignedTx, SimulationResult, TxReceipt } from "./types.js";

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

export interface SolanaAdapterConfig {
  rpcUrl: string;
  commitment?: Commitment;
}

export class SolanaAdapter implements ChainAdapter {
  name = "solana" as const;
  private conn: Connection;
  private commitment: Commitment;

  constructor(private config: SolanaAdapterConfig) {
    this.commitment = config.commitment ?? "confirmed";
    this.conn = new Connection(config.rpcUrl, { commitment: this.commitment });
  }

  get rpcUrl(): string {
    return this.config.rpcUrl;
  }

  async getBalance(address: string, token?: string): Promise<Balance[]> {
    const pubkey = new PublicKey(address);
    const results: Balance[] = [];

    // Native SOL balance
    const lamports = await this.conn.getBalance(pubkey, this.commitment);
    results.push({
      token: WSOL_MINT,
      amount: lamports.toString(),
      decimals: 9,
    });

    // If specific token requested
    if (token && token !== WSOL_MINT && token !== "SOL") {
      const mint = new PublicKey(token);
      const res = await this.conn.getParsedTokenAccountsByOwner(pubkey, { mint });
      for (const v of res.value) {
        const info = v.account.data.parsed.info;
        results.push({
          token: info.mint,
          amount: info.tokenAmount.amount,
          decimals: info.tokenAmount.decimals,
        });
      }
    } else if (!token) {
      // All SPL tokens
      const res = await this.conn.getParsedTokenAccountsByOwner(pubkey, { programId: TOKEN_PROGRAM_ID });
      for (const v of res.value) {
        const info = v.account.data.parsed.info;
        if (Number(info.tokenAmount.amount) > 0) {
          results.push({
            token: info.mint,
            amount: info.tokenAmount.amount,
            decimals: info.tokenAmount.decimals,
          });
        }
      }
    }

    return results;
  }

  async buildTransferTx(params: TransferParams): Promise<UnsignedTx> {
    if (!params.fromWalletId) {
      throw new Error("Missing fromWalletId (sender public key)");
    }

    const from = new PublicKey(params.fromWalletId);
    const to = new PublicKey(params.to);
    const amountUi = Number(params.amount);

    if (!Number.isFinite(amountUi) || amountUi <= 0) {
      throw new Error("Invalid amount");
    }

    const instructions: TransactionInstruction[] = [];
    const isNative = params.token === WSOL_MINT || params.token === "SOL" || !params.token;

    if (isNative) {
      // SOL transfer
      const lamports = Math.round(amountUi * 1_000_000_000);
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: from,
          toPubkey: to,
          lamports,
        })
      );
    } else {
      // SPL transfer
      const tokenMint = new PublicKey(params.token);
      const mintAcc = await this.conn.getParsedAccountInfo(tokenMint, this.commitment);
      const decimals = (mintAcc.value?.data as any)?.parsed?.info?.decimals;
      if (typeof decimals !== "number") {
        throw new Error("Unable to fetch token decimals");
      }

      const amount = BigInt(Math.round(amountUi * Math.pow(10, decimals)));
      const fromAta = getAssociatedTokenAddressSync(tokenMint, from);
      const toAta = getAssociatedTokenAddressSync(tokenMint, to);

      // Create ATA if needed
      const info = await this.conn.getAccountInfo(toAta, this.commitment);
      if (!info) {
        instructions.push(
          createAssociatedTokenAccountIx({
            payer: from,
            ata: toAta,
            owner: to,
            mint: tokenMint,
          })
        );
      }

      instructions.push(
        createSplTransferIx({
          source: fromAta,
          dest: toAta,
          owner: from,
          amount,
        })
      );
    }

    const latest = await this.conn.getLatestBlockhash(this.commitment);
    const msg = new TransactionMessage({
      payerKey: from,
      recentBlockhash: latest.blockhash,
      instructions,
    }).compileToV0Message();

    const tx = new VersionedTransaction(msg);
    const txB64 = Buffer.from(tx.serialize()).toString("base64");

    return {
      chain: "solana",
      txBytesB64: txB64,
      summary: {
        kind: isNative ? "sol_transfer" : "spl_transfer",
        from: from.toBase58(),
        to: to.toBase58(),
        amount: amountUi,
        token: params.token || "SOL",
      },
    };
  }

  async simulateTx(unsignedTx: UnsignedTx): Promise<SimulationResult> {
    const raw = Buffer.from(unsignedTx.txBytesB64, "base64");
    const vtx = VersionedTransaction.deserialize(raw);

    try {
      const sim = await this.conn.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: this.commitment,
      } as any);

      if (sim.value.err) {
        return {
          ok: false,
          error: JSON.stringify(sim.value.err),
          data: {
            logs: sim.value.logs ?? [],
            unitsConsumed: sim.value.unitsConsumed ?? null,
          },
        };
      }

      return {
        ok: true,
        data: {
          logs: sim.value.logs ?? [],
          unitsConsumed: sim.value.unitsConsumed ?? null,
        },
      };
    } catch (e: any) {
      return {
        ok: false,
        error: e?.message ?? String(e),
      };
    }
  }

  async sendTx(unsignedTx: UnsignedTx, signers?: Keypair[]): Promise<TxReceipt> {
    if (!signers || signers.length === 0) {
      throw new Error("Missing signers for transaction");
    }

    const raw = Buffer.from(unsignedTx.txBytesB64, "base64");
    const tx = VersionedTransaction.deserialize(raw);
    tx.sign(signers);

    try {
      const sig = await this.conn.sendTransaction(tx, {
        skipPreflight: false,
        maxRetries: 3,
      });

      return {
        txHash: sig,
        ok: true,
        data: { status: "submitted" },
      };
    } catch (e: any) {
      return {
        txHash: "",
        ok: false,
        data: { error: e?.message ?? String(e) },
      };
    }
  }

  async waitForTx(txHash: string): Promise<TxReceipt> {
    try {
      const latest = await this.conn.getLatestBlockhash(this.commitment);
      const conf = await this.conn.confirmTransaction(
        {
          signature: txHash,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        },
        this.commitment
      );

      if (conf.value.err) {
        return {
          txHash,
          ok: false,
          data: { error: conf.value.err },
        };
      }

      return {
        txHash,
        ok: true,
        data: { confirmed: true },
      };
    } catch (e: any) {
      return {
        txHash,
        ok: false,
        data: { error: e?.message ?? String(e) },
      };
    }
  }

  // --- Extended Solana-specific methods ---

  async extractProgramIds(txB64: string): Promise<{ known: boolean; ids: string[] }> {
    try {
      const raw = Buffer.from(txB64, "base64");
      const tx = VersionedTransaction.deserialize(raw);

      const lookups = tx.message.addressTableLookups ?? [];
      const altAccounts: AddressLookupTableAccount[] = [];

      for (const l of lookups) {
        const key = new PublicKey(l.accountKey);
        const res = await this.conn.getAddressLookupTable(key);
        if (res.value) altAccounts.push(res.value);
      }

      const keys = tx.message.getAccountKeys({ addressLookupTableAccounts: altAccounts });
      const programIds = new Set<string>();

      for (const ix of tx.message.compiledInstructions) {
        const pk = keys.get(ix.programIdIndex);
        if (pk) programIds.add(pk.toBase58());
      }

      return { known: true, ids: [...programIds] };
    } catch {
      return { known: false, ids: [] };
    }
  }

  async getTokenAccounts(owner: string, tokenMint?: string): Promise<{
    owner: string;
    accounts: Array<{
      pubkey: string;
      mint: string;
      amount: string;
      decimals: number;
      uiAmount: number;
    }>;
  }> {
    const ownerPk = new PublicKey(owner);

    const res = tokenMint
      ? await this.conn.getParsedTokenAccountsByOwner(ownerPk, { mint: new PublicKey(tokenMint) })
      : await this.conn.getParsedTokenAccountsByOwner(ownerPk, { programId: TOKEN_PROGRAM_ID });

    const accounts = res.value.map((v) => {
      const info = v.account.data.parsed.info;
      const ta = info.tokenAmount;
      return {
        pubkey: v.pubkey.toBase58(),
        mint: info.mint,
        amount: ta.amount,
        decimals: ta.decimals,
        uiAmount: ta.uiAmount,
      };
    });

    return { owner, accounts };
  }
}

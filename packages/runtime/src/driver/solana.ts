import {
  AddressLookupTableAccount,
  Connection,
  PublicKey,
  VersionedTransaction,
  type Commitment,
} from "@solana/web3.js";

import type { ChainDriver, ExtractIdsResult, SimResult } from "./types.js";

export class SolanaDriver implements ChainDriver {
  chain = "solana" as const;

  async simulateTxB64(txB64: string, ctx: { rpcUrl: string }): Promise<SimResult> {
    const conn = new Connection(ctx.rpcUrl, { commitment: "confirmed" as Commitment });
    const raw = Buffer.from(txB64, "base64");
    const vtx = VersionedTransaction.deserialize(raw);

    try {
      const sim = await conn.simulateTransaction(vtx, {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: "confirmed",
      } as any);

      if (sim.value.err) {
        return {
          ok: false,
          err: sim.value.err,
          logs: sim.value.logs ?? [],
          unitsConsumed: sim.value.unitsConsumed ?? null,
        };
      }
      return {
        ok: true,
        logs: sim.value.logs ?? [],
        unitsConsumed: sim.value.unitsConsumed ?? null,
      };
    } catch (e: any) {
      return { ok: false, logs: [String(e?.message ?? e)] };
    }
  }

  async extractIdsFromTxB64(txB64: string, ctx: { rpcUrl: string }): Promise<ExtractIdsResult> {
    try {
      const raw = Buffer.from(txB64, "base64");
      const tx = VersionedTransaction.deserialize(raw);

      const conn = new Connection(ctx.rpcUrl, { commitment: "processed" as Commitment });

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

      return { known: true, ids: [...programIds] };
    } catch {
      return { known: false, ids: [] };
    }
  }
}

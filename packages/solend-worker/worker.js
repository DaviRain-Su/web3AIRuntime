import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';
import BN from 'bn.js';
import * as solend from '@solendprotocol/solend-sdk';

// NOTE:
// This worker is intentionally dependency-isolated from the monorepo.
// The @solendprotocol/solend-sdk package version we pin does NOT export SolendMarket/SolendAction.
// We use Solend's public config API + low-level instruction builders.

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP_${res.status}`);
  return await res.json();
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)));
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  const input = raw ? JSON.parse(raw) : {};

  const rpcUrl = String(input.rpcUrl || 'https://api.mainnet-beta.solana.com');
  const owner = new PublicKey(String(input.userPublicKey));
  // The System Program address (111..111) is NOT a valid fee payer for transactions.
  if (owner.toBase58() === '11111111111111111111111111111111') {
    console.log(JSON.stringify({ ok: false, error: 'INVALID_USER_PUBKEY_FEE_PAYER', message: 'Provide a real user wallet pubkey (not 111..).' }));
    return;
  }
  const amountBase = BigInt(String(input.amountBase ?? '0'));
  const symbol = String(input.symbol || 'USDC');
  const deployment = String(input.deployment || 'production');

  const connection = new Connection(rpcUrl, 'confirmed');

  // Checkpoint #1: fetch reserve/market metadata via Solend API
  const apiHost = String(input.apiHost || 'https://api.save.finance');
  const markets = await fetchJson(`${apiHost}/v1/markets/configs?scope=all&deployment=${deployment}`);
  const market = (Array.isArray(markets) ? markets : []).find((m) => m?.name === 'main') || markets?.[0];
  if (!market) {
    console.log(JSON.stringify({ ok: false, error: 'MARKET_NOT_FOUND', deployment }));
    return;
  }

  const reserve = (market.reserves || []).find((r) => r?.liquidityToken?.symbol === symbol);
  if (!reserve) {
    console.log(JSON.stringify({ ok: false, error: 'RESERVE_NOT_FOUND', symbol, market: market.name }));
    return;
  }

  const programId = solend.getProgramId(deployment);

  const marketPk = new PublicKey(market.address);
  const marketAuthorityPk = new PublicKey(market.authorityAddress);

  const reservePk = new PublicKey(reserve.address);
  const reserveLiquiditySupplyPk = new PublicKey(reserve.liquidityAddress);
  const reserveCollateralMintPk = new PublicKey(reserve.collateralMintAddress);

  const liquidityMintPk = new PublicKey(reserve.liquidityToken.mint);

  const userLiquidityAta = getAssociatedTokenAddressSync(liquidityMintPk, owner, false);
  const userCollateralAta = getAssociatedTokenAddressSync(reserveCollateralMintPk, owner, false);

  // Mode: just return config
  if (input.mode === 'config') {
    console.log(
      JSON.stringify({
        ok: true,
        symbol,
        deployment,
        market: {
          name: market.name,
          address: marketPk.toBase58(),
          authorityAddress: marketAuthorityPk.toBase58(),
        },
        reserve: {
          address: reservePk.toBase58(),
          liquiditySupply: reserveLiquiditySupplyPk.toBase58(),
          liquidityMint: liquidityMintPk.toBase58(),
          collateralMint: reserveCollateralMintPk.toBase58(),
          collateralSupply: reserve.collateralSupplyAddress,
        },
        programId: programId.toBase58(),
      })
    );
    return;
  }

  // Checkpoint #2: build a real deposit transaction + simulate.
  // We build a V0 (Versioned) transaction so we can simulate without needing private keys.
  // Fee payer = user pubkey (must exist on-chain). Signatures are NOT verified (sigVerify=false).
  const ixs = [];

  // Optional compute bump
  ixs.push(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));

  // Ensure ATAs exist (idempotent). Payer is the user.
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, userLiquidityAta, owner, liquidityMintPk));
  ixs.push(createAssociatedTokenAccountIdempotentInstruction(owner, userCollateralAta, owner, reserveCollateralMintPk));

  // Solend deposit instruction (transferAuthority set to owner for “real” tx shape)
  ixs.push(
    solend.depositReserveLiquidityInstruction(
      new BN(amountBase.toString()),
      userLiquidityAta,
      userCollateralAta,
      reservePk,
      reserveLiquiditySupplyPk,
      reserveCollateralMintPk,
      marketPk,
      marketAuthorityPk,
      owner, // transferAuthority (signer)
      programId
    )
  );

  const bh = await connection.getLatestBlockhash('confirmed');

  const msgV0 = new TransactionMessage({
    payerKey: owner,
    recentBlockhash: bh.blockhash,
    instructions: ixs,
  }).compileToV0Message();

  const vtx = new VersionedTransaction(msgV0);

  let sim = null;
  try {
    sim = await connection.simulateTransaction(vtx, {
      sigVerify: false,
      replaceRecentBlockhash: true,
      commitment: 'confirmed',
    });
  } catch (e) {
    sim = { value: { err: String(e?.message ?? e), logs: null } };
  }

  const txB64 = Buffer.from(vtx.serialize()).toString('base64');

  console.log(
    JSON.stringify({
      ok: true,
      symbol,
      amountBase: amountBase.toString(),
      programId: programId.toBase58(),
      accounts: {
        userLiquidityAta: userLiquidityAta.toBase58(),
        userCollateralAta: userCollateralAta.toBase58(),
        reserve: reservePk.toBase58(),
        reserveLiquiditySupply: reserveLiquiditySupplyPk.toBase58(),
        reserveCollateralMint: reserveCollateralMintPk.toBase58(),
        lendingMarket: marketPk.toBase58(),
        lendingMarketAuthority: marketAuthorityPk.toBase58(),
      },
      txB64,
      simulation: {
        err: sim?.value?.err ?? null,
        logs: sim?.value?.logs ?? null,
        unitsConsumed: sim?.value?.unitsConsumed ?? null,
      },
    })
  );
}

main().catch((e) => {
  console.log(JSON.stringify({ ok: false, error: 'INTERNAL', message: String(e?.message ?? e) }));
});

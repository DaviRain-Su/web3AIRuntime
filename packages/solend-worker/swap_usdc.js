import fs from 'fs';
import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';

const USER_PUBKEY = 'FM7WTd5Hr7ppp6vu3M4uAspF4DoRjrYPPFvAmqB7H95D';
const KEYPAIR_PATH = process.env.W3RT_SOLANA_KEYPAIR_PATH || '/home/davirain/.config/solana/id.json';
const RPC_URL = process.env.W3RT_SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com';

// New Jupiter endpoints may require an API key on some networks/setups.
// Use a public fallback for v6 if /swap/v1 returns 401.
const JUP_BASE = process.env.W3RT_JUPITER_BASE_URL || 'https://api.jup.ag';
const JUP_V6_BASE = process.env.W3RT_JUPITER_V6_BASE_URL || 'https://api.jup.ag';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const WSOL_MINT = 'So11111111111111111111111111111111111111112';

const inLamports = 50_000_000; // 0.05 SOL
const slippageBps = 50; // 0.5%

async function jget(url, headers) {
  const res = await fetch(url, { headers });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function jpost(url, body, headers) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(headers || {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  const conn = new Connection(RPC_URL, 'confirmed');
  const secret = JSON.parse(fs.readFileSync(KEYPAIR_PATH, 'utf-8'));
  const kp = Keypair.fromSecretKey(Uint8Array.from(secret));

  if (kp.publicKey.toBase58() !== USER_PUBKEY) {
    throw new Error(`Keypair pubkey mismatch. Expected ${USER_PUBKEY}, got ${kp.publicKey.toBase58()}`);
  }

  const apiKey = process.env.W3RT_JUPITER_API_KEY;
  const headers = apiKey ? { 'x-api-key': apiKey } : undefined;

  let quote;
  let swap;

  // Try /swap/v1 first
  try {
    const quoteUrl = new URL('/swap/v1/quote', JUP_BASE);
    quoteUrl.searchParams.set('inputMint', WSOL_MINT);
    quoteUrl.searchParams.set('outputMint', USDC_MINT);
    quoteUrl.searchParams.set('amount', String(inLamports));
    quoteUrl.searchParams.set('slippageBps', String(slippageBps));

    quote = await jget(quoteUrl.toString(), headers);

    swap = await jpost(
      new URL('/swap/v1/swap', JUP_BASE).toString(),
      {
        quoteResponse: quote,
        userPublicKey: USER_PUBKEY,
        wrapAndUnwrapSol: true,
      },
      headers
    );
  } catch (e) {
    const msg = String(e?.message ?? e);
    if (!msg.includes('HTTP 401')) throw e;

    // Fallback to v6 public endpoints
    const quoteUrl = new URL('/v6/quote', JUP_V6_BASE);
    quoteUrl.searchParams.set('inputMint', WSOL_MINT);
    quoteUrl.searchParams.set('outputMint', USDC_MINT);
    quoteUrl.searchParams.set('amount', String(inLamports));
    quoteUrl.searchParams.set('slippageBps', String(slippageBps));

    quote = await jget(quoteUrl.toString());

    swap = await jpost(new URL('/v6/swap', JUP_V6_BASE).toString(), {
      quoteResponse: quote,
      userPublicKey: USER_PUBKEY,
      wrapAndUnwrapSol: true,
    });
  }

  const txB64 = swap?.swapTransaction;
  if (!txB64) throw new Error('Missing swapTransaction');

  const vtx = VersionedTransaction.deserialize(Buffer.from(txB64, 'base64'));
  vtx.sign([kp]);

  const sig = await conn.sendRawTransaction(vtx.serialize(), { skipPreflight: false, maxRetries: 3 });
  const conf = await conn.confirmTransaction(sig, 'confirmed');

  console.log(
    JSON.stringify(
      {
        ok: true,
        sig,
        confirm: conf?.value ?? null,
        quote: {
          inAmount: quote?.inAmount,
          outAmount: quote?.outAmount,
          inputMint: quote?.inputMint,
          outputMint: quote?.outputMint,
          slippageBps,
        },
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        error: String(e?.message ?? e),
        name: e?.name,
        cause: e?.cause ? String(e.cause) : undefined,
        stack: e?.stack,
      },
      null,
      2
    )
  );
  process.exit(1);
});

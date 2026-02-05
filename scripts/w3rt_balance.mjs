#!/usr/bin/env node
/**
 * w3rt_balance.mjs
 * Simple CLI helper for OpenClaw skills.
 *
 * Reads config from ${W3RT_DIR:-~/.w3rt}/config.yaml
 * Reads keypair from wallet.keyPath (relative to W3RT_DIR)
 *
 * Usage:
 *   node scripts/w3rt_balance.mjs
 *   node scripts/w3rt_balance.mjs --address <pubkey>
 *   node scripts/w3rt_balance.mjs --include-tokens
 *   node scripts/w3rt_balance.mjs --token-mint <mint>
 */

import os from 'node:os';
import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import yaml from 'js-yaml';
import { Keypair } from '@solana/web3.js';
import { createSolanaTools } from '@w3rt/runtime';

function w3rtDir() {
  return process.env.W3RT_DIR || join(os.homedir(), '.w3rt');
}

function loadConfig() {
  const p = join(w3rtDir(), 'config.yaml');
  if (!existsSync(p)) return {};
  return yaml.load(readFileSync(p, 'utf-8')) || {};
}

function loadKeypair() {
  const cfg = loadConfig();
  const kpPath = cfg?.wallet?.keyPath;
  if (!kpPath) return null;
  const full = String(kpPath).startsWith('/') ? String(kpPath) : join(w3rtDir(), String(kpPath));
  if (!existsSync(full)) return null;
  const secret = JSON.parse(readFileSync(full, 'utf-8'));
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function parseArgs(argv) {
  const out = { address: undefined, includeTokens: false, tokenMint: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--address') out.address = argv[++i];
    else if (a === '--include-tokens') out.includeTokens = true;
    else if (a === '--token-mint') out.tokenMint = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfg = loadConfig();

  const tools = createSolanaTools({
    getRpcUrl: () => cfg?.solana?.rpc || 'https://api.mainnet-beta.solana.com',
    getKeypair: () => loadKeypair(),
    getJupiterBaseUrl: () => cfg?.jupiter?.baseUrl || 'https://quote-api.jup.ag/v6',
    getJupiterApiKey: () => cfg?.jupiter?.apiKey,
  });

  const t = tools.find(x => x.name === 'solana_balance');
  if (!t) throw new Error('solana_balance tool not found');

  const res = await t.execute({
    address: args.address,
    includeTokens: args.includeTokens,
    tokenMint: args.tokenMint,
  }, {});

  console.log(JSON.stringify(res, null, 2));
}

main().catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});

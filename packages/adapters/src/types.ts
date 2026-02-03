export type AdapterChain = "solana";

export type AdapterRisk = "low" | "medium" | "high";

export type AdapterAction = string;

export type JsonSchema = Record<string, any>;

export interface AdapterCapability {
  action: AdapterAction;
  description?: string;
  risk?: AdapterRisk;
  // Optional JSON schema describing params for UI/tooling.
  paramsSchema?: JsonSchema;
}

export interface AdapterMeta {
  chain: AdapterChain;
  adapter: string;
  action: AdapterAction;

  // Optional context for policy/trace.
  mints?: { inputMint?: string; outputMint?: string; tokenMint?: string };
  amounts?: { inAmount?: string; outAmount?: string; amountUi?: number };
  slippageBps?: number;

  // Optional hints
  programHints?: string[];
}

export interface BuildTxResult {
  ok: true;
  txB64: string;
  meta: AdapterMeta;
}

export interface AdapterContext {
  // Runtime may pass shared context (network, rpcUrl, user pubkey, etc.)
  [k: string]: any;
}

export interface Adapter {
  id: string;
  chain: AdapterChain;

  capabilities(): AdapterCapability[];

  buildTx(action: AdapterAction, params: any, ctx: AdapterContext): Promise<BuildTxResult>;
}

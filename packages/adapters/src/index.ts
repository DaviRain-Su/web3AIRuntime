export * from "./types.js";
export * from "./registry.js";

export * from "./solana/jupiter.js";
export * from "./solana/meteora_dlmm.js";
export * from "./solana/solend.js";

export * from "./evm/zeroex.js";

// Side-effect registration: importing @w3rt/adapters will register built-in adapters.
// This keeps runtime glue minimal: add a new adapter file + export it here, and it becomes available.
import { defaultRegistry } from "./registry.js";
import { jupiterAdapter } from "./solana/jupiter.js";
import { meteoraDlmmAdapter } from "./solana/meteora_dlmm.js";
import { solendAdapter } from "./solana/solend.js";
import { zeroExAdapter } from "./evm/zeroex.js";

for (const a of [jupiterAdapter, meteoraDlmmAdapter, solendAdapter, zeroExAdapter]) {
  try {
    defaultRegistry.register(a);
  } catch {
    // ignore duplicate registration
  }
}

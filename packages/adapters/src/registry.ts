import type { Adapter } from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<string, Adapter>();

  register(adapter: Adapter) {
    if (!adapter?.id) throw new Error("Adapter missing id");
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): Adapter {
    const a = this.adapters.get(id);
    if (!a) throw new Error(`Unknown adapter: ${id}`);
    return a;
  }

  list(): Adapter[] {
    return [...this.adapters.values()];
  }
}

export const defaultRegistry = new AdapterRegistry();

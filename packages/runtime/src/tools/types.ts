export type Dict = Record<string, any>;

export interface ToolMeta {
  action: string;
  sideEffect: "none" | "broadcast";
  chain?: string;
  risk?: "low" | "medium" | "high";
}

export interface Tool {
  name: string;
  meta: ToolMeta;
  execute: (params: Dict, ctx: Dict) => Promise<any>;
}

export function createToolMap(tools: Tool[]): Map<string, Tool> {
  return new Map(tools.map((t) => [t.name, t]));
}

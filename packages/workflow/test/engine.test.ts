import { describe, test, expect } from "bun:test";
import { WorkflowEngine, createToolMap, type ToolDefinition, type Dict } from "../src/engine.js";
import type { Workflow } from "../src/types.js";

describe("WorkflowEngine", () => {
  const mockTools: ToolDefinition[] = [
    {
      name: "get_price",
      meta: { action: "price", sideEffect: "none", risk: "low" },
      async execute(params) {
        return { price: 100, token: params.token };
      },
    },
    {
      name: "calculate",
      meta: { action: "calc", sideEffect: "none", risk: "low" },
      async execute(params, ctx) {
        const price = ctx.quote?.price ?? 0;
        return { result: price * Number(params.multiplier) };
      },
    },
    {
      name: "send_tx",
      meta: { action: "swap", sideEffect: "broadcast", chain: "solana", risk: "high" },
      async execute(params) {
        return { txHash: "mock_tx_123", amount: params.amount };
      },
    },
  ];

  test("runs simple workflow", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(true);
    expect(result.context.quote?.price).toBe(100);
  });

  test("template rendering in params", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
        {
          name: "calc",
          type: "analysis",
          actions: [{ tool: "calculate", params: { multiplier: "2" } }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(true);
    expect(result.context.calc?.result).toBe(200);
  });

  test("when condition skips stage", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
        {
          name: "skipped",
          type: "analysis",
          when: "quote.price > 200",
          actions: [{ tool: "calculate", params: { multiplier: "10" } }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(true);
    expect(result.context.skipped).toBeUndefined();
  });

  test("when condition runs stage", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
        {
          name: "calc",
          type: "analysis",
          when: "quote.price == 100",
          actions: [{ tool: "calculate", params: { multiplier: "5" } }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(true);
    expect(result.context.calc?.result).toBe(500);
  });

  test("approval stage with auto-approve", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
        {
          name: "approve",
          type: "approval",
          actions: [],
          approval: {
            required: true,
            conditions: ["quote.price == 100"],
          },
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
      onApprovalRequired: async () => true,
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(true);
  });

  test("approval stage rejects when conditions fail", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
        {
          name: "approve",
          type: "approval",
          actions: [],
          approval: {
            required: true,
            conditions: ["quote.price > 200"],
          },
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
      onApprovalRequired: async () => true,
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("conditions failed");
  });

  test("policy check blocks broadcast", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "execute",
          type: "execution",
          actions: [{ tool: "send_tx", params: { amount: "1000" } }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
      onPolicyCheck: async () => ({ allowed: false, reason: "Amount too high" }),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Policy blocked");
  });

  test("callbacks are called", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "quote",
          type: "analysis",
          actions: [{ tool: "get_price", params: { token: "SOL" } }],
        },
      ],
    };

    const events: string[] = [];

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
      onStageStart: async (stage) => {
        events.push(`stage_start:${stage.name}`);
      },
      onStageEnd: async (stage) => {
        events.push(`stage_end:${stage.name}`);
      },
      onActionStart: async (action) => {
        events.push(`action_start:${action.tool}`);
      },
      onActionEnd: async (action, tool, result) => {
        events.push(`action_end:${action.tool}`);
      },
    });

    await engine.run(workflow);

    expect(events).toEqual([
      "stage_start:quote",
      "action_start:get_price",
      "action_end:get_price",
      "stage_end:quote",
    ]);
  });

  test("unknown tool throws error", async () => {
    const workflow: Workflow = {
      name: "test",
      version: "1.0",
      trigger: "manual",
      stages: [
        {
          name: "bad",
          type: "analysis",
          actions: [{ tool: "nonexistent_tool" }],
        },
      ],
    };

    const engine = new WorkflowEngine({
      tools: createToolMap(mockTools),
    });

    const result = await engine.run(workflow);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("Unknown tool");
  });
});

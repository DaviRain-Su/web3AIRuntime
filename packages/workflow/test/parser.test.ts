import { describe, test, expect } from "bun:test";
import { parseWorkflow } from "../src/parser.js";

describe("parseWorkflow", () => {
  test("parses valid workflow", () => {
    const yaml = `
name: test_swap
version: "1.0"
description: Test swap workflow
trigger: manual
stages:
  - name: quote
    type: analysis
    actions:
      - tool: get_quote
        params:
          token: SOL
  - name: execute
    type: execution
    actions:
      - tool: send_tx
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(true);
    expect(result.workflow?.name).toBe("test_swap");
    expect(result.workflow?.version).toBe("1.0");
    expect(result.workflow?.stages).toHaveLength(2);
    expect(result.workflow?.stages[0].name).toBe("quote");
    expect(result.workflow?.stages[0].actions[0].tool).toBe("get_quote");
  });

  test("parses workflow with when condition", () => {
    const yaml = `
name: conditional
version: "1.0"
trigger: manual
stages:
  - name: maybe
    type: analysis
    when: "price > 100"
    actions:
      - tool: do_something
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(true);
    expect(result.workflow?.stages[0].when).toBe("price > 100");
  });

  test("parses approval stage", () => {
    const yaml = `
name: with_approval
version: "1.0"
trigger: manual
stages:
  - name: approve
    type: approval
    approval:
      required: true
      conditions:
        - "simulation.ok == true"
        - "amount < 1000"
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(true);
    expect(result.workflow?.stages[0].type).toBe("approval");
    expect(result.workflow?.stages[0].approval?.required).toBe(true);
    expect(result.workflow?.stages[0].approval?.conditions).toHaveLength(2);
  });

  test("rejects missing name", () => {
    const yaml = `
version: "1.0"
trigger: manual
stages:
  - name: test
    type: analysis
    actions:
      - tool: foo
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Missing or invalid 'name' field");
  });

  test("rejects invalid trigger", () => {
    const yaml = `
name: test
version: "1.0"
trigger: invalid
stages:
  - name: test
    type: analysis
    actions:
      - tool: foo
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("trigger"))).toBe(true);
  });

  test("rejects empty stages", () => {
    const yaml = `
name: test
version: "1.0"
trigger: manual
stages: []
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("stages"))).toBe(true);
  });

  test("rejects invalid stage type", () => {
    const yaml = `
name: test
version: "1.0"
trigger: manual
stages:
  - name: test
    type: invalid_type
    actions:
      - tool: foo
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("type"))).toBe(true);
  });

  test("rejects stage without actions (except approval)", () => {
    const yaml = `
name: test
version: "1.0"
trigger: manual
stages:
  - name: test
    type: analysis
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    expect(result.errors?.some((e) => e.includes("actions"))).toBe(true);
  });

  test("handles invalid yaml", () => {
    const yaml = `
name: test
  version: "1.0"
    bad: [indentation
`;

    const result = parseWorkflow(yaml);
    expect(result.ok).toBe(false);
    // Either YAML parse error or validation error
    expect(result.errors?.length).toBeGreaterThan(0);
  });
});

import type { PolicyConfig, PolicyContext, PolicyDecision } from "./types.js";
export declare class PolicyEngine {
    readonly config: PolicyConfig;
    constructor(config: PolicyConfig);
    decide(ctx: PolicyContext): PolicyDecision;
}

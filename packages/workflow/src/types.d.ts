export interface Workflow {
    name: string;
    version: string;
    description?: string;
    trigger: "manual" | "cron";
    triggerConfig?: {
        cron?: string;
    };
    stages: WorkflowStage[];
    config?: {
        maxRetries?: number;
        timeout?: string;
        rollbackOnFailure?: boolean;
    };
}
export interface WorkflowStage {
    name: string;
    type: "analysis" | "simulation" | "approval" | "execution" | "monitor";
    actions: WorkflowAction[];
    when?: string;
    approval?: {
        required: boolean;
        timeout?: string;
        conditions?: string[];
    };
}
export interface WorkflowAction {
    tool: string;
    params?: Record<string, unknown>;
}

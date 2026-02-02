export type TraceEventType = "run.started" | "run.finished" | "step.started" | "step.finished" | "tool.called" | "tool.result" | "tool.error" | "policy.decision" | "tx.built" | "tx.simulated" | "tx.submitted" | "tx.confirmed";
export interface TraceEvent {
    id: string;
    ts: number;
    type: TraceEventType;
    runId: string;
    stepId?: string;
    sessionId?: string;
    chain?: string;
    walletId?: string;
    tool?: string;
    data?: Record<string, unknown>;
}
export interface ArtifactRef {
    runId: string;
    name: string;
    path: string;
    sha256?: string;
    bytes?: number;
}

import type { TraceEvent } from "./types.js";
export declare class TraceStore {
    private baseDir;
    constructor(baseDir: string);
    emit(e: Omit<TraceEvent, "id">): TraceEvent;
}

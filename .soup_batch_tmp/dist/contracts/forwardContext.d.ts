export type ForwardReadState = 'complete' | 'partial' | 'unavailable';
export interface ForwardReadEntry {
    forwardId: string;
    depth: number;
    totalNodes: number | null;
    processedNodes: number;
    state: ForwardReadState;
    reason?: 'node_limit' | 'depth_limit' | 'fetch_failed' | 'malformed_response';
}
/** Counts describe observed message nodes, never an estimate of unread descendants. */
export interface ForwardCompleteness {
    version: 1;
    state: ForwardReadState;
    knownTotalNodes: number;
    processedNodes: number;
    omittedKnownNodes: number;
    totalExact: boolean;
    failedForwardIds: string[];
    depthLimitedForwardIds: string[];
    cycleForwardIds: string[];
    nodeLimitReached: boolean;
    textTruncated: boolean;
    mediaTruncated: boolean;
    snapshotTruncated: boolean;
    entries: ForwardReadEntry[];
}

/**
 * Types for `@romiluz/memongo/memongo-bridge` when dist omits `.d.ts` for this chunk.
 * Prefer `src/memongo-bridge.ts` as source of truth.
 */
declare module "@romiluz/memongo/memongo-bridge" {
  export type MemongoBridgeContext = { agentId: string };

  export type StructuredMemoryEntry = Record<string, unknown>;
  export type ProcedureEntry = Record<string, unknown>;

  export function memongoBridgeGetManager(agentId?: string): Promise<unknown>;

  export function memongoBridgeSearch(params: {
    query: string;
    agentId?: string;
    maxResults?: number;
    minScore?: number;
    sessionKey?: string;
  }): Promise<unknown>;

  export function memongoBridgeSearchKB(params: {
    query: string;
    agentId?: string;
    maxResults?: number;
    minScore?: number;
    filter?: { tags?: string[]; category?: string; source?: string };
  }): Promise<unknown>;

  export function memongoBridgeReadFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
    agentId?: string;
  }): Promise<unknown>;

  export function memongoBridgeAdd(params: {
    content: string;
    agentId?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<{ eventId: string; chunkCreated: boolean }>;

  export function memongoBridgeWriteConversationEvent(params: {
    agentId?: string;
    role: "user" | "assistant" | "system" | "tool";
    body: string;
    sessionId?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
    scope?: string;
  }): Promise<{ eventId: string; chunkCreated: boolean }>;

  export function memongoBridgeWriteStructuredMemory(params: {
    agentId?: string;
    entry: StructuredMemoryEntry;
  }): Promise<{ upserted: boolean; id: string }>;

  export function memongoBridgeWriteProcedure(params: {
    agentId?: string;
    entry: ProcedureEntry;
  }): Promise<{ upserted: boolean; id: string }>;

  export function memongoBridgeProfile(params: {
    agentId?: string;
    scopeRef?: string;
    maxEntities?: number;
    maxEpisodes?: number;
    maxPerType?: number;
    activityWindowMs?: number;
  }): Promise<unknown>;

  export function memongoBridgeStatus(params: { agentId?: string }): Promise<unknown>;
  export function memongoBridgeGetDetailedStatus(params: { agentId?: string }): Promise<unknown>;
  export function memongoBridgeStats(params: { agentId?: string }): Promise<unknown>;

  export function memongoBridgeSync(params: {
    agentId?: string;
    reason?: string;
    force?: boolean;
  }): Promise<void>;

  export function memongoBridgeProbeEmbedding(params: { agentId?: string }): Promise<unknown>;
  export function memongoBridgeProbeVector(params: { agentId?: string }): Promise<boolean>;

  export function memongoBridgeRelevanceExplain(params: {
    agentId?: string;
    query: string;
    sourceScope?: "all" | "memory" | "kb" | "structured";
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
    deep?: boolean;
  }): Promise<unknown>;

  export function memongoBridgeRelevanceBenchmark(params: {
    agentId?: string;
    datasetPath?: string;
    maxResults?: number;
    minScore?: number;
  }): Promise<unknown>;

  export function memongoBridgeRelevanceReport(params: {
    agentId?: string;
    windowMs?: number;
  }): Promise<unknown>;

  export function memongoBridgeRelevanceSampleRate(params: { agentId?: string }): Promise<unknown>;
}

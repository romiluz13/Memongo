import { loadConfig } from "./config/config.js";
/**
 * Stable entry for Memongo HTTP product layer: loads gateway config and delegates
 * to MongoDB memory manager. Built as a dedicated dist chunk via tsdown.
 * Thin façade — no duplicated business logic (see memongo-platform/docs/capability-matrix.md).
 */
import type { MemoryScope } from "./config/types.memory.js";
import type { MongoDBMemoryManager } from "./memory/mongodb-manager.js";
import type { ProcedureEntry } from "./memory/mongodb-procedures.js";
import type { RelevanceSourceScope } from "./memory/mongodb-relevance.js";
import type { StructuredMemoryEntry } from "./memory/mongodb-structured-memory.js";
import { getMemorySearchManager } from "./memory/search-manager.js";

export type MemongoBridgeContext = {
  agentId: string;
};

function resolveAgentId(explicit?: string): string {
  return (explicit ?? process.env.MEMONGO_AGENT_ID ?? "main").trim() || "main";
}

export async function memongoBridgeGetManager(agentId?: string): Promise<MongoDBMemoryManager> {
  const id = resolveAgentId(agentId);
  const cfg = loadConfig();
  const { manager, error } = await getMemorySearchManager({ cfg, agentId: id });
  if (!manager || error) {
    throw new Error(error ?? "mongodb memory unavailable");
  }
  return manager as MongoDBMemoryManager;
}

export async function memongoBridgeSearch(params: {
  query: string;
  agentId?: string;
  maxResults?: number;
  minScore?: number;
  sessionKey?: string;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.search(params.query, {
    maxResults: params.maxResults,
    minScore: params.minScore,
    sessionKey: params.sessionKey,
  });
}

export async function memongoBridgeSearchKB(params: {
  query: string;
  agentId?: string;
  maxResults?: number;
  minScore?: number;
  filter?: { tags?: string[]; category?: string; source?: string };
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.searchKB(params.query, {
    maxResults: params.maxResults,
    minScore: params.minScore,
    filter: params.filter,
  });
}

export async function memongoBridgeReadFile(params: {
  relPath: string;
  from?: number;
  lines?: number;
  agentId?: string;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.readFile({
    relPath: params.relPath,
    from: params.from,
    lines: params.lines,
  });
}

/** Legacy: append a user message (same as `writeConversationEvent` with role user). */
export async function memongoBridgeAdd(params: {
  content: string;
  agentId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}) {
  return memongoBridgeWriteConversationEvent({
    agentId: params.agentId,
    role: "user",
    body: params.content,
    sessionId: params.sessionId,
    metadata: params.metadata,
  });
}

export async function memongoBridgeWriteConversationEvent(params: {
  agentId?: string;
  role: "user" | "assistant" | "system" | "tool";
  body: string;
  sessionId?: string;
  timestamp?: string;
  metadata?: Record<string, unknown>;
  scope?: MemoryScope;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  const timestamp = params.timestamp ? new Date(params.timestamp) : undefined;
  return m.writeConversationEvent({
    role: params.role,
    body: params.body,
    sessionId: params.sessionId,
    timestamp,
    metadata: params.metadata,
    scope: params.scope,
  });
}

export async function memongoBridgeWriteStructuredMemory(params: {
  agentId?: string;
  entry: StructuredMemoryEntry;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  const id = resolveAgentId(params.agentId);
  return m.writeStructuredMemory({
    ...params.entry,
    agentId: params.entry.agentId ?? id,
  });
}

export async function memongoBridgeWriteProcedure(params: {
  agentId?: string;
  entry: ProcedureEntry;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  const id = resolveAgentId(params.agentId);
  return m.writeProcedure({
    ...params.entry,
    agentId: params.entry.agentId ?? id,
  });
}

export async function memongoBridgeProfile(params: {
  agentId?: string;
  scopeRef?: string;
  maxEntities?: number;
  maxEpisodes?: number;
  maxPerType?: number;
  activityWindowMs?: number;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.synthesizeProfile({
    scopeRef: params.scopeRef,
    maxEntities: params.maxEntities,
    maxEpisodes: params.maxEpisodes,
    maxPerType: params.maxPerType,
    activityWindowMs: params.activityWindowMs,
  });
}

export async function memongoBridgeStatus(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.status();
}

export async function memongoBridgeGetDetailedStatus(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.getDetailedStatus();
}

export async function memongoBridgeStats(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.stats();
}

export async function memongoBridgeSync(params: {
  agentId?: string;
  reason?: string;
  force?: boolean;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.sync({
    reason: params.reason,
    force: params.force,
  });
}

export async function memongoBridgeProbeEmbedding(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.probeEmbeddingAvailability();
}

export async function memongoBridgeProbeVector(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.probeVectorAvailability();
}

export async function memongoBridgeRelevanceExplain(params: {
  agentId?: string;
  query: string;
  sourceScope?: RelevanceSourceScope;
  sessionKey?: string;
  maxResults?: number;
  minScore?: number;
  deep?: boolean;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.relevanceExplain({
    query: params.query,
    sourceScope: params.sourceScope,
    sessionKey: params.sessionKey,
    maxResults: params.maxResults,
    minScore: params.minScore,
    deep: params.deep,
  });
}

export async function memongoBridgeRelevanceBenchmark(params: {
  agentId?: string;
  datasetPath?: string;
  maxResults?: number;
  minScore?: number;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.relevanceBenchmark({
    datasetPath: params.datasetPath,
    maxResults: params.maxResults,
    minScore: params.minScore,
  });
}

export async function memongoBridgeRelevanceReport(params: {
  agentId?: string;
  windowMs?: number;
}) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.relevanceReport({ windowMs: params.windowMs });
}

export async function memongoBridgeRelevanceSampleRate(params: { agentId?: string }) {
  const m = await memongoBridgeGetManager(params.agentId);
  return m.relevanceSampleRate();
}

export type { ProcedureEntry } from "./memory/mongodb-procedures.js";
export type { StructuredMemoryEntry } from "./memory/mongodb-structured-memory.js";

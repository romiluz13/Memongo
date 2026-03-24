/**
 * Supermemory-inspired request shapes for a future hosted or sidecar API.
 * Memongo’s canonical runtime implementation lives in the main gateway (`@romiluz/memongo`).
 */

export type MemongoContainerTag = string;

export type MemongoAddInput = {
  /** Raw text, or pass `new URL(...)` / path string — same idea as Supermemory `add()`. */
  content: string;
  /** Isolation key (tenant / user / session). */
  containerTag?: MemongoContainerTag;
  /** Hint for extraction / routing. */
  entityContext?: string;
  customId?: string;
  metadata?: Record<string, string | number | boolean | null>;
  /** Target agent id (defaults via MEMONGO_AGENT_ID server-side). */
  agentId?: string;
  sessionId?: string;
};

export type MemongoSearchInput = {
  query: string;
  containerTag?: MemongoContainerTag;
  limit?: number;
  agentId?: string;
  minScore?: number;
  sessionKey?: string;
};

export type MemongoProfileInput = {
  containerTag?: MemongoContainerTag;
  agentId?: string;
  scopeRef?: string;
  maxEntities?: number;
  maxEpisodes?: number;
};

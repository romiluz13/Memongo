import { Hono } from "hono";
import {
  memongoBridgeAdd,
  memongoBridgeGetDetailedStatus,
  memongoBridgeProbeEmbedding,
  memongoBridgeProbeVector,
  memongoBridgeProfile,
  memongoBridgeReadFile,
  memongoBridgeRelevanceBenchmark,
  memongoBridgeRelevanceExplain,
  memongoBridgeRelevanceReport,
  memongoBridgeRelevanceSampleRate,
  memongoBridgeSearch,
  memongoBridgeSearchKB,
  memongoBridgeStats,
  memongoBridgeStatus,
  memongoBridgeSync,
  memongoBridgeWriteConversationEvent,
  memongoBridgeWriteProcedure,
  memongoBridgeWriteStructuredMemory,
  type ProcedureEntry,
  type StructuredMemoryEntry,
} from "@romiluz/memongo/memongo-bridge";
import { jsonError } from "../lib/errors.js";

function readAgentId(body: Record<string, unknown>): string | undefined {
  return typeof body.agentId === "string" ? body.agentId : undefined;
}

export function createV1Router(): Hono {
  const v1 = new Hono();

  v1.post("/search", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "query is required");
    }
    try {
      const results = await memongoBridgeSearch({
        query,
        agentId: readAgentId(body),
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
        minScore: typeof body.minScore === "number" ? body.minScore : undefined,
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
      });
      return c.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "SEARCH_FAILED", message);
    }
  });

  v1.post("/search-kb", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "query is required");
    }
    try {
      const filter =
        typeof body.filter === "object" && body.filter !== null && !Array.isArray(body.filter)
          ? (body.filter as { tags?: string[]; category?: string; source?: string })
          : undefined;
      const results = await memongoBridgeSearchKB({
        query,
        agentId: readAgentId(body),
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
        minScore: typeof body.minScore === "number" ? body.minScore : undefined,
        filter,
      });
      return c.json({ results });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "SEARCH_KB_FAILED", message);
    }
  });

  v1.post("/read-file", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const relPath = typeof body.relPath === "string" ? body.relPath : "";
    if (!relPath.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "relPath is required");
    }
    try {
      const out = await memongoBridgeReadFile({
        relPath,
        from: typeof body.from === "number" ? body.from : undefined,
        lines: typeof body.lines === "number" ? body.lines : undefined,
        agentId: readAgentId(body),
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "READ_FILE_FAILED", message);
    }
  });

  v1.post("/add", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body.content === "string" ? body.content : "";
    if (!content.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "content is required");
    }
    const metadata =
      typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : undefined;
    try {
      const out = await memongoBridgeAdd({
        content,
        agentId: readAgentId(body),
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        metadata,
      });
      return c.json({ ok: true, eventId: out.eventId, chunkCreated: out.chunkCreated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "ADD_FAILED", message);
    }
  });

  v1.post("/write-event", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const role = body.role;
    const bodyText = typeof body.body === "string" ? body.body : "";
    if (role !== "user" && role !== "assistant" && role !== "system" && role !== "tool") {
      return jsonError(c, 400, "VALIDATION_ERROR", "role must be user|assistant|system|tool");
    }
    if (!bodyText.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "body is required");
    }
    const metadata =
      typeof body.metadata === "object" && body.metadata !== null && !Array.isArray(body.metadata)
        ? (body.metadata as Record<string, unknown>)
        : undefined;
    const scope =
      body.scope === "session" ||
      body.scope === "user" ||
      body.scope === "agent" ||
      body.scope === "workspace" ||
      body.scope === "tenant" ||
      body.scope === "global"
        ? body.scope
        : undefined;
    try {
      const out = await memongoBridgeWriteConversationEvent({
        agentId: readAgentId(body),
        role,
        body: bodyText,
        sessionId: typeof body.sessionId === "string" ? body.sessionId : undefined,
        timestamp: typeof body.timestamp === "string" ? body.timestamp : undefined,
        metadata,
        scope,
      });
      return c.json({ ok: true, eventId: out.eventId, chunkCreated: out.chunkCreated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "WRITE_EVENT_FAILED", message);
    }
  });

  v1.post("/write-structured", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const entry = body.entry;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return jsonError(c, 400, "VALIDATION_ERROR", "entry object is required");
    }
    try {
      const out = await memongoBridgeWriteStructuredMemory({
        agentId: readAgentId(body),
        entry: entry as StructuredMemoryEntry,
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "WRITE_STRUCTURED_FAILED", message);
    }
  });

  v1.post("/write-procedure", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const entry = body.entry;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return jsonError(c, 400, "VALIDATION_ERROR", "entry object is required");
    }
    try {
      const out = await memongoBridgeWriteProcedure({
        agentId: readAgentId(body),
        entry: entry as ProcedureEntry,
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "WRITE_PROCEDURE_FAILED", message);
    }
  });

  v1.post("/profile", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const profile = await memongoBridgeProfile({
        agentId: readAgentId(body),
        scopeRef: typeof body.scopeRef === "string" ? body.scopeRef : undefined,
        maxEntities: typeof body.maxEntities === "number" ? body.maxEntities : undefined,
        maxEpisodes: typeof body.maxEpisodes === "number" ? body.maxEpisodes : undefined,
        maxPerType: typeof body.maxPerType === "number" ? body.maxPerType : undefined,
        activityWindowMs:
          typeof body.activityWindowMs === "number" ? body.activityWindowMs : undefined,
      });
      return c.json(profile);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "PROFILE_FAILED", message);
    }
  });

  v1.get("/status", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const status = await memongoBridgeStatus({ agentId });
      return c.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "STATUS_FAILED", message);
    }
  });

  v1.get("/status/detailed", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const status = await memongoBridgeGetDetailedStatus({ agentId });
      return c.json(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "DETAILED_STATUS_FAILED", message);
    }
  });

  v1.get("/stats", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const stats = await memongoBridgeStats({ agentId });
      return c.json(stats);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "STATS_FAILED", message);
    }
  });

  v1.post("/sync", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      await memongoBridgeSync({
        agentId: readAgentId(body),
        reason: typeof body.reason === "string" ? body.reason : undefined,
        force: typeof body.force === "boolean" ? body.force : undefined,
      });
      return c.json({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "SYNC_FAILED", message);
    }
  });

  v1.get("/probes/embedding", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const result = await memongoBridgeProbeEmbedding({ agentId });
      return c.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "PROBE_EMBEDDING_FAILED", message);
    }
  });

  v1.get("/probes/vector", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const ok = await memongoBridgeProbeVector({ agentId });
      return c.json({ ok });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "PROBE_VECTOR_FAILED", message);
    }
  });

  v1.post("/admin/relevance/explain", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const query = typeof body.query === "string" ? body.query : "";
    if (!query.trim()) {
      return jsonError(c, 400, "VALIDATION_ERROR", "query is required");
    }
    const sourceScope =
      body.sourceScope === "all" ||
      body.sourceScope === "memory" ||
      body.sourceScope === "kb" ||
      body.sourceScope === "structured"
        ? body.sourceScope
        : undefined;
    try {
      const out = await memongoBridgeRelevanceExplain({
        agentId: readAgentId(body),
        query,
        sourceScope,
        sessionKey: typeof body.sessionKey === "string" ? body.sessionKey : undefined,
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
        minScore: typeof body.minScore === "number" ? body.minScore : undefined,
        deep: typeof body.deep === "boolean" ? body.deep : undefined,
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "RELEVANCE_EXPLAIN_FAILED", message);
    }
  });

  v1.post("/admin/relevance/benchmark", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    try {
      const out = await memongoBridgeRelevanceBenchmark({
        agentId: readAgentId(body),
        datasetPath: typeof body.datasetPath === "string" ? body.datasetPath : undefined,
        maxResults: typeof body.maxResults === "number" ? body.maxResults : undefined,
        minScore: typeof body.minScore === "number" ? body.minScore : undefined,
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "RELEVANCE_BENCHMARK_FAILED", message);
    }
  });

  v1.get("/admin/relevance/report", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    const windowMsRaw = c.req.query("windowMs");
    const windowMs = windowMsRaw ? Number(windowMsRaw) : undefined;
    try {
      const out = await memongoBridgeRelevanceReport({
        agentId,
        windowMs: Number.isFinite(windowMs) ? windowMs : undefined,
      });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "RELEVANCE_REPORT_FAILED", message);
    }
  });

  v1.get("/admin/relevance/sample-rate", async (c) => {
    const agentId = c.req.query("agentId") ?? undefined;
    try {
      const out = await memongoBridgeRelevanceSampleRate({ agentId });
      return c.json(out);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return jsonError(c, 500, "RELEVANCE_SAMPLE_RATE_FAILED", message);
    }
  });

  return v1;
}

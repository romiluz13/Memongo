import type { MemongoAddInput, MemongoProfileInput, MemongoSearchInput } from "./types.js";

export type MemongoClientOptions = {
  /** Memongo API base URL (e.g. http://127.0.0.1:3847). */
  baseUrl?: string;
  /** Optional Bearer token; also reads `MEMONGO_API_KEY` when unset. */
  apiKey?: string;
  /** Max retries for 429/503 (default 2). */
  maxRetries?: number;
};

/** Thrown when the Memongo HTTP API returns a non-OK status. */
export class MemongoClientError extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `Memongo API ${status}: ${body || "(empty)"}`);
    this.name = "MemongoClientError";
    this.status = status;
    this.body = body;
  }
}

function resolveBaseUrl(opts: MemongoClientOptions): string {
  const raw = opts.baseUrl ?? process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847";
  return raw.replace(/\/$/, "");
}

function resolveApiKey(opts: MemongoClientOptions): string | undefined {
  return opts.apiKey ?? process.env.MEMONGO_API_KEY ?? undefined;
}

function shouldRetryStatus(status: number): boolean {
  return status === 429 || status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function buildHeaders(opts: MemongoClientOptions, method: string): Record<string, string> {
  const key = resolveApiKey(opts);
  const headers: Record<string, string> = {};
  if (key) {
    headers.Authorization = `Bearer ${key}`;
  }
  if (method !== "GET" && method !== "HEAD") {
    headers["Content-Type"] = "application/json";
  }
  return headers;
}

async function apiFetch<T>(
  opts: MemongoClientOptions,
  path: string,
  init: RequestInit,
): Promise<T> {
  const url = `${resolveBaseUrl(opts)}${path}`;
  const method = (init.method ?? "GET").toUpperCase();
  const maxRetries = opts.maxRetries ?? 2;
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, {
      ...init,
      headers: { ...buildHeaders(opts, method), ...init.headers },
    });
    if (res.ok) {
      return (await res.json()) as T;
    }
    const text = await res.text();
    if (shouldRetryStatus(res.status) && attempt < maxRetries) {
      attempt += 1;
      await sleep(200 * attempt);
      continue;
    }
    throw new MemongoClientError(res.status, text);
  }
}

async function apiPost<T>(
  opts: MemongoClientOptions,
  path: string,
  body: Record<string, unknown>,
): Promise<T> {
  return apiFetch<T>(opts, path, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function apiGet<T>(opts: MemongoClientOptions, path: string): Promise<T> {
  return apiFetch<T>(opts, path, { method: "GET" });
}

function q(agentId?: string, extra?: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  if (agentId) {
    p.set("agentId", agentId);
  }
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined && v !== "") {
        p.set(k, String(v));
      }
    }
  }
  const s = p.toString();
  return s ? `?${s}` : "";
}

/**
 * HTTP client for the Memongo API (`memongo-platform/apps/api`), shaped like familiar memory SDKs.
 */
export class MemongoClient {
  constructor(private readonly _opts: MemongoClientOptions = {}) {}

  async add(input: MemongoAddInput): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
    return apiPost(this._opts, "/v1/add", {
      content: input.content,
      agentId: input.agentId,
      sessionId: input.sessionId ?? input.containerTag,
      metadata: normalizeMetadata(input.metadata),
    });
  }

  async search(
    input: MemongoSearchInput & { agentId?: string; minScore?: number; sessionKey?: string },
  ): Promise<{ results: unknown[] }> {
    return apiPost(this._opts, "/v1/search", {
      query: input.query,
      agentId: input.agentId,
      maxResults: input.limit,
      minScore: input.minScore,
      sessionKey: input.containerTag ?? input.sessionKey,
    });
  }

  async searchKB(input: {
    query: string;
    agentId?: string;
    limit?: number;
    minScore?: number;
    filter?: { tags?: string[]; category?: string; source?: string };
  }): Promise<{ results: unknown[] }> {
    return apiPost(this._opts, "/v1/search-kb", {
      query: input.query,
      agentId: input.agentId,
      maxResults: input.limit,
      minScore: input.minScore,
      filter: input.filter,
    });
  }

  async readFile(input: {
    relPath: string;
    from?: number;
    lines?: number;
    agentId?: string;
  }): Promise<unknown> {
    return apiPost(this._opts, "/v1/read-file", {
      relPath: input.relPath,
      from: input.from,
      lines: input.lines,
      agentId: input.agentId,
    });
  }

  async writeEvent(input: {
    role: "user" | "assistant" | "system" | "tool";
    body: string;
    agentId?: string;
    sessionId?: string;
    timestamp?: string;
    metadata?: Record<string, unknown>;
    scope?: string;
  }): Promise<{ ok: true; eventId: string; chunkCreated: boolean }> {
    return apiPost(this._opts, "/v1/write-event", {
      role: input.role,
      body: input.body,
      agentId: input.agentId,
      sessionId: input.sessionId,
      timestamp: input.timestamp,
      metadata: input.metadata,
      scope: input.scope,
    });
  }

  async writeStructured(input: {
    entry: Record<string, unknown>;
    agentId?: string;
  }): Promise<{ upserted: boolean; id: string }> {
    return apiPost(this._opts, "/v1/write-structured", {
      entry: input.entry,
      agentId: input.agentId,
    });
  }

  async writeProcedure(input: {
    entry: Record<string, unknown>;
    agentId?: string;
  }): Promise<{ upserted: boolean; id: string }> {
    return apiPost(this._opts, "/v1/write-procedure", {
      entry: input.entry,
      agentId: input.agentId,
    });
  }

  async profile(
    input: MemongoProfileInput & {
      agentId?: string;
      scopeRef?: string;
      maxEntities?: number;
      maxEpisodes?: number;
      maxPerType?: number;
      activityWindowMs?: number;
    } = {},
  ): Promise<Record<string, unknown>> {
    return apiPost(this._opts, "/v1/profile", {
      agentId: input.agentId,
      scopeRef: input.scopeRef ?? input.containerTag,
      maxEntities: input.maxEntities,
      maxEpisodes: input.maxEpisodes,
      maxPerType: input.maxPerType,
      activityWindowMs: input.activityWindowMs,
    });
  }

  async status(agentId?: string): Promise<unknown> {
    return apiGet(this._opts, `/v1/status${q(agentId)}`);
  }

  async getDetailedStatus(agentId?: string): Promise<unknown> {
    return apiGet(this._opts, `/v1/status/detailed${q(agentId)}`);
  }

  async stats(agentId?: string): Promise<unknown> {
    return apiGet(this._opts, `/v1/stats${q(agentId)}`);
  }

  async sync(input?: {
    agentId?: string;
    reason?: string;
    force?: boolean;
  }): Promise<{ ok: true }> {
    return apiPost(this._opts, "/v1/sync", {
      agentId: input?.agentId,
      reason: input?.reason,
      force: input?.force,
    });
  }

  async probeEmbedding(agentId?: string): Promise<unknown> {
    return apiGet(this._opts, `/v1/probes/embedding${q(agentId)}`);
  }

  async probeVector(agentId?: string): Promise<{ ok: boolean }> {
    return apiGet(this._opts, `/v1/probes/vector${q(agentId)}`);
  }

  async relevanceExplain(input: {
    query: string;
    agentId?: string;
    sourceScope?: "all" | "memory" | "kb" | "structured";
    sessionKey?: string;
    maxResults?: number;
    minScore?: number;
    deep?: boolean;
  }): Promise<unknown> {
    return apiPost(this._opts, "/v1/admin/relevance/explain", {
      query: input.query,
      agentId: input.agentId,
      sourceScope: input.sourceScope,
      sessionKey: input.sessionKey,
      maxResults: input.maxResults,
      minScore: input.minScore,
      deep: input.deep,
    });
  }

  async relevanceBenchmark(input?: {
    agentId?: string;
    datasetPath?: string;
    maxResults?: number;
    minScore?: number;
  }): Promise<unknown> {
    return apiPost(this._opts, "/v1/admin/relevance/benchmark", {
      agentId: input?.agentId,
      datasetPath: input?.datasetPath,
      maxResults: input?.maxResults,
      minScore: input?.minScore,
    });
  }

  async relevanceReport(agentId?: string, windowMs?: number): Promise<unknown> {
    return apiGet(this._opts, `/v1/admin/relevance/report${q(agentId, { windowMs })}`);
  }

  async relevanceSampleRate(agentId?: string): Promise<unknown> {
    return apiGet(this._opts, `/v1/admin/relevance/sample-rate${q(agentId)}`);
  }
}

function normalizeMetadata(meta: MemongoAddInput["metadata"]): Record<string, unknown> | undefined {
  if (!meta) {
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    out[k] = v;
  }
  return out;
}

/**
 * Live E2E stress against memongo-api: real HTTP, no mocks.
 * Start the API with a Mongo URI that actually connects. If ~/.openclaw already sets
 * memory.mongodb.uri, use MEMONGO_FORCE_MONGODB_URI on the API process to point at your test DB.
 *
 * Usage (from repo root or memongo-platform):
 *   MEMONGO_FORCE_MONGODB_URI=mongodb://127.0.0.1:27018/openclaw?directConnection=true \
 *   MEMONGO_API_URL=http://127.0.0.1:3847 \
 *   MEMONGO_API_KEY=optional \
 *   bun memongo-platform/scripts/stress-live.ts
 *
 * Env:
 *   STRESS_MESSAGES=500   (total user+assistant pairs)
 *   STRESS_CONCURRENCY=10 (parallel writers)
 *   STRESS_SEARCHES=50    (verification searches after ingest)
 */
const baseUrl = (process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847").replace(/\/$/, "");
const apiKey = process.env.MEMONGO_API_KEY?.trim();

const totalPairs = Math.max(1, Number(process.env.STRESS_MESSAGES ?? "200"));
const concurrency = Math.max(1, Math.min(64, Number(process.env.STRESS_CONCURRENCY ?? "8")));
const searchCount = Math.max(1, Number(process.env.STRESS_SEARCHES ?? "40"));

const marker = `stress-${Date.now()}`;

function headers(json: boolean): Record<string, string> {
  const h: Record<string, string> = {};
  if (json) {
    h["Content-Type"] = "application/json";
  }
  if (apiKey) {
    h.Authorization = `Bearer ${apiKey}`;
  }
  return h;
}

async function health(): Promise<boolean> {
  const res = await fetch(`${baseUrl}/health`, { headers: headers(false) });
  return res.ok;
}

async function postJson<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; json: T | null; text: string }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: headers(true),
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: T | null = null;
  try {
    json = JSON.parse(text) as T;
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

async function postSearch(
  query: string,
): Promise<{ ok: boolean; status: number; hitCount: number }> {
  const r = await postJson<{ results?: unknown[] }>("/v1/search", { query, maxResults: 20 });
  const results = r.json?.results;
  const hitCount = Array.isArray(results) ? results.length : 0;
  return { ok: r.ok, status: r.status, hitCount };
}

async function writePair(seq: number): Promise<{ ok: boolean; status: number }> {
  const u = await postJson("/v1/write-event", {
    role: "user",
    body: `${marker} user seq=${seq} unique=${Math.random().toString(36).slice(2)}`,
  });
  if (!u.ok) {
    return { ok: false, status: u.status };
  }
  const a = await postJson("/v1/write-event", {
    role: "assistant",
    body: `${marker} assistant reply seq=${seq} fact=omega-${seq}`,
  });
  return { ok: a.ok, status: a.status };
}

async function runPool<T>(items: number[], fn: (item: number) => Promise<T>): Promise<T[]> {
  const out: T[] = Array.from({ length: items.length }, () => undefined as T);
  const cursor = { n: 0 };
  async function worker(): Promise<void> {
    for (;;) {
      const slot = cursor.n++;
      if (slot >= items.length) {
        return;
      }
      const item = items[slot];
      if (item === undefined) {
        return;
      }
      out[slot] = await fn(item);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}

async function main(): Promise<void> {
  console.error(
    `[stress-live] baseUrl=${baseUrl} pairs=${totalPairs} concurrency=${concurrency} marker=${marker}`,
  );
  if (!(await health())) {
    console.error("[stress-live] FAIL: /health not OK. Is memongo-api running?");
    process.exitCode = 1;
    return;
  }
  const t0 = Date.now();
  const indices = Array.from({ length: totalPairs }, (_, i) => i + 1);
  const writes = await runPool(indices, (seq) => writePair(seq));
  const writeMs = Date.now() - t0;
  const writeFail = writes.filter((w) => !w.ok).length;
  console.error(`[stress-live] writes: ${writes.length} pairs in ${writeMs}ms failed=${writeFail}`);
  if (writeFail > 0) {
    const sample = writes.find((w) => !w.ok);
    console.error("[stress-live] sample failure status:", sample?.status);
    process.exitCode = 1;
  }

  const needle = `${marker} fact=omega-${totalPairs}`;
  const t1 = Date.now();
  const verify = await postSearch(needle);
  const verifyMs = Date.now() - t1;
  console.error(
    `[stress-live] verify search "${needle.slice(0, 48)}..." ok=${verify.ok} status=${verify.status} hits=${verify.hitCount} ${verifyMs}ms`,
  );

  const t2 = Date.now();
  const searchIdx = Array.from({ length: searchCount }, (_, i) => i);
  const searches = await runPool(searchIdx, async (i) => {
    const q = `${marker} omega-${(i % totalPairs) + 1}`;
    return postSearch(q);
  });
  const searchMs = Date.now() - t2;
  const searchFail = searches.filter((s) => !s.ok).length;
  const totalHits = searches.reduce((a, s) => a + s.hitCount, 0);
  console.error(
    `[stress-live] random searches: ${searches.length} in ${searchMs}ms failed=${searchFail} totalHits=${totalHits}`,
  );

  const t3 = Date.now();
  const prof = await postJson("/v1/profile", { maxEntities: 5, maxEpisodes: 3 });
  console.error(`[stress-live] profile: ok=${prof.ok} status=${prof.status} ${Date.now() - t3}ms`);

  const stats = await fetch(`${baseUrl}/v1/stats`, { headers: headers(false) });
  const statsText = await stats.text();
  console.error(`[stress-live] stats: ${stats.status} len=${statsText.length}`);

  if (!verify.ok || verify.hitCount === 0) {
    console.error(
      "[stress-live] FAIL: verification search did not return hits (memory may need embeddings/mongot).",
    );
    process.exitCode = 1;
  }
  if (searchFail > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

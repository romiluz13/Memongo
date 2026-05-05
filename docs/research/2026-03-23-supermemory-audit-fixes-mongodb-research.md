# SuperMemory Audit Fixes - MongoDB Official Documentation Research

> Research date: 2026-03-23
> Researcher: MongoDB Documentation Research Agent
> All URLs verified by scraping mongodb.com official documentation pages

---

## C1. Score Normalization Across Different Search Methods

### Problem

`searchV2()` merges results from `$vectorSearch` (scores 0-1), `$search`/BM25 (scores 0-infinity), structured memory (synthetic scores ~0.85), and episodes (synthetic scores). These incompatible score ranges make naive score merging unreliable.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/
  - Confirms: "MongoDB Vector Search assigns a score, in a fixed range from `0` to `1` (where `0` indicates low similarity and `1` indicates high similarity)"
- URL: https://www.mongodb.com/docs/atlas/atlas-search/scoring/
  - Confirms: `$search` scores are unbounded (Lucene TF-IDF based, range 0 to infinity)
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/
  - Version: MongoDB 8.0+
  - `$rankFusion` uses Reciprocal Rank Fusion (RRF) with formula: `sum of weight * (1 / (60 + rank))` across input pipelines. Sensitivity parameter is 60.
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/
  - Version: MongoDB 8.2+
  - `$scoreFusion` provides score-based fusion with built-in normalization options: `none`, `sigmoid`, `minMaxScaler`
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/score/
  - Version: MongoDB 8.2+
  - `$score` stage can normalize scores with `sigmoid` or `minMaxScaler`, and apply weights

### Official Pattern / Syntax

**$rankFusion (rank-based, no score normalization needed):**

```javascript
{
  $rankFusion: {
    input: {
      pipelines: {
        vectorPipeline: [{ $vectorSearch: { ... } }],
        textPipeline: [{ $search: { ... } }, { $limit: 20 }]
      }
    },
    combination: {
      weights: { vectorPipeline: 0.7, textPipeline: 0.3 }
    }
  }
}
```

**$scoreFusion (score-based with normalization):**

```javascript
{
  $scoreFusion: {
    input: {
      pipelines: {
        vectorPipeline: [{ $vectorSearch: { ... } }],
        textPipeline: [{ $search: { ... } }, { $limit: 20 }]
      },
      normalization: "sigmoid"  // or "minMaxScaler"
    },
    combination: {
      weights: { vectorPipeline: 0.7, textPipeline: 0.3 },
      method: "avg"
    }
  }
}
```

**$score stage (normalize individual pipeline scores):**

```javascript
{
  $score: {
    score: { $meta: "vectorSearchScore" },
    normalization: "sigmoid",
    weight: 0.8
  }
}
```

### Recommendations for Memongo

1. **Immediate (no version dependency):** Implement manual RRF in `mongodb-hybrid.ts` using the official formula: `score = sum(weight_i / (60 + rank_i))`. This eliminates the score range problem entirely by using ranks instead of scores.
2. **For MongoDB 8.0+:** Migrate to `$rankFusion` as the server-side hybrid search stage. It handles de-duplication and weighted rank fusion natively.
3. **For MongoDB 8.2+:** Consider `$scoreFusion` with `normalization: "sigmoid"` for score-aware fusion that preserves score magnitude differences.
4. **For synthetic scores (structured memory, episodes):** Use `$score` stage with `normalization: "sigmoid"` to bring them into a 0-1 range before merging with vector search results.
5. **Stop merging raw scores from different search methods.** Either use rank-based fusion (RRF) or normalize all scores to 0-1 first.

### Caveats / Limitations

- `$rankFusion` and `$scoreFusion` are **Preview features** as of MongoDB 8.2
- `$rankFusion` requires MongoDB 8.0+; `$scoreFusion` requires MongoDB 8.2+
- Both stages operate on a **single collection only**
- Both stages require input pipelines to be "Selection Pipelines" (no document modification after retrieval)
- `$vectorSearch` cannot be inside a `$lookup` sub-pipeline or `$facet`
- For Memongo's multi-source merging (different collections), manual RRF remains necessary

---

## C2. synthesizeProfile $facet Performance

### Problem

Uses correlated `$lookup` with `$expr` + `$or` inside entity aggregation. The `$facet` stage also has known performance limitations.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/
  - Correlated subquery performance: "operations that contain correlated subqueries perform better when the following conditions apply: The foreign collection contains an index on the foreignField"
  - Index usage in correlated `$lookup`: The `$match` stage within a `$lookup` pipeline that uses `$expr` can use indexes for equality matches only. It cannot use indexes for range queries or `$or` operators within `$expr`.
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/facet/
  - Hard limit: "each stage in a $facet executes, the resulting document is limited to 100 megabytes. Note the allowDiskUse flag doesn't affect the 100 megabyte size limit"

### Official Pattern / Syntax

**Correlated $lookup with index usage:**

```javascript
// This CAN use indexes (equality only):
{
  $lookup: {
    from: "relations",
    let: { entityId: "$_id" },
    pipeline: [
      { $match: { $expr: { $eq: ["$fromEntityId", "$$entityId"] } } }
    ],
    as: "outgoing"
  }
}

// This CANNOT use indexes ($or inside $expr):
{
  $lookup: {
    from: "relations",
    let: { entityId: "$_id" },
    pipeline: [
      { $match: {
        $expr: {
          $or: [
            { $eq: ["$fromEntityId", "$$entityId"] },
            { $eq: ["$toEntityId", "$$entityId"] }
          ]
        }
      }}
    ],
    as: "relations"
  }
}
```

### Recommendations for Memongo

1. **Replace `$or` in correlated `$lookup` with two separate `$lookup` stages.** Do one lookup for `fromEntityId` matches and one for `toEntityId` matches, then merge results. Each can use its own index.
2. **Alternative: Use `$unionWith` + `$group`** to combine results from two separate indexed queries instead of a single `$or`.
3. **For the `$facet` issue:** Be aware of the 100MB hard limit per facet. For profile synthesis with many entities, consider breaking the aggregation into multiple smaller pipelines.
4. **Add compound indexes** on `(fromEntityId, scope)` and `(toEntityId, scope)` for the relations collection.

### Caveats / Limitations

- `$facet` has a 100 MB output limit that `allowDiskUse` does NOT override
- `$expr` within `$lookup` pipeline only uses indexes for `$eq` comparisons, NOT for `$or`, `$and`, ranges, or complex expressions
- Each sub-pipeline inside `$facet` processes the full input dataset independently

---

## C3. Missing Fetch Timeout on External API Calls

### Problem

External API calls (e.g., to embedding services) lack timeout configuration.

### MongoDB Documentation Source

- URL: https://www.mongodb.com/docs/manual/administration/production-checklist-development/
  - MongoDB's development checklist recommends setting appropriate timeouts for all operations
- URL: https://www.mongodb.com/docs/drivers/node/current/fundamentals/connection/connection-options/
  - Driver-level: `serverSelectionTimeoutMS`, `connectTimeoutMS`, `socketTimeoutMS`

### Official Pattern / Syntax

MongoDB documentation focuses on database connection timeouts, not external HTTP call timeouts. However, the general principle from the production checklist applies: always set timeouts.

### Recommendations for Memongo

1. **Not a MongoDB-specific issue.** Use Node.js `AbortController` with `setTimeout` on all `fetch()` calls to embedding/reranker APIs.
2. **Pattern:**

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout
try {
  const response = await fetch(url, { signal: controller.signal });
} finally {
  clearTimeout(timeout);
}
```

3. Make the timeout configurable per source in the memory config.

### Caveats / Limitations

- No MongoDB-specific documentation for this; it is a general application-level concern

---

## H1. bulkWrite for Entity Upserts (N+1 Problem)

### Problem

Currently uses sequential `upsertEntity()` calls (N round-trips to the database). Should use `bulkWrite` to batch.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/core/bulk-write-operations/
  - "MongoDB provides clients the ability to perform write operations in bulk"
  - "Unordered operations continue despite errors and may execute in parallel, making them typically faster"
- URL: https://www.mongodb.com/docs/manual/reference/method/db.collection.bulkWrite/
  - Supports: `insertOne`, `updateOne`, `updateMany`, `replaceOne`, `deleteOne`, `deleteMany`
- URL: https://www.mongodb.com/docs/manual/reference/command/bulkwrite/
  - Version: MongoDB 8.0+ for cross-collection bulkWrite command

### Official Pattern / Syntax

```javascript
db.entities.bulkWrite(
  [
    {
      updateOne: {
        filter: { name: "Entity1", scope: "agent123" },
        update: {
          $set: { type: "PERSON", updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    },
    {
      updateOne: {
        filter: { name: "Entity2", scope: "agent123" },
        update: {
          $set: { type: "ORGANIZATION", updatedAt: new Date() },
          $setOnInsert: { createdAt: new Date() },
        },
        upsert: true,
      },
    },
  ],
  { ordered: false },
);
```

### Recommendations for Memongo

1. **Replace sequential `upsertEntity()` loops with a single `bulkWrite()` call using `ordered: false`** for maximum throughput.
2. **Use `updateOne` with `upsert: true`** for each entity in the bulk array.
3. **Use `$setOnInsert` for fields that should only be set on creation** (e.g., `createdAt`), and `$set` for fields updated on every write.
4. **Error handling:** With `ordered: false`, some operations may succeed even if others fail. Check `bulkWriteResult.getWriteErrors()` for partial failures.

### Caveats / Limitations

- `bulkWrite()` on a single collection is available in all MongoDB versions
- Cross-collection `bulkWrite` command requires MongoDB 8.0+
- `ordered: false` may reorder operations for performance; do not depend on execution order
- Maximum document size limits still apply per operation

---

## H2. Change Streams for Async Entity Enrichment

### Problem

Want to use Change Streams to trigger LLM extraction after event writes.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/changeStreams/
  - Change streams allow applications to access real-time data changes
  - Can use `resumeAfter` or `startAfter` with resume tokens
  - Support pipeline filtering with `$match`
  - Require a replica set or sharded cluster (atlas-local includes a single-node replica set)
- URL: https://www.mongodb.com/docs/manual/administration/change-streams-production-recommendations/
  - "Change streams cannot use indexes"
  - "avoid opening a high number of specifically-targeted change streams as these can impact server performance"
  - Response documents must adhere to 16MB BSON limit
  - Resume tokens can become invalid if oplog rotates

### Official Pattern / Syntax

```javascript
// Watch for inserts on the events collection with filtering
const pipeline = [
  {
    $match: {
      operationType: "insert",
      "fullDocument.type": { $in: ["message", "tool_result"] },
    },
  },
];

const changeStream = db.collection("events").watch(pipeline, {
  fullDocument: "updateLookup",
  resumeAfter: lastResumeToken, // for crash recovery
});

changeStream.on("change", async (event) => {
  const resumeToken = event._id;
  // Process the event
  await enrichEntity(event.fullDocument);
  // Persist resume token for crash recovery
  await saveResumeToken(resumeToken);
});

changeStream.on("error", (err) => {
  // ChangeStreamFatalError (280) means resume token expired
  if (err.code === 280) {
    // Must restart from beginning or a known checkpoint
  }
});
```

### Recommendations for Memongo

1. **Use `watch()` with a `$match` pipeline** filtering for `operationType: "insert"` to avoid processing updates/deletes.
2. **Persist resume tokens** to a dedicated collection (e.g., `change_stream_checkpoints`) for crash recovery.
3. **Handle `ChangeStreamFatalError` (code 280)** by restarting the stream without a resume token and replaying from the earliest available oplog entry.
4. **Atlas-local supports Change Streams** since it runs a single-node replica set.
5. **Limit the number of concurrent change streams** to avoid performance impact.

### Caveats / Limitations

- Change streams cannot use indexes (they read the oplog)
- Resume tokens expire when the oplog rotates (depends on oplog size)
- 16MB BSON document limit applies to change events
- Opening too many change streams impacts server performance
- If a collection is dropped or renamed, the change stream cursor closes

---

## H3. Vector Search Pre-Filtering with Entity Metadata

### Problem

Want to filter `$vectorSearch` by entity type metadata.

### MongoDB Documentation Source

- URL: https://www.mongodb.com/docs/atlas/atlas-vector-search/vector-search-stage/
  - Pre-filtering supported with MQL operators: `$eq`, `$ne`, `$gt`, `$lt`, `$gte`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$nor`, `$and`, `$or`
  - "You must index the fields that you want to filter your data by as the `filter` type in a vectorSearch type index definition"
  - "Pre-filtering your data doesn't affect the score that MongoDB Vector Search returns"

### Official Pattern / Syntax

**Vector search index definition (must include filter fields):**

```json
{
  "fields": [
    {
      "type": "vector",
      "path": "embedding",
      "numDimensions": 1024,
      "similarity": "cosine"
    },
    {
      "type": "filter",
      "path": "entityType"
    },
    {
      "type": "filter",
      "path": "scope"
    }
  ]
}
```

**Query with pre-filter:**

```javascript
{
  $vectorSearch: {
    index: "vector_index",
    path: "embedding",
    queryVector: queryEmbedding,
    numCandidates: 100,
    limit: 10,
    filter: {
      $and: [
        { entityType: { $in: ["PERSON", "ORGANIZATION"] } },
        { scope: "agent123" }
      ]
    }
  }
}
```

### Recommendations for Memongo

1. **Add `filter` type fields to the vector search index definition** for `entityType`, `scope`, `source`, and any other metadata fields used for filtering.
2. **Use the `filter` parameter in `$vectorSearch`** instead of post-filtering with `$match` for better performance (pre-filter reduces the candidate set before vector comparison).
3. **Pre-filtering does NOT affect vector search scores** -- this is confirmed in the docs.

### Caveats / Limitations

- Filter fields MUST be declared as `type: "filter"` in the vector search index definition
- `$vectorSearch` filter does NOT support `$regex`, `$text`, or aggregation pipeline operators
- Only supports specific MQL operators listed above
- Cannot use `$vectorSearch` inside `$facet` or `$lookup` sub-pipeline

---

## H4. Cache TTL Derivation from Query Source

### Problem

Need variable TTL per cached document based on query source type.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/tutorial/expire-data/
  - Two patterns: fixed TTL via `expireAfterSeconds`, or per-document TTL via `expireAfterSeconds: 0` with a date field
- URL: https://www.mongodb.com/docs/manual/core/index-ttl/
  - "TTL indexes expire documents after the specified number of seconds has passed since the indexed field value"
  - "The TTL index is a single field index. Compound indexes do not support the TTL property"

### Official Pattern / Syntax

**Pattern 1: Fixed TTL (same expiration for all documents):**

```javascript
db.cache.createIndex({ createdAt: 1 }, { expireAfterSeconds: 3600 });
```

**Pattern 2: Per-document variable TTL (set `expireAfterSeconds: 0`):**

```javascript
// Create index with expireAfterSeconds: 0
db.cache.createIndex({ "expiresAt": 1 }, { expireAfterSeconds: 0 })

// Each document sets its own expiration time
db.cache.insertOne({
  queryHash: "abc123",
  source: "vector",
  result: { ... },
  expiresAt: new Date(Date.now() + 5 * 60 * 1000)  // 5 min for vector
})

db.cache.insertOne({
  queryHash: "def456",
  source: "structured",
  result: { ... },
  expiresAt: new Date(Date.now() + 30 * 60 * 1000)  // 30 min for structured
})
```

**Pattern 3: Partial TTL index with filter conditions:**

```javascript
// Only expire documents where type is "cache"
db.memory.createIndex(
  { expiresAt: 1 },
  {
    expireAfterSeconds: 0,
    partialFilterExpression: { type: "cache" },
  },
);
```

### Recommendations for Memongo

1. **Use Pattern 2 (per-document TTL) with `expireAfterSeconds: 0`** and an `expiresAt` date field.
2. **Compute `expiresAt` at write time** based on the query source:
   - Vector search cache: 5 minutes
   - Structured memory cache: 30 minutes
   - Episode cache: 1 hour
   - Profile cache: 15 minutes
3. **Use a partial TTL index** if the cache collection also holds non-expiring documents.
4. **The `expiresAt` field must be a BSON date type**, not a Unix timestamp number.

### Caveats / Limitations

- TTL indexes are **single field only** -- cannot be compound indexes
- TTL background thread runs every 60 seconds, so documents may persist briefly past their expiration
- `expireAfterSeconds` must be between 0 and 2147483647 inclusive
- `allowDiskUse` does not affect TTL behavior
- TTL index with `NaN` as `expireAfterSeconds` can cause data loss (documented bug in 5.0-6.0)

---

## H5. Empty/Blank Document Handling in Reranking

### Problem

When sending documents to an external reranker, some may be empty graph relation strings.

### MongoDB Documentation Source

- No specific MongoDB documentation for handling empty text in search/rerank pipelines. This is an application-level concern.

### Recommendations for Memongo

1. **Filter out empty/blank documents before sending to the reranker.** Add a `$match` stage or application-level filter:

```javascript
// Server-side filtering in aggregation
{ $match: { text: { $exists: true, $ne: "", $type: "string" } } }
```

2. **Alternatively, use `$addFields` to provide a fallback text** for empty documents:

```javascript
{
  $addFields: {
    rerank_text: {
      $cond: {
        if: { $or: [
          { $eq: ["$text", ""] },
          { $eq: ["$text", null] },
          { $not: "$text" }
        ]},
        then: "$fallback_field",
        else: "$text"
      }
    }
  }
}
```

3. For graph relations, construct a meaningful text representation like `"[entityA] --[relationType]--> [entityB]"` instead of sending raw empty strings.

### Caveats / Limitations

- No MongoDB-specific guidance; this is application logic
- External reranker APIs may reject or error on empty strings

---

## M1. $percentile Aggregation Operator

### Problem

Currently computing percentiles client-side by loading all values into memory.

### MongoDB Documentation Source

- URL: https://www.mongodb.com/docs/v7.0/reference/operator/aggregation/percentile/
- Version: **New in MongoDB 7.0**

### Official Pattern / Syntax

```javascript
// Syntax
{
  $percentile: {
    input: <expression>,        // field or expression evaluating to numeric
    p: [ 0.5, 0.75, 0.95 ],   // percentile values (0.0 to 1.0)
    method: "approximate"       // required, only "approximate" supported
  }
}

// Usage in $group
db.telemetry.aggregate([
  {
    $group: {
      _id: "$metricName",
      p50: {
        $percentile: {
          input: "$latencyMs",
          p: [0.5],
          method: "approximate"
        }
      },
      p95: {
        $percentile: {
          input: "$latencyMs",
          p: [0.95],
          method: "approximate"
        }
      },
      p99: {
        $percentile: {
          input: "$latencyMs",
          p: [0.99],
          method: "approximate"
        }
      }
    }
  }
])

// Can also be used in $project (per-document) and $setWindowFields (window)
```

### Recommendations for Memongo

1. **Replace all client-side percentile calculations with `$percentile`** in the aggregation pipeline.
2. **Use in `$group` stage** for computing percentiles across all telemetry documents.
3. **Use in `$setWindowFields`** for rolling percentiles over time windows.
4. **Combine with `$avg`, `$stdDevPop`** in the same `$group` for complete statistical summaries.

### Caveats / Limitations

- Method must be `"approximate"` -- there is no exact calculation option
- Uses t-digest algorithm; results may vary slightly between runs
- Non-numeric values are silently ignored
- Returns `null` if no numeric values are found
- Available since MongoDB 7.0 (atlas-local 8.2 includes this)
- `$percentile` returns the minimum for `p = 0.0` and maximum for `p = 1.0`

---

## M2. Unbounded getEventsByTimeRange

### Problem

Time-range queries without limits could return unbounded result sets.

### MongoDB Documentation Source

- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/limit/
  - `$limit` takes a positive integer that specifies the maximum number of documents to pass along
- URL: https://www.mongodb.com/docs/manual/tutorial/query-documents/
  - Best practice: always use `.limit()` with `.sort()` for range queries

### Official Pattern / Syntax

```javascript
// Always add $limit after time-range $match
db.events.aggregate([
  {
    $match: {
      timestamp: {
        $gte: ISODate("2026-03-01"),
        $lte: ISODate("2026-03-23"),
      },
      scope: "agent123",
    },
  },
  { $sort: { timestamp: -1 } },
  { $limit: 1000 }, // Always bound the result set
]);

// Or with find():
db.events
  .find({
    timestamp: { $gte: start, $lte: end },
  })
  .sort({ timestamp: -1 })
  .limit(1000);
```

### Recommendations for Memongo

1. **Always add a `$limit` or `.limit()` to time-range queries.** Default to 1000 documents.
2. **Add a configurable `maxEvents` parameter** to `getEventsByTimeRange()` with a sensible default.
3. **Use cursor-based pagination** if the caller needs more than the limit.
4. **Ensure the compound index `{ scope: 1, timestamp: -1 }`** exists for efficient time-range queries with scope filtering.

### Caveats / Limitations

- Without `$limit`, MongoDB will return all matching documents, potentially causing memory pressure
- The `$limit` stage value must be a positive 64-bit integer

---

## M3. Telemetry Aggregation Patterns

### Problem

Currently using `$push` to collect all values into an array, then processing statistics client-side.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/avg/
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/percentile/
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/group/

### Official Pattern / Syntax

```javascript
// Server-side statistical aggregation (replaces $push + client-side processing)
db.telemetry.aggregate([
  {
    $match: {
      metricName: "searchLatency",
      timestamp: { $gte: ISODate("2026-03-22") },
    },
  },
  {
    $group: {
      _id: "$metricName",
      count: { $sum: 1 },
      avg: { $avg: "$value" },
      min: { $min: "$value" },
      max: { $max: "$value" },
      stdDev: { $stdDevPop: "$value" },
      percentiles: {
        $percentile: {
          input: "$value",
          p: [0.5, 0.75, 0.9, 0.95, 0.99],
          method: "approximate",
        },
      },
      median: {
        $median: {
          input: "$value",
          method: "approximate",
        },
      },
    },
  },
]);
```

**Available server-side statistical accumulators:**
| Operator | Description | Since |
|----------|-------------|-------|
| `$avg` | Average | All versions |
| `$min` | Minimum | All versions |
| `$max` | Maximum | All versions |
| `$sum` | Sum / Count | All versions |
| `$stdDevPop` | Population standard deviation | 3.2 |
| `$stdDevSamp` | Sample standard deviation | 3.2 |
| `$percentile` | Approximate percentiles | 7.0 |
| `$median` | Approximate median | 7.0 |

### Recommendations for Memongo

1. **Replace `$push` + client-side processing** with server-side aggregation using the operators above.
2. **Use `$percentile` with `p: [0.5, 0.75, 0.90, 0.95, 0.99]`** for comprehensive percentile stats.
3. **Use `$stdDevPop`** for standard deviation (population, not sample, since we have all telemetry data).
4. **Combine in a single `$group` stage** for efficiency -- all these accumulators can run in one pass.
5. **For time-bucketed stats**, use `$group` with `$dateTrunc` or `$setWindowFields` with time-based windows.

### Caveats / Limitations

- `$percentile` and `$median` are approximate (t-digest algorithm)
- `$stdDevPop` ignores non-numeric values
- `$push` into large arrays can hit the 16MB BSON document limit; server-side aggregation avoids this

---

## M4. Index Usage in Correlated $lookup with $expr

### Problem

Profile synthesis uses `$lookup` with `$expr` and `$or` on `fromEntityId`/`toEntityId`. Need to know if indexes are used.

### MongoDB Documentation Source

- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/
  - Explicit statement: "Indexes are not used for comparisons with more than one field path operand"
  - For correlated subqueries: indexes are used when the foreign collection has an index on the field being compared with `$eq` only
  - `$or` within `$expr` in a `$lookup` pipeline does NOT use indexes

### Official Pattern / Syntax

```javascript
// DOES use index (single $eq comparison):
{
  $lookup: {
    from: "relations",
    let: { eid: "$_id" },
    pipeline: [
      { $match: { $expr: { $eq: ["$fromEntityId", "$$eid"] } } }
    ],
    as: "outRelations"
  }
}

// DOES NOT use index ($or with multiple comparisons):
{
  $lookup: {
    from: "relations",
    let: { eid: "$_id" },
    pipeline: [
      { $match: {
        $expr: {
          $or: [
            { $eq: ["$fromEntityId", "$$eid"] },
            { $eq: ["$toEntityId", "$$eid"] }
          ]
        }
      }}
    ],
    as: "allRelations"
  }
}
```

### Recommendations for Memongo

1. **Split the single `$lookup` with `$or` into TWO `$lookup` stages**, each with a single `$eq` comparison:

```javascript
// Lookup 1: outgoing relations (uses index on fromEntityId)
{ $lookup: {
  from: "relations",
  let: { eid: "$_id" },
  pipeline: [
    { $match: { $expr: { $eq: ["$fromEntityId", "$$eid"] } } }
  ],
  as: "outgoingRelations"
}},
// Lookup 2: incoming relations (uses index on toEntityId)
{ $lookup: {
  from: "relations",
  let: { eid: "$_id" },
  pipeline: [
    { $match: { $expr: { $eq: ["$toEntityId", "$$eid"] } } }
  ],
  as: "incomingRelations"
}},
// Merge them
{ $addFields: {
  allRelations: { $concatArrays: ["$outgoingRelations", "$incomingRelations"] }
}}
```

2. **Ensure indexes exist** on both `fromEntityId` and `toEntityId` in the relations collection.
3. **Use `explain("executionStats")`** to verify index usage after the change.

### Caveats / Limitations

- Two `$lookup` stages means two passes over the foreign collection, but each is indexed
- This is more efficient than one `$lookup` with `$or` that does a COLLSCAN
- The `$concatArrays` merge may produce duplicates if a relation references the same entity on both sides -- add `$setUnion` or dedup logic if needed

---

## B1. MongoDB Official Patterns for "Write Fast, Enrich Later"

### Problem

Memongo uses an event-sourcing pattern where events are written first and enriched asynchronously.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/changeStreams/
  - Change streams enable reactive architectures: "applications [can] access real-time data changes without the complexity and risk of tailing the oplog"
- URL: https://www.mongodb.com/docs/manual/administration/change-streams-production-recommendations/
  - Production guidance for change stream usage
- URL: https://www.mongodb.com/resources/basics/artificial-intelligence/agent-memory
  - MongoDB's agent memory patterns page (concept-level)

### Recommendations for Memongo

1. **The "write fast, enrich later" pattern maps directly to Change Streams:**
   - Write raw events to the `events` collection (fast write path)
   - A Change Stream watcher picks up new inserts
   - Async enrichment runs (entity extraction, embedding generation, episode materialization)
   - Enrichment results written back to events or to derived collections
2. **Store resume tokens** in a `change_stream_checkpoints` collection for crash recovery
3. **Use `$match` in the change stream pipeline** to filter only relevant operation types (inserts)
4. **For atlas-local development**, Change Streams work because atlas-local runs as a replica set

### Caveats / Limitations

- Change Streams require a replica set or sharded cluster
- Resume tokens have a limited lifetime (tied to oplog size)
- Cannot index the oplog; high-volume change streams impact performance
- Consider batching enrichment work rather than processing one event at a time

---

## B2. $rankFusion and $scoreFusion

### Problem

Need to understand the official MongoDB operators for normalizing and fusing scores across search methods.

### MongoDB Documentation Sources

- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/rankFusion/
  - Version: MongoDB 8.0+, Preview feature
  - Uses Reciprocal Rank Fusion: `RRF(d) = sum(weight_i / (60 + rank_i(d)))`
  - De-duplicates results across pipelines
  - Supports weighted pipelines via `combination.weights`
  - Input pipelines must be Selection Pipelines AND Ranked Pipelines
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/scoreFusion/
  - Version: MongoDB 8.2+, Preview feature
  - Score-based fusion with normalization: `none`, `sigmoid`, `minMaxScaler`
  - Supports custom combination expressions: `method: "expression"` with custom `$sum`, `$multiply` etc.
  - Input pipelines must be Selection Pipelines AND Scoring Pipelines
  - If input pipeline doesn't return a score, must add a `$score` stage
- URL: https://www.mongodb.com/docs/manual/reference/operator/aggregation/score/
  - Version: MongoDB 8.2+
  - Standalone `$score` stage for computing/normalizing scores
  - Normalization options: `none`, `sigmoid`, `minMaxScaler`
  - Can apply `weight` multiplier after normalization

### Official Pattern / Syntax

**$rankFusion with weights:**

```javascript
{
  $rankFusion: {
    input: {
      pipelines: {
        vector: [{ $vectorSearch: { ... } }],
        text: [{ $search: { ... } }, { $limit: 20 }]
      }
    },
    combination: {
      weights: { vector: 3, text: 1 }  // vector results weighted 3x
    },
    scoreDetails: true
  }
}
```

**$scoreFusion with sigmoid normalization and custom expression:**

```javascript
{
  $scoreFusion: {
    input: {
      pipelines: {
        vector: [{ $vectorSearch: { ... } }],
        text: [{ $search: { ... } }, { $limit: 20 }]
      },
      normalization: "sigmoid"
    },
    combination: {
      method: "expression",
      expression: {
        $sum: [
          { $multiply: ["$$vector", 10] },
          "$$text"
        ]
      }
    },
    scoreDetails: true
  }
}
```

**$score stage for normalizing non-search scores:**

```javascript
// Add a score to a pipeline that doesn't inherently produce one
[
  { $match: { type: "structured_fact", scope: "agent123" } },
  { $sort: { relevance: -1 } },
  {
    $score: {
      score: "$relevance",
      normalization: "sigmoid",
      weight: 0.5,
    },
  },
];
```

### Recommendations for Memongo

1. **For MongoDB 8.0+ (atlas-local):** Use `$rankFusion` for hybrid search combining `$vectorSearch` and `$search` pipelines. This is the simplest and most robust approach.
2. **For MongoDB 8.2+:** Use `$scoreFusion` with `normalization: "sigmoid"` for score-aware fusion that preserves magnitude differences.
3. **For non-search sources (structured memory, episodes):** Use `$score` stage to assign and normalize scores before feeding into `$scoreFusion`.
4. **Manual RRF remains necessary** for merging results from different collections (the native operators work on a single collection only).
5. **Use `scoreDetails: true`** during development to debug and tune fusion weights.

### Caveats / Limitations

- Both `$rankFusion` and `$scoreFusion` are **Preview features** (not GA)
- Both require all input pipelines to operate on the **same collection**
- `$rankFusion` requires MongoDB 8.0+; `$scoreFusion` requires MongoDB 8.2+
- `$scoreFusion` requires each pipeline to produce a score (add `$score` stage if not)
- Pipeline names must not start with `$`, contain `.`, or contain null characters
- MongoDB does not guarantee specific output format for `scoreDetails`
- Both stages operate on a single collection only -- cannot fuse results from multiple collections

---

## Summary Table

| Issue                        | MongoDB Solution                                             | Min Version        | Status  |
| ---------------------------- | ------------------------------------------------------------ | ------------------ | ------- |
| C1. Score normalization      | `$rankFusion` / `$scoreFusion` / manual RRF                  | 8.0+ / 8.2+ / any  | Preview |
| C2. $facet + $lookup perf    | Split $or into two $lookup stages                            | any                | GA      |
| C3. Fetch timeouts           | Application-level (not MongoDB)                              | N/A                | N/A     |
| H1. bulkWrite upserts        | `db.collection.bulkWrite()` with `ordered: false`            | any                | GA      |
| H2. Change Streams           | `collection.watch()` with resume tokens                      | 3.6+ (replica set) | GA      |
| H3. Vector pre-filter        | `$vectorSearch` `filter` clause with indexed filter fields   | 6.0+ (Atlas)       | GA      |
| H4. Variable TTL             | TTL index with `expireAfterSeconds: 0` + per-doc `expiresAt` | any                | GA      |
| H5. Empty doc handling       | `$match`/`$cond` filtering (application pattern)             | any                | N/A     |
| M1. $percentile              | `$percentile` accumulator                                    | 7.0+               | GA      |
| M2. Unbounded queries        | Always add `$limit` to time-range queries                    | any                | GA      |
| M3. Server-side stats        | `$avg`, `$stdDevPop`, `$percentile`, `$median` in `$group`   | 7.0+               | GA      |
| M4. $lookup index usage      | Split `$or` into two indexed `$eq` lookups                   | any                | GA      |
| B1. Write-then-enrich        | Change Streams + async enrichment                            | 3.6+               | GA      |
| B2. $rankFusion/$scoreFusion | Native hybrid search stages                                  | 8.0+ / 8.2+        | Preview |

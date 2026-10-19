// Standard (non-search) index coordinator (P4.3).
import type { Db } from "mongodb"
import { ensureCoreStandardIndexes } from "./mongodb-schema-standard-indexes-core.js"
import { ensureGraphStandardIndexes } from "./mongodb-schema-standard-indexes-graph.js"
import { ensureOperationalStandardIndexes } from "./mongodb-schema-standard-indexes-operations.js"
import type { StandardIndexOptions } from "./mongodb-schema-standard-index-types.js"

export async function ensureStandardIndexes(
	db: Db,
	prefix: string,
	ttlOpts?: StandardIndexOptions,
): Promise<number> {
	const core = await ensureCoreStandardIndexes(db, prefix, ttlOpts)
	const graph = await ensureGraphStandardIndexes(db, prefix, ttlOpts)
	const operations = await ensureOperationalStandardIndexes(db, prefix, ttlOpts)
	return core + graph + operations
}

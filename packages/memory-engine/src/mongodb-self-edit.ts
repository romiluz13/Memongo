/**
 * Self-editing memory: allows agents to directly edit their own core memory
 * blocks (user preferences, persona identity, task instructions).
 */
import type { Db, MongoClient } from "mongodb"
import type { MemoryMongoDBEmbeddingMode } from "@memongo/lib"
import type { MemorySelfEditBlock, MemorySelfEditAction } from "./types.js"
import { structuredMemCollection } from "./mongodb-schema.js"
import {
	writeStructuredMemory,
	type StructuredMemoryType,
} from "./mongodb-structured-memory.js"

// ---------------------------------------------------------------------------
// Block → structured memory type/key mapping
// ---------------------------------------------------------------------------

const BLOCK_MAP: Record<
	MemorySelfEditBlock,
	{ type: StructuredMemoryType; key: string }
> = {
	user: { type: "preference", key: "core:user" },
	persona: { type: "identity", key: "core:persona" },
	instructions: { type: "instruction", key: "core:instructions" },
}

// ---------------------------------------------------------------------------
// selfEditBlock — standalone function
// ---------------------------------------------------------------------------

export async function selfEditBlock(params: {
	db: Db
	prefix: string
	agentId: string
	embeddingMode: MemoryMongoDBEmbeddingMode
	client?: MongoClient
	block: MemorySelfEditBlock
	action: MemorySelfEditAction
	content: string
}): Promise<{ upserted: boolean; id: string }> {
	const { db, prefix, agentId, embeddingMode, client, block, action, content } =
		params
	const { type, key } = BLOCK_MAP[block]

	if (action !== "replace" && client) {
		const session = client.startSession()
		try {
			let result: { upserted: boolean; id: string } | undefined
			await session.withTransaction(async () => {
				const existing = await structuredMemCollection(db, prefix).findOne(
					{ agentId, type, key },
					{ session },
				)
				const existingValue =
					existing && typeof existing.value === "string" ? existing.value : null
				const value =
					existingValue == null
						? content
						: action === "append"
							? `${existingValue}\n${content}`
							: `${content}\n${existingValue}`

				result = await writeStructuredMemory({
					db,
					prefix,
					entry: {
						type,
						key,
						value,
						agentId,
						confidence: 1.0,
						salience: "critical",
						sourceAgent: { id: agentId, name: "user" },
					},
					embeddingMode,
					session,
				})
			})

			return { upserted: result?.upserted ?? false, id: `core:${block}` }
		} finally {
			await session.endSession()
		}
	}

	let value: string
	if (action === "replace") {
		value = content
	} else {
		// append or prepend — read existing doc first
		const existing = await structuredMemCollection(db, prefix).findOne({
			agentId,
			type,
			key,
		})
		const existingValue =
			existing && typeof existing.value === "string" ? existing.value : null

		if (existingValue === null) {
			value = content
		} else if (action === "append") {
			value = `${existingValue}\n${content}`
		} else {
			// prepend
			value = `${content}\n${existingValue}`
		}
	}

	const result = await writeStructuredMemory({
		db,
		prefix,
		entry: {
			type,
			key,
			value,
			agentId,
			confidence: 1.0,
			salience: "critical",
			sourceAgent: { id: agentId, name: "user" },
		},
		embeddingMode,
		client,
	})

	return { upserted: result.upserted, id: `core:${block}` }
}

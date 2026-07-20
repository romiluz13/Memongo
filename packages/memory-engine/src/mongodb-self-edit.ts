/**
 * Self-editing memory: allows agents to directly edit their own core memory
 * blocks (user preferences, persona identity, task instructions).
 */
import type { Db, MongoClient } from "mongodb"
import type { MemoryMongoDBEmbeddingMode } from "@memongo/lib"
import type { MemorySelfEditBlock, MemorySelfEditAction } from "./types.js"
import { classifyInjection } from "./mongodb-injection-classifier.js"
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

// #29 self-edit hardening: persona and instructions define the agent's own
// behavior. An agent steered by injected retrieved memory must not be able to
// rewrite these blocks with injection-shaped content unchecked, so screen the
// incoming content and reject clear injection attempts. `user` (preferences) is
// ordinary user data and is not screened.
const PROTECTED_SELF_EDIT_BLOCKS: ReadonlySet<MemorySelfEditBlock> = new Set([
	"persona",
	"instructions",
])

export class SelfEditRejectedError extends Error {
	readonly block: MemorySelfEditBlock
	readonly matchedPatterns: string[]
	constructor(block: MemorySelfEditBlock, matchedPatterns: string[]) {
		super(
			`self-edit to '${block}' rejected: content matched injection patterns [${matchedPatterns.join(
				", ",
			)}]`,
		)
		this.name = "SelfEditRejectedError"
		this.block = block
		this.matchedPatterns = matchedPatterns
	}
}

// Screen the FINAL merged value (not just the incoming delta) for protected
// blocks, so an injection cannot be smuggled in by splitting it across multiple
// append/prepend calls that each look benign on their own.
function assertProtectedSelfEditSafe(
	block: MemorySelfEditBlock,
	value: string,
): void {
	if (!PROTECTED_SELF_EDIT_BLOCKS.has(block)) {
		return
	}
	const verdict = classifyInjection({ content: value })
	if (verdict.classification === "injection-likely") {
		throw new SelfEditRejectedError(block, verdict.matchedPatterns)
	}
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

				assertProtectedSelfEditSafe(block, value)

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

	assertProtectedSelfEditSafe(block, value)

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

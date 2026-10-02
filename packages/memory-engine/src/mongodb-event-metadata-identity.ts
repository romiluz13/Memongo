import { isDeepStrictEqual } from "node:util"
import { BSON, type BSONSerializeOptions } from "mongodb"

export const EVENT_IDENTITY_READ_OPTIONS = {
	raw: false,
	fieldsAsRaw: {},
	useBigInt64: false,
	promoteValues: false,
	promoteLongs: false,
	bsonRegExp: true,
} as const

export type EventMetadataWriteOptions = Pick<
	BSONSerializeOptions,
	"ignoreUndefined" | "serializeFunctions"
>

function normalizeEventMetadata(
	metadata: unknown,
	writeOptions: EventMetadataWriteOptions,
): unknown {
	return BSON.deserialize(
		BSON.serialize(
			{ metadata },
			{
				ignoreUndefined: writeOptions.ignoreUndefined,
				serializeFunctions: writeOptions.serializeFunctions,
			},
		),
		EVENT_IDENTITY_READ_OPTIONS,
	).metadata
}

/**
 * Compares stored and attempted event metadata by the BSON value each side
 * represents under the events collection's effective write policy. The
 * round-trip preserves BSON type identity while making document key order
 * irrelevant.
 *
 * @param stored Metadata read from the persisted event.
 * @param attempted Metadata supplied by the replay attempt.
 * @param writeOptions Resolved collection options that control undefined
 * fields and function serialization. Callers must pass the actual collection
 * options rather than assume driver defaults.
 * @returns Whether both values have the same BSON-persisted meaning.
 */
export function eventMetadataMatchesPersistedForm(
	stored: unknown,
	attempted: unknown,
	writeOptions: EventMetadataWriteOptions,
): boolean {
	return isDeepStrictEqual(
		normalizeEventMetadata(stored, writeOptions),
		normalizeEventMetadata(attempted, writeOptions),
	)
}

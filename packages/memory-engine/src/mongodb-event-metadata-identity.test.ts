import { Code } from "mongodb"
import { describe, expect, it } from "vitest"
import { eventMetadataMatchesPersistedForm } from "./mongodb-event-metadata-identity.js"

const DEFAULT_WRITE_OPTIONS = {
	ignoreUndefined: false,
	serializeFunctions: false,
}

describe("eventMetadataMatchesPersistedForm", () => {
	it("preserves BSON Date identity instead of treating equal strings as dates", () => {
		const observedAt = new Date("2026-01-01T00:00:00.000Z")

		expect(
			eventMetadataMatchesPersistedForm(
				{ observedAt },
				{ observedAt: new Date(observedAt) },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				{ observedAt },
				{ observedAt: observedAt.toISOString() },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(false)
	})

	it("preserves BSON regular-expression identity", () => {
		expect(
			eventMetadataMatchesPersistedForm(
				{ pattern: /alpha/im },
				{ pattern: /alpha/im },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				{ pattern: /alpha/im },
				{ pattern: /beta/im },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(false)
	})

	it("ignores document key order while preserving array order", () => {
		expect(
			eventMetadataMatchesPersistedForm(
				{ nested: { first: 1, second: true }, ranked: ["first", "second"] },
				{ ranked: ["first", "second"], nested: { second: true, first: 1 } },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				{ ranked: ["first", "second"] },
				{ ranked: ["second", "first"] },
				DEFAULT_WRITE_OPTIONS,
			),
		).toBe(false)
	})

	it("uses the effective ignoreUndefined write option", () => {
		const withUndefined = { nested: { optional: undefined } }

		expect(
			eventMetadataMatchesPersistedForm(
				withUndefined,
				{ nested: { optional: null } },
				{ ignoreUndefined: false, serializeFunctions: false },
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				withUndefined,
				{ nested: {} },
				{ ignoreUndefined: true, serializeFunctions: false },
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				withUndefined,
				{ nested: {} },
				{ ignoreUndefined: false, serializeFunctions: false },
			),
		).toBe(false)
	})

	it("uses the effective serializeFunctions write option", () => {
		function transform(value: unknown): unknown {
			return value
		}
		function changedTransform(value: unknown): unknown {
			return { value }
		}

		expect(
			eventMetadataMatchesPersistedForm(
				{ transform: new Code(transform.toString()) },
				{ transform },
				{ ignoreUndefined: false, serializeFunctions: true },
			),
		).toBe(true)
		expect(
			eventMetadataMatchesPersistedForm(
				{ transform: new Code(transform.toString()) },
				{ transform: changedTransform },
				{ ignoreUndefined: false, serializeFunctions: true },
			),
		).toBe(false)
		expect(
			eventMetadataMatchesPersistedForm(
				{},
				{ transform },
				{ ignoreUndefined: false, serializeFunctions: false },
			),
		).toBe(true)
	})
})

import { describe, expect, it } from "vitest"
import {
	InvalidJsonError,
	kbFilterSchema,
	metadataSchema,
	procedureEntrySchema,
	structuredEntrySchema,
	validateMetadata,
	validateWithSchema,
} from "./validation.js"

describe("structuredEntrySchema (P2.8)", () => {
	it("accepts a minimal valid entry", () => {
		const result = validateWithSchema(
			structuredEntrySchema,
			{ type: "fact", key: "city", value: "Berlin" },
			"entry",
		)
		expect(result.ok).toBe(true)
	})

	it("rejects a missing type/key/value naming the field", () => {
		for (const [entry, field] of [
			[{ key: "city", value: "Berlin" }, "entry.type"],
			[{ type: "fact", value: "Berlin" }, "entry.key"],
			[{ type: "fact", key: "city" }, "entry.value"],
		] as const) {
			const result = validateWithSchema(structuredEntrySchema, entry, "entry")
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.message).toContain(field)
			}
		}
	})

	it("rejects wrong-typed required fields", () => {
		const result = validateWithSchema(
			structuredEntrySchema,
			{ type: "fact", key: 42, value: "Berlin" },
			"entry",
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("entry.key")
		}
	})

	it("rejects wrong-typed known optional fields", () => {
		const result = validateWithSchema(
			structuredEntrySchema,
			{ type: "fact", key: "city", value: "Berlin", tags: "not-an-array" },
			"entry",
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("entry.tags")
		}
	})

	it("passes unknown fields through for forward compatibility", () => {
		const result = validateWithSchema(
			structuredEntrySchema,
			{ type: "fact", key: "city", value: "Berlin", futureField: 1 },
			"entry",
		)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect((result.value as Record<string, unknown>).futureField).toBe(1)
		}
	})

	it("rejects a non-object entry", () => {
		const result = validateWithSchema(structuredEntrySchema, "nope", "entry")
		expect(result.ok).toBe(false)
	})
})

describe("procedureEntrySchema (P2.8)", () => {
	it("accepts a minimal valid entry", () => {
		const result = validateWithSchema(
			procedureEntrySchema,
			{ procedureId: "proc-1", name: "deploy", steps: ["build"] },
			"entry",
		)
		expect(result.ok).toBe(true)
	})

	it("rejects a missing procedureId/name/steps naming the field", () => {
		for (const [entry, field] of [
			[{ name: "deploy", steps: [] }, "entry.procedureId"],
			[{ procedureId: "proc-1", steps: [] }, "entry.name"],
			[{ procedureId: "proc-1", name: "deploy" }, "entry.steps"],
		] as const) {
			const result = validateWithSchema(procedureEntrySchema, entry, "entry")
			expect(result.ok).toBe(false)
			if (!result.ok) {
				expect(result.message).toContain(field)
			}
		}
	})

	it("rejects non-array steps", () => {
		const result = validateWithSchema(
			procedureEntrySchema,
			{ procedureId: "proc-1", name: "deploy", steps: "not-an-array" },
			"entry",
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("entry.steps")
		}
	})
})

describe("kbFilterSchema (P2.8)", () => {
	it("accepts a typed filter", () => {
		const parsed = kbFilterSchema.safeParse({
			tags: ["db"],
			category: "runbook",
			source: "docs",
		})
		expect(parsed.success).toBe(true)
	})

	it("rejects operator-shaped keys instead of casting them through", () => {
		const result = validateWithSchema(
			kbFilterSchema,
			{ $where: "1" } as unknown,
			"filter",
		)
		expect(result.ok).toBe(false)
	})

	it("rejects non-string-array tags", () => {
		const result = validateWithSchema(
			kbFilterSchema,
			{ tags: [1, 2] },
			"filter",
		)
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("filter.tags")
		}
	})
})

describe("metadataSchema / validateMetadata (P2.8)", () => {
	it("accepts normal metadata", () => {
		expect(metadataSchema.safeParse({ source: "chat", turn: 3 }).success).toBe(
			true,
		)
	})

	it("rejects $-prefixed keys", () => {
		const result = validateMetadata({ $where: "x" })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("$where")
		}
	})

	it("rejects dotted keys", () => {
		const result = validateMetadata({ "a.b": 1 })
		expect(result.ok).toBe(false)
		if (!result.ok) {
			expect(result.message).toContain("a.b")
		}
	})

	it("treats absent metadata as valid undefined", () => {
		const result = validateMetadata(undefined)
		expect(result.ok).toBe(true)
		if (result.ok) {
			expect(result.value).toBeUndefined()
		}
	})

	it("rejects non-object metadata", () => {
		expect(validateMetadata("nope").ok).toBe(false)
		expect(validateMetadata([1, 2]).ok).toBe(false)
	})
})

describe("InvalidJsonError (P2.8)", () => {
	it("carries a stable name for the route-layer classifier", () => {
		const error = new InvalidJsonError()
		expect(error.name).toBe("InvalidJsonError")
		expect(error.message).toContain("valid JSON")
	})
})

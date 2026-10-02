import type { Collection, Db, Document } from "mongodb"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock("@memongo/lib", () => ({
	createSubsystemLogger: () => ({
		warn,
		info: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
	}),
}))
vi.mock("./mongodb-schema.js", () => ({ eventsCollection: vi.fn() }))
import { recallConversation } from "./mongodb-conversation-recall.js"
import { eventsCollection } from "./mongodb-schema.js"

async function recall(timezone?: string) {
	const find = vi.fn((_filter: Document) => ({
		sort: vi.fn(() => ({
			limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
		})),
	}))
	vi.mocked(eventsCollection).mockReturnValue({ find } as unknown as Collection)
	const response = await recallConversation({
		db: {} as Db,
		prefix: "test_",
		request: {
			agentId: "a1",
			timezone,
			startTime: "2026-04-08",
			endTime: "2026-04-08",
			asOf: new Date("2026-04-12T00:00:00Z"),
		},
	})
	return { response, filter: find.mock.calls[0]?.[0] as Document | undefined }
}

describe("invalid recall timezone diagnostics", () => {
	beforeEach(() => vi.clearAllMocks())
	it.each([
		"Mars/Olympus",
		`private-timezone-marker-${"x".repeat(100_000)}`,
	])("omits caller text and retains UTC fallback (case %#)", async (timezone) => {
		const { response, filter } = await recall(timezone)
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			"invalid conversation recall timezone, falling back to UTC",
		)
		expect(JSON.stringify(warn.mock.calls)).not.toContain(timezone)
		expect(filter?.timestamp).toEqual({
			$gte: new Date("2026-04-08T00:00:00Z"),
			$lte: new Date("2026-04-08T23:59:59.999Z"),
		})
		expect(response.metadata.searchMethod).toBe("standard")
	})
	it.each([
		undefined,
		"",
		"  ",
		"UTC",
	])("preserves quiet UTC/default recall for %s", async (timezone) => {
		const { filter } = await recall(timezone)
		expect(warn).not.toHaveBeenCalled()
		expect(filter?.timestamp).toEqual({
			$gte: new Date("2026-04-08T00:00:00Z"),
			$lte: new Date("2026-04-08T23:59:59.999Z"),
		})
	})
	it("preserves a valid IANA timezone", async () => {
		const { filter } = await recall("America/New_York")
		expect(warn).not.toHaveBeenCalled()
		expect(filter?.timestamp).toEqual({
			$gte: new Date("2026-04-08T04:00:00Z"),
			$lte: new Date("2026-04-09T03:59:59.999Z"),
		})
	})
})

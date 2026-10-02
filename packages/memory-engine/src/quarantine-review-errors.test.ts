import { MongoClient } from "mongodb"
import { captureAdmissionToken } from "./mongodb-write-fence.js"
import { describe, expect, it, vi } from "vitest"
import {
	promoteQuarantined,
	rejectQuarantined,
} from "./mongodb-quarantine-review.js"
import { createStatefulMongoFake } from "./test-helpers/stateful-mongo-fake.js"

const cases = [
	{ scenario: "missing", reason: "not-found", message: "not found" },
	{ scenario: "foreign", reason: "not-found", message: "not found" },
	{ scenario: "promoted", reason: "conflict", message: "already reviewed" },
	{ scenario: "rejected", reason: "conflict", message: "already reviewed" },
	{
		scenario: "live-lease",
		reason: "conflict",
		message: "promotion already in progress",
	},
	{
		scenario: "lost-claim",
		reason: "conflict",
		message: "concurrently reviewed",
	},
] as const
for (const operation of ["promote", "reject"] as const) {
	describe(`${operation} quarantine review error reasons`, () => {
		it.each(cases)("classifies $scenario without applying a decision", async ({
			scenario,
			reason,
			message,
		}) => {
			const fake = createStatefulMongoFake({ prefix: "fixture_" })
			const collection = fake.collection("memory_quarantine")
			if (scenario !== "missing")
				await collection.insertOne({
					quarantineId: "quarantine",
					agentId: scenario === "foreign" ? "other" : "agent",
					status:
						scenario === "live-lease"
							? "promoting"
							: ["promoted", "rejected"].includes(scenario)
								? scenario
								: "pending-review",
					content: "I prefer tabs over spaces",
					classification: "injection-likely",
					scope: "user",
					scopeRef: "user:fixture",
					matchedPatterns: [],
					sourceEventIds: [],
					createdAt: new Date(0),
					...(scenario === "live-lease"
						? { promoteLeaseExpiresAt: new Date(Date.now() + 60000) }
						: {}),
				})
			const before = structuredClone(fake.all("memory_quarantine"))
			const update =
				scenario === "lost-claim"
					? vi.spyOn(collection, "updateOne").mockResolvedValueOnce({
							acknowledged: true,
							matchedCount: 0,
							modifiedCount: 0,
							upsertedCount: 0,
							upsertedId: null,
						})
					: undefined
			const params = {
				db: fake.db,
				prefix: "fixture_",
				agentId: "agent",
				quarantineId: "quarantine",
			}
			try {
				const promise =
					operation === "promote"
						? promoteQuarantined({ ...params, embeddingMode: "automated" })
						: rejectQuarantined(params)
				await expect(promise).rejects.toMatchObject({
					name: "QuarantineReviewError",
					reason,
					message: expect.stringContaining(message),
				})
				expect(fake.all("memory_quarantine")).toEqual(before)
				expect(fake.all("structured_mem")).toEqual([])
				expect(fake.all("memory_mutations")).toEqual([])
			} finally {
				update?.mockRestore()
			}
		})
	})
}

it("preserves a fenced typed error through the actual driver transaction abort", async () => {
	const fake = createStatefulMongoFake({ prefix: "fixture_" })
	const admission = await captureAdmissionToken({
		db: fake.db,
		prefix: "fixture_",
		agentId: "agent",
	})
	const client = new MongoClient("mongodb://127.0.0.1:27218")
	const session = client.startSession()
	const start = vi
		.spyOn(fake.db.client, "startSession")
		.mockReturnValue(session)
	const abort = vi.spyOn(session, "abortTransaction")
	const end = vi.spyOn(session, "endSession")
	const connect = vi.spyOn(client, "connect")
	try {
		await expect(
			rejectQuarantined({
				db: fake.db,
				prefix: "fixture_",
				agentId: "agent",
				quarantineId: "missing",
				admission,
			}),
		).rejects.toMatchObject({
			name: "QuarantineReviewError",
			reason: "not-found",
		})
		expect(start).toHaveBeenCalledTimes(1)
		expect(abort).toHaveBeenCalledTimes(1)
		expect(end).toHaveBeenCalledTimes(1)
		expect(session.hasEnded).toBe(true)
		expect(connect).not.toHaveBeenCalled()
		expect(fake.all("structured_mem")).toEqual([])
		expect(fake.all("memory_mutations")).toEqual([])
	} finally {
		start.mockRestore()
		abort.mockRestore()
		end.mockRestore()
		connect.mockRestore()
		await client.close()
	}
})

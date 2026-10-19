import { describe, expect, it, vi } from "vitest"
import { MongoDBMemoryManager } from "./mongodb-manager.js"

type Wrapper = (
	this: unknown,
	job: unknown,
	prefetchedLlmFacts?: string[],
	prefetchedEffects?: unknown,
) => Promise<void>

describe("manager wrapper for a claimed background extraction job (T11)", () => {
	it("forwards the prefetched facts and the prefetched effects to the jobs ops", async () => {
		const run = vi.fn(async () => undefined)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{ _jobsOps: { runClaimedBackgroundExtractionJob: run } },
		)
		const wrapper = (
			MongoDBMemoryManager.prototype as unknown as {
				runClaimedBackgroundExtractionJob: Wrapper
			}
		).runClaimedBackgroundExtractionJob
		const job = { jobId: "job-1" }
		const facts = ["fact one"]
		const effects = { sentinel: "prefetched-effects" }

		await wrapper.call(manager, job, facts, effects)

		expect(run).toHaveBeenCalledExactlyOnceWith(job, facts, effects)
	})

	it("passes undefined for both when the caller prefetched nothing", async () => {
		const run = vi.fn(async () => undefined)
		const manager = Object.assign(
			Object.create(MongoDBMemoryManager.prototype),
			{ _jobsOps: { runClaimedBackgroundExtractionJob: run } },
		)
		const wrapper = (
			MongoDBMemoryManager.prototype as unknown as {
				runClaimedBackgroundExtractionJob: Wrapper
			}
		).runClaimedBackgroundExtractionJob

		await wrapper.call(manager, { jobId: "job-2" })

		expect(run).toHaveBeenCalledExactlyOnceWith(
			{ jobId: "job-2" },
			undefined,
			undefined,
		)
	})
})

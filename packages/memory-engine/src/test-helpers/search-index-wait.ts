// E2E harness helper: waits for named Search indexes to become queryable on a
// live deployment. Production readiness is the boot contract
// (mongodb-boot-contract.ts); nothing in production calls this.
import type { Collection } from "mongodb"
import {
	isSearchIndexFailed,
	isSearchIndexQueryable,
	listSearchIndexes,
	type SearchIndexDescription,
	type SearchIndexWaitResult,
	sleep,
} from "../mongodb-schema-search-readiness.js"

export async function waitForSearchIndexesQueryable(
	collection: Collection,
	{
		indexNames,
		timeoutMs = 60_000,
		pollMs = 1_000,
	}: {
		indexNames: string[]
		timeoutMs?: number
		pollMs?: number
	},
): Promise<SearchIndexWaitResult> {
	const deadline = Date.now() + timeoutMs
	let lastRelevant: SearchIndexDescription[] = []
	let lastError: string | undefined

	while (Date.now() < deadline) {
		try {
			lastRelevant = (await listSearchIndexes(collection)).filter((index) =>
				indexNames.includes(String(index.name ?? "")),
			)
			lastError = undefined
		} catch (err) {
			lastError = err instanceof Error ? err.message : String(err)
			await sleep(pollMs)
			continue
		}
		const byName = new Map(
			lastRelevant.map((index) => [String(index.name ?? ""), index]),
		)
		const failed = indexNames.filter((name) => {
			const index = byName.get(name)
			return index ? isSearchIndexFailed(index) : false
		})
		const pending = indexNames.filter((name) => {
			const index = byName.get(name)
			return !index || !isSearchIndexQueryable(index)
		})

		if (failed.length > 0) {
			return {
				ready: false,
				indexes: lastRelevant,
				pending,
				failed,
				...(lastError ? { lastError } : {}),
			}
		}
		if (pending.length === 0) {
			return {
				ready: true,
				indexes: lastRelevant,
				pending: [],
				failed: [],
			}
		}

		await sleep(pollMs)
	}

	const byName = new Map(
		lastRelevant.map((index) => [String(index.name ?? ""), index]),
	)
	const failed = indexNames.filter((name) => {
		const index = byName.get(name)
		return index ? isSearchIndexFailed(index) : false
	})
	const pending = indexNames.filter((name) => {
		const index = byName.get(name)
		return !index || !isSearchIndexQueryable(index)
	})
	return {
		ready: pending.length === 0 && failed.length === 0,
		indexes: lastRelevant,
		pending,
		failed,
		...(lastError ? { lastError } : {}),
	}
}

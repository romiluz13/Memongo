import { describe, expect, it } from "vitest"

import {
	boundTail,
	scrubLogText,
	summarizeSearchIndexes,
} from "./proof-pack-diagnostics.js"

const atlasModelKey = "al-Q2hlY2tTZWNyZXRLZXlWYWx1ZTEyMzQ1Njc4OTA"
const opaqueSecret = "s3cr3t-not-shaped-like-a-key"

const sample = [
	`{"t":{"$date":"2026-10-18T16:58:00.620Z"},"s":"I","c":"NETWORK","msg":"Connection accepted","attr":{"remote":"127.0.0.1:51234","uri":"mongodb://proof:hunter2@127.0.0.1:27017/?directConnection=true"}}`,
	`2026-10-18T16:58:01Z WARN embedding request to https://ai.mongodb.com/v1/embeddings failed: 403 apiKey=${atlasModelKey}`,
	`{"msg":"Slow query","attr":{"command":{"insert":"memongo_chunks","documents":[{"text":"User: proof-pack-1760000000000 user prefers concise updates","role":"user"}]}}}`,
	`{"msg":"index","attr":{"query":"concise deploy status reports","indexName":"chunks_vector"}}`,
	`Authorization: Bearer abc.def.ghi and token: ${opaqueSecret}`,
	`api key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef in a plain line`,
].join("\n")

describe("scrubLogText", () => {
	const scrubbed = scrubLogText(sample, [opaqueSecret])

	it("removes every URI, including credentials inside a connection string", () => {
		expect(scrubbed).not.toContain("mongodb://")
		expect(scrubbed).not.toContain("hunter2")
		expect(scrubbed).not.toContain("https://ai.mongodb.com")
		expect(scrubbed).toContain("<uri>")
	})

	it("removes model keys, bearer tokens, assigned secrets and long hex tokens", () => {
		expect(scrubbed).not.toContain(atlasModelKey)
		expect(scrubbed).not.toContain("abc.def.ghi")
		expect(scrubbed).not.toContain(opaqueSecret)
		expect(scrubbed).not.toContain("0123456789abcdef0123456789abcdef")
	})

	it("removes document and query text but keeps diagnostic structure", () => {
		expect(scrubbed).not.toContain("prefers concise updates")
		expect(scrubbed).not.toContain("concise deploy status reports")
		expect(scrubbed).toContain('"msg":"Slow query"')
		expect(scrubbed).toContain('"indexName":"chunks_vector"')
		expect(scrubbed).toContain("Connection accepted")
	})

	it("caps every line", () => {
		const long = scrubLogText("x".repeat(10_000), [])
		expect(long.length).toBeLessThanOrEqual(2_100)
		expect(long).toContain("[line truncated]")
	})
})

describe("boundTail", () => {
	it("keeps text within the byte limit untouched", () => {
		expect(boundTail("a\nb\n", 1024)).toBe("a\nb\n")
	})

	it("keeps only the newest whole lines within the byte limit", () => {
		const lines = Array.from({ length: 100 }, (_, i) => `line-${i}`).join("\n")
		const bounded = boundTail(lines, 64)
		expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(64)
		expect(bounded).toContain("line-99")
		expect(bounded).not.toContain("line-0\n")
		expect(bounded.startsWith("[truncated:")).toBe(true)
	})
})

describe("summarizeSearchIndexes", () => {
	it("reports name, status, queryable and field names, never definition values", () => {
		const summary = summarizeSearchIndexes("memongo_chunks", [
			{
				id: "1",
				name: "chunks_vector",
				type: "vectorSearch",
				status: "PENDING",
				queryable: false,
				latestDefinition: {
					fields: [
						{ type: "autoEmbed", path: "text", model: "voyage-4-large" },
						{ type: "filter", path: "scopeRef" },
						{ type: "filter", path: "searchWriteToken" },
					],
				},
			},
			{
				name: "chunks_text",
				type: "search",
				status: "READY",
				queryable: true,
				latestDefinition: {
					mappings: {
						dynamic: false,
						fields: {
							text: { type: "string", analyzer: "lucene.standard" },
							scopeRef: { type: "token" },
							metadata: {
								type: "document",
								fields: { tag: { type: "token" } },
							},
						},
					},
				},
			},
		])
		expect(summary).toEqual([
			{
				collection: "memongo_chunks",
				name: "chunks_vector",
				type: "vectorSearch",
				status: "PENDING",
				queryable: false,
				fields: ["text", "scopeRef", "searchWriteToken"],
			},
			{
				collection: "memongo_chunks",
				name: "chunks_text",
				type: "search",
				status: "READY",
				queryable: true,
				fields: ["text", "scopeRef", "metadata", "metadata.tag"],
			},
		])
		expect(JSON.stringify(summary)).not.toContain("voyage-4-large")
	})
})

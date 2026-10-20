import type { MemongoStructuredStableHandle } from "@memongo/client"
import { describe, expect, it } from "vitest"
import { coords, handleFor, resolveLiveHandle } from "./kit.ts"
import { makeRead } from "./probe-g-fixtures.ts"
import type { GRead } from "./probe-g-model.ts"

const SEED: MemongoStructuredStableHandle = {
	family: "structured",
	id: "st-1",
	agentId: "agent-1",
	scope: "workspace",
	scopeRef: "ref-1",
	revision: 1,
	state: "active",
	structured: { type: "fact", key: "launch-key" },
}

const LIVE = { ...SEED, revision: 3 }

function readWith(handle: unknown): GRead {
	return makeRead("lifecycleGet", "pre", { handle, data: { value: "v" } })
}

describe("resolveLiveHandle", () => {
	it("returns the validated live handle with its revision", () => {
		const result = resolveLiveHandle(SEED, readWith(LIVE))
		expect(result).toEqual({ ok: true, handle: LIVE })
	})

	it("copies only the known fields and keeps optional ones that are strings", () => {
		const result = resolveLiveHandle(
			SEED,
			readWith({
				...LIVE,
				validFrom: "2026-01-01T00:00:00.000Z",
				injected: "must not be forwarded",
			}),
		)
		expect(result).toEqual({
			ok: true,
			handle: { ...LIVE, validFrom: "2026-01-01T00:00:00.000Z" },
		})
	})

	it("never substitutes the seed handle when the pre-read cannot be used", () => {
		const failed = makeRead("lifecycleGet", "pre", {})
		const transport: GRead = {
			...failed,
			observation: {
				kind: "transport-error",
				route: "lifecycleGet",
				message: "ECONNRESET",
			},
		}
		for (const read of [undefined, transport, readWith(undefined)]) {
			expect(resolveLiveHandle(SEED, read)).toMatchObject({ ok: false })
		}
	})

	it.each([
		["a missing revision", { ...LIVE, revision: undefined }],
		["a string revision", { ...LIVE, revision: "3" }],
		["a fractional revision", { ...LIVE, revision: 2.5 }],
		["a zero revision", { ...LIVE, revision: 0 }],
		["another record id", { ...LIVE, id: "st-2" }],
		["another agent", { ...LIVE, agentId: "agent-2" }],
		["another scope", { ...LIVE, scope: "user" }],
		["an unknown scope", { ...LIVE, scope: "galaxy" }],
		["another scope reference", { ...LIVE, scopeRef: "ref-2" }],
		["another key", { ...LIVE, structured: { type: "fact", key: "other" } }],
		["a missing structured part", { ...LIVE, structured: undefined }],
		["an unknown state", { ...LIVE, state: "pending" }],
		["a procedure family", { ...LIVE, family: "procedure" }],
		["a non-string validTo", { ...LIVE, validTo: 5 }],
		["a non-object handle", "handle"],
	])("rejects %s", (_label, handle) => {
		const result = resolveLiveHandle(SEED, readWith(handle))
		expect(result.ok).toBe(false)
		if (!result.ok) expect(result.reason.length).toBeGreaterThan(0)
	})
})

describe("handleFor and coords", () => {
	const scope = {
		agentId: "agent-1",
		scope: "workspace",
		scopeRef: "ref-1",
	} as const

	it("builds a structured handle at revision 1 unless told otherwise", () => {
		expect(handleFor(scope, "launch-key", "st-1")).toEqual(SEED)
		expect(handleFor(scope, "launch-key", "st-1", 4).revision).toBe(4)
	})

	it("keeps exactly the three identity fields of whatever it is given", () => {
		const target = { ...scope, key: "k", query: "q" }
		expect(coords(target)).toEqual(scope)
	})
})

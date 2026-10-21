import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { runCharacterizedTemporalCoverage } from "./test-helpers/temporal-coverage-characterization.js"

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-04-01T00:00:00Z"))
	resetSearchAdmissionForTests(Date.now())
})

afterEach(() => {
	vi.useRealTimers()
})

describe("temporal-coverage lane characterization", () => {
	it("returns the same outcome rows and results", async () => {
		const { rows, results } = await runCharacterizedTemporalCoverage()
		expect(rows).toMatchInlineSnapshot(`
			[
			  {
			    "outcome": "ok",
			    "resultCount": 3,
			    "stage": "turn-text",
			  },
			  {
			    "outcome": "ok",
			    "resultCount": 7,
			    "stage": "atlas-search",
			  },
			]
		`)
		expect(results).toMatchInlineSnapshot(`
			[
			  {
			    "canonicalId": "temporal-coverage/447506eecf224318",
			    "endLine": 0,
			    "filePath": "temporal-coverage/447506eecf224318",
			    "path": "temporal-coverage/447506eecf224318",
			    "provenance": {
			      "lane": "temporal-coverage-timeline",
			      "sessionIds": [
			        "s-alder",
			        "s-birch",
			      ],
			      "temporalCoverage": true,
			      "temporalTimeline": true,
			    },
			    "score": 3.9699999999999998,
			    "snippet": "Temporal event timeline for: when did the orchard work happen recently
			- 2026-03-10 session=s-alder: we planted the orchard saplings
			- 2026-03-12 session=s-birch: orchard frost netting arrived
			- 2026-03-11 session=s-alder: the orchard needs mulch
			- 2026-03-12 session=s-birch: orchard frost netting arrived
			- 2026-03-12 session=s-alder: orchard irrigation timer
			- 2026-03-13 session=s-birch: unrelated note about tea
			- 2026-03-11 session=s-alder: the orchard needs mulch
			- 2026-03-09 session=s-alder: good morning, quick question",
			    "source": "conversation",
			    "sourceEventIds": [
			      "hit-a",
			      "hit-b",
			      "hit-c",
			      "birch-1",
			      "alder-4",
			      "birch-2",
			      "alder-3",
			      "alder-1",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			  },
			  {
			    "canonicalId": "event:hit-a",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/hit-a",
			    "path": "events/hit-a",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-coverage",
			      "temporalCoverage": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 4.02,
			    "sessionId": "s-alder",
			    "snippet": "we planted the orchard saplings",
			    "source": "conversation",
			    "sourceEventIds": [
			      "hit-a",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "we planted the orchard saplings",
			    "timestamp": 2026-03-10T09:00:00.000Z,
			  },
			  {
			    "canonicalId": "event:hit-b",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/hit-b",
			    "path": "events/hit-b",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-coverage",
			      "temporalCoverage": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 3.02,
			    "sessionId": "s-birch",
			    "snippet": "orchard frost netting arrived",
			    "source": "conversation",
			    "sourceEventIds": [
			      "hit-b",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "orchard frost netting arrived",
			    "timestamp": 2026-03-12T09:00:00.000Z,
			  },
			  {
			    "canonicalId": "event:hit-c",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/hit-c",
			    "path": "events/hit-c",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-coverage",
			      "temporalCoverage": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 2.02,
			    "sessionId": "s-alder",
			    "snippet": "the orchard needs mulch",
			    "source": "conversation",
			    "sourceEventIds": [
			      "hit-c",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "the orchard needs mulch",
			    "timestamp": 2026-03-11T09:00:00.000Z,
			  },
			  {
			    "canonicalId": "event:birch-1",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/birch-1",
			    "path": "events/birch-1",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-session-expansion",
			      "temporalCoverage": true,
			      "temporalSessionExpansion": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 0.08624885844748859,
			    "sessionId": "s-birch",
			    "snippet": "orchard frost netting arrived",
			    "source": "conversation",
			    "sourceEventIds": [
			      "birch-1",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "orchard frost netting arrived",
			    "timestamp": 2026-03-12T09:00:00.000Z,
			  },
			  {
			    "canonicalId": "event:alder-4",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/alder-4",
			    "path": "events/alder-4",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-session-expansion",
			      "temporalCoverage": true,
			      "temporalSessionExpansion": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 0.08624885844748859,
			    "sessionId": "s-alder",
			    "snippet": "orchard irrigation timer",
			    "source": "conversation",
			    "sourceEventIds": [
			      "alder-4",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "orchard irrigation timer",
			    "timestamp": 2026-03-12T09:00:00.000Z,
			  },
			  {
			    "canonicalId": "event:birch-2",
			    "derivation": "user",
			    "endLine": 0,
			    "filePath": "events/birch-2",
			    "path": "events/birch-2",
			    "provenance": {
			      "eventRole": "user",
			      "lane": "temporal-session-expansion",
			      "temporalCoverage": true,
			      "temporalSessionExpansion": true,
			      "turnPrecisionRerank": true,
			    },
			    "role": "user",
			    "scope": "agent",
			    "scopeRef": "agent:fern",
			    "score": 0.05963698630136986,
			    "sessionId": "s-birch",
			    "snippet": "unrelated note about tea",
			    "source": "conversation",
			    "sourceEventIds": [
			      "birch-2",
			    ],
			    "sourceType": "conversation",
			    "startLine": 0,
			    "text": "unrelated note about tea",
			    "timestamp": 2026-03-13T09:00:00.000Z,
			  },
			]
		`)
	})
})

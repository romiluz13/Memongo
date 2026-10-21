import type { Db, Document } from "mongodb"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetSearchAdmissionForTests } from "./mongodb-search-admission.js"
import { searchTemporalCoverageEvents } from "./mongodb-search-lanes.js"
import type { SearchTierOutcome } from "./search-outcomes.js"

// Characterization of the temporal-coverage lane, captured before its
// session-scoped selector moved into its own module: the exact pipelines it
// sends and the exact results it returns must not change with the move.

const questionDate = new Date("2026-03-20T00:00:00Z")
const namespace = {
	agentId: "agent-fern",
	scope: "agent",
	scopeRef: "agent:fern",
} as const

function turn(
	eventId: string,
	sessionId: string,
	day: string,
	body: string,
	score = 1,
): Document {
	return {
		eventId,
		...namespace,
		sessionId,
		role: "user",
		body,
		timestamp: new Date(`2026-03-${day}T09:00:00Z`),
		score,
	}
}

const anchorHits = [
	turn("hit-a", "s-alder", "10", "we planted the orchard saplings", 4),
	turn("hit-b", "s-birch", "12", "orchard frost netting arrived", 3),
	turn("hit-c", "s-alder", "11", "the orchard needs mulch", 2),
]

const expansionRows = [
	turn("alder-1", "s-alder", "09", "good morning, quick question"),
	turn("alder-2", "s-alder", "10", "we planted the orchard saplings"),
	turn("alder-3", "s-alder", "11", "the orchard needs mulch"),
	turn("alder-4", "s-alder", "12", "orchard irrigation timer"),
	turn("birch-1", "s-birch", "12", "orchard frost netting arrived"),
	turn("birch-2", "s-birch", "13", "unrelated note about tea"),
	turn("stray-1", "s-cedar", "13", "orchard in another session"),
]

function database() {
	const pipelines: Document[][] = []
	const db = {
		collection: () => ({
			aggregate: (pipeline: Document[]) => {
				pipelines.push(pipeline)
				return {
					toArray: async () => {
						const isExpansion = pipeline[0]?.$search?.compound?.filter?.some(
							(clause: Document) => clause.in?.path === "sessionId",
						)
						return isExpansion ? expansionRows : anchorHits
					},
				}
			},
		}),
	} as unknown as Db
	return { db, pipelines }
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] })
	vi.setSystemTime(new Date("2026-04-01T00:00:00Z"))
	resetSearchAdmissionForTests(Date.now())
})

afterEach(() => {
	vi.useRealTimers()
})

describe("temporal-coverage lane characterization", () => {
	it("sends the same pipelines and returns the same results", async () => {
		const { db, pipelines } = database()
		const rows: SearchTierOutcome[] = []
		const results = await searchTemporalCoverageEvents({
			db,
			prefix: "mem_",
			query: "when did the orchard work happen recently",
			questionDate,
			...namespace,
			maxResults: 6,
			capabilities: {
				vectorSearch: true,
				textSearch: true,
				scoreFusion: false,
				rankFusion: true,
				storedSource: false,
				vectorIndexMethod: false,
			},
			onTierOutcome: (row) => rows.push(row),
		})
		expect(pipelines).toMatchInlineSnapshot(`
			[
			  [
			    {
			      "$search": {
			        "compound": {
			          "filter": [
			            {
			              "equals": {
			                "path": "agentId",
			                "value": "agent-fern",
			              },
			            },
			            {
			              "equals": {
			                "path": "scope",
			                "value": "agent",
			              },
			            },
			            {
			              "equals": {
			                "path": "scopeRef",
			                "value": "agent:fern",
			              },
			            },
			            {
			              "range": {
			                "lte": 2026-03-20T00:00:00.000Z,
			                "path": "timestamp",
			              },
			            },
			          ],
			          "must": [
			            {
			              "text": {
			                "path": "body",
			                "query": [
			                  "orchard",
			                  "work",
			                  "happen",
			                ],
			              },
			            },
			          ],
			          "should": [
			            {
			              "text": {
			                "path": "body",
			                "query": [
			                  "orchard",
			                  "work",
			                  "happen",
			                ],
			              },
			            },
			            {
			              "near": {
			                "origin": 2026-03-20T00:00:00.000Z,
			                "path": "timestamp",
			                "pivot": 15552000000,
			                "score": {
			                  "boost": {
			                    "value": 2,
			                  },
			                },
			              },
			            },
			          ],
			        },
			        "index": "mem_events_text",
			      },
			    },
			    {
			      "$match": {
			        "agentId": "agent-fern",
			        "scope": "agent",
			        "scopeRef": "agent:fern",
			        "timestamp": {
			          "$lte": 2026-03-20T00:00:00.000Z,
			        },
			      },
			    },
			    {
			      "$match": {
			        "$and": [
			          {
			            "$or": [
			              {
			                "validAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "validAt": {
			                  "$lte": 2026-03-20T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			          {
			            "$or": [
			              {
			                "invalidAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "invalidAt": null,
			              },
			              {
			                "invalidAt": {
			                  "$gt": 2026-03-20T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			          {
			            "$or": [
			              {
			                "expiresAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "expiresAt": {
			                  "$gt": 2026-04-01T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			        ],
			      },
			    },
			    {
			      "$limit": 30,
			    },
			    {
			      "$project": {
			        "_id": 0,
			        "accessCount": 1,
			        "body": 1,
			        "eventId": 1,
			        "role": 1,
			        "scope": 1,
			        "scopeRef": 1,
			        "score": {
			          "$meta": "searchScore",
			        },
			        "sessionId": 1,
			        "timestamp": 1,
			      },
			    },
			  ],
			  [
			    {
			      "$search": {
			        "compound": {
			          "filter": [
			            {
			              "equals": {
			                "path": "agentId",
			                "value": "agent-fern",
			              },
			            },
			            {
			              "equals": {
			                "path": "scope",
			                "value": "agent",
			              },
			            },
			            {
			              "equals": {
			                "path": "scopeRef",
			                "value": "agent:fern",
			              },
			            },
			            {
			              "in": {
			                "path": "sessionId",
			                "value": [
			                  "s-alder",
			                  "s-birch",
			                ],
			              },
			            },
			            {
			              "equals": {
			                "path": "role",
			                "value": "user",
			              },
			            },
			            {
			              "range": {
			                "lte": 2026-03-20T00:00:00.000Z,
			                "path": "timestamp",
			              },
			            },
			          ],
			          "should": [
			            {
			              "text": {
			                "path": "body",
			                "query": [
			                  "orchard",
			                  "work",
			                  "happen",
			                ],
			              },
			            },
			          ],
			        },
			        "index": "mem_events_text",
			      },
			    },
			    {
			      "$match": {
			        "agentId": "agent-fern",
			        "role": "user",
			        "scope": "agent",
			        "scopeRef": "agent:fern",
			        "sessionId": {
			          "$in": [
			            "s-alder",
			            "s-birch",
			          ],
			        },
			        "timestamp": {
			          "$lte": 2026-03-20T00:00:00.000Z,
			        },
			      },
			    },
			    {
			      "$match": {
			        "$and": [
			          {
			            "$or": [
			              {
			                "validAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "validAt": {
			                  "$lte": 2026-03-20T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			          {
			            "$or": [
			              {
			                "invalidAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "invalidAt": null,
			              },
			              {
			                "invalidAt": {
			                  "$gt": 2026-03-20T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			          {
			            "$or": [
			              {
			                "expiresAt": {
			                  "$exists": false,
			                },
			              },
			              {
			                "expiresAt": {
			                  "$gt": 2026-04-01T00:00:00.000Z,
			                },
			              },
			            ],
			          },
			        ],
			      },
			    },
			    {
			      "$limit": 120,
			    },
			    {
			      "$project": {
			        "_id": 0,
			        "accessCount": 1,
			        "body": 1,
			        "eventId": 1,
			        "role": 1,
			        "scope": 1,
			        "scopeRef": 1,
			        "sessionId": 1,
			        "timestamp": 1,
			      },
			    },
			  ],
			]
		`)
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

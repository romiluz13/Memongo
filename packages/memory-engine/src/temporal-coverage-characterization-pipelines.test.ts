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
	it("sends the same pipelines", async () => {
		const { pipelines } = await runCharacterizedTemporalCoverage()
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
	})
})

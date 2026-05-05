const contractFixtures = {
	corePaths: [
		"/health",
		"/openapi.json",
		"/v1/search",
		"/v1/search-detailed",
		"/v1/recall-conversation",
		"/v1/import/conversations",
		"/v1/search-kb",
		"/v1/read-file",
		"/v1/add",
		"/v1/write-event",
		"/v1/extract",
		"/v1/write-structured",
		"/v1/write-procedure",
		"/v1/profile",
		"/v1/hydrate-active-slate",
		"/v1/discovery-projection",
		"/v1/context-bundle",
		"/v1/state",
		"/v1/status",
		"/v1/status/detailed",
		"/v1/stats",
		"/v1/sync",
		"/v1/probes/embedding",
		"/v1/probes/vector",
		"/v1/admin/relevance/explain",
		"/v1/admin/relevance/benchmark",
		"/v1/admin/benchmarks/ingest",
		"/v1/admin/relevance/report",
		"/v1/admin/relevance/sample-rate",
		"/v1/admin/access-summaries",
		"/v1/admin/access-trends",
		"/v1/admin/traces",
		"/v1/admin/traces/{traceId}",
		"/v1/chain-trace",
		"/v1/jobs",
		"/v1/jobs/{jobId}",
		"/v1/novelty-scan",
		"/v1/consolidate",
	],
	aliasCases: [
		{
			name: "search alias payload",
			path: "/v1/search",
			bridgeMock: "memongoBridgeSearch",
			body: {
				q: "remember this",
				containerTag: "user-123",
				maxResults: 3,
			},
			expected: {
				query: "remember this",
				maxResults: 3,
				sessionKey: "user-123",
			},
		},
		{
			name: "search explicit sessionKey alias",
			path: "/v1/search",
			bridgeMock: "memongoBridgeSearch",
			body: {
				query: "explicit scope",
				sessionKey: "session-7",
				limit: 2,
			},
			expected: {
				query: "explicit scope",
				maxResults: 2,
				sessionKey: "session-7",
			},
		},
		{
			name: "add containerTag alias",
			path: "/v1/add",
			bridgeMock: "memongoBridgeAdd",
			body: {
				content: "store this",
				containerTag: "account-42",
			},
			expected: {
				content: "store this",
				sessionId: "account-42",
			},
		},
		{
			name: "add explicit sessionId",
			path: "/v1/add",
			bridgeMock: "memongoBridgeAdd",
			body: {
				content: "store this",
				sessionId: "session-42",
			},
			expected: {
				content: "store this",
				sessionId: "session-42",
			},
		},
		{
			name: "profile containerTag alias",
			path: "/v1/profile",
			bridgeMock: "memongoBridgeProfile",
			body: {
				containerTag: "account-42",
			},
			expected: {
				scopeRef: "account-42",
			},
		},
		{
			name: "profile explicit scopeRef",
			path: "/v1/profile",
			bridgeMock: "memongoBridgeProfile",
			body: {
				scopeRef: "scope-99",
			},
			expected: {
				scopeRef: "scope-99",
			},
		},
	],
	deprecatedRequestProperties: {
		"/v1/search": ["q", "maxResults", "containerTag"],
		"/v1/add": ["containerTag"],
		"/v1/profile": ["containerTag"],
	},
} as const

export default contractFixtures

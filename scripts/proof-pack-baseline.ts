const proofPackBaseline = {
	requiredPaths: [
		"/v1/search",
		"/v1/search-detailed",
		"/v1/hydrate-active-slate",
		"/v1/discovery-projection",
		"/v1/context-bundle",
		"/v1/add",
		"/v1/profile",
		"/v1/status",
	],
	requiredChecks: [
		"health",
		"openapi",
		"writeEvent",
		"add",
		"writeStructured",
		"writeProcedure",
		"search",
		"searchDetailed",
		"hydrateActiveSlate",
		"discoveryProjection",
		"contextBundle",
		"profile",
		"status",
		"stats",
		"relevanceReport",
	],
} as const

export default proofPackBaseline

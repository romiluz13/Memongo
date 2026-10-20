import {
	MemongoClient,
	MemongoClientError,
	type MemongoScope,
	type MemongoStableHandle,
} from "@memongo/client"

const REQUEST_TIMEOUT_MS = 30_000

export type LifecycleAsInput = {
	handle: MemongoStableHandle
	agentId: string
	scope: MemongoScope
	scopeRef: string
}

type ClientMethods =
	| "search"
	| "searchDetailed"
	| "recallConversation"
	| "readFile"
	| "profile"
	| "hydrateActiveSlate"
	| "state"
	| "buildDiscoveryProjection"
	| "buildContextBundle"
	| "relevanceExplain"
	| "traceChain"
	| "scanNovelty"
	| "writeEvent"
	| "writeStructured"
	| "eraseAgent"
	| "getDetailedStatus"
	| "status"
	| "getLifecycleItem"
	| "getLifecycleHistory"
	| "updateLifecycleItem"
	| "deleteLifecycleItem"

export type ProbeApi = Pick<MemongoClient, ClientMethods> & {
	lifecycleGetAs(input: LifecycleAsInput): Promise<unknown>
	lifecycleHistoryAs(input: LifecycleAsInput): Promise<unknown>
}

export type ProbeApiOptions = {
	baseUrl: string
	apiKey: string
}

export function createProbeApi(options: ProbeApiOptions): ProbeApi {
	const client = new MemongoClient({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		maxRetries: 0,
		timeoutMs: REQUEST_TIMEOUT_MS,
	})

	async function postAs(
		path: string,
		input: LifecycleAsInput,
	): Promise<unknown> {
		const response = await fetch(`${options.baseUrl}${path}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${options.apiKey}`,
			},
			body: JSON.stringify({
				handle: input.handle,
				agentId: input.agentId,
				scope: input.scope,
				scopeRef: input.scopeRef,
			}),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
		const text = await response.text()
		if (!response.ok) throw new MemongoClientError(response.status, text)
		return JSON.parse(text) as unknown
	}

	return {
		search: client.search.bind(client),
		searchDetailed: client.searchDetailed.bind(client),
		recallConversation: client.recallConversation.bind(client),
		readFile: client.readFile.bind(client),
		profile: client.profile.bind(client),
		hydrateActiveSlate: client.hydrateActiveSlate.bind(client),
		state: client.state.bind(client),
		buildDiscoveryProjection: client.buildDiscoveryProjection.bind(client),
		buildContextBundle: client.buildContextBundle.bind(client),
		relevanceExplain: client.relevanceExplain.bind(client),
		traceChain: client.traceChain.bind(client),
		scanNovelty: client.scanNovelty.bind(client),
		writeEvent: client.writeEvent.bind(client),
		writeStructured: client.writeStructured.bind(client),
		eraseAgent: client.eraseAgent.bind(client),
		getDetailedStatus: client.getDetailedStatus.bind(client),
		status: client.status.bind(client),
		getLifecycleItem: client.getLifecycleItem.bind(client),
		getLifecycleHistory: client.getLifecycleHistory.bind(client),
		updateLifecycleItem: client.updateLifecycleItem.bind(client),
		deleteLifecycleItem: client.deleteLifecycleItem.bind(client),
		lifecycleGetAs: (input) => postAs("/v1/lifecycle/get", input),
		lifecycleHistoryAs: (input) => postAs("/v1/lifecycle/history", input),
	}
}

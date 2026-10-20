import {
	MemongoClient,
	MemongoClientError,
	type MemongoLifecycleHistoryEntry,
	type MemongoLifecycleItem,
	type MemongoScope,
	type MemongoStableHandle,
} from "@memongo/client"

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
	lifecycleGetAs(input: LifecycleAsInput): Promise<MemongoLifecycleItem>
	lifecycleHistoryAs(
		input: LifecycleAsInput,
	): Promise<MemongoLifecycleHistoryEntry[]>
}

export type ProbeApiOptions = {
	baseUrl: string
	apiKey: string
	timeoutMs?: number
	fetchImpl?: typeof fetch
}

export function createProbeApi(options: ProbeApiOptions): ProbeApi {
	const timeoutMs = options.timeoutMs ?? 30_000
	const doFetch = options.fetchImpl ?? fetch
	const client = new MemongoClient({
		baseUrl: options.baseUrl,
		apiKey: options.apiKey,
		maxRetries: 0,
		timeoutMs,
	})

	async function postAs(
		path: string,
		input: LifecycleAsInput,
	): Promise<unknown> {
		const response = await doFetch(`${options.baseUrl}${path}`, {
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
			signal: AbortSignal.timeout(timeoutMs),
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
		lifecycleGetAs: async (input) =>
			(await postAs("/v1/lifecycle/get", input)) as MemongoLifecycleItem,
		lifecycleHistoryAs: async (input) =>
			(await postAs(
				"/v1/lifecycle/history",
				input,
			)) as MemongoLifecycleHistoryEntry[],
	}
}

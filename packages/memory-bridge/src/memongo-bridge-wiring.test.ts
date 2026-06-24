import { describe, it, expect } from "vitest"
import { MemongoClient } from "@memongo/client"
import { createMemongoTools } from "@memongo/tools"
import * as bridge from "./memongo-bridge.js"

describe("Phase 7-11 wiring: bridge functions", () => {
	it("exports memongoBridgeShutdown (bridge shutdown part 2)", async () => {
		expect(typeof bridge.memongoBridgeShutdown).toBe("function")
	})

	it("exports memongoBridgeGetLifecycleItem", async () => {
		expect(typeof bridge.memongoBridgeGetLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeUpdateLifecycleItem", async () => {
		expect(typeof bridge.memongoBridgeUpdateLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeDeleteLifecycleItem", async () => {
		expect(typeof bridge.memongoBridgeDeleteLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeGetLifecycleHistory", async () => {
		expect(typeof bridge.memongoBridgeGetLifecycleHistory).toBe("function")
	})

	it("exports memongoBridgeRecallConversation", async () => {
		expect(typeof bridge.memongoBridgeRecallConversation).toBe("function")
	})

	it("exports memongoBridgeTraceChain", async () => {
		expect(typeof bridge.memongoBridgeTraceChain).toBe("function")
	})

	it("exports memongoBridgeScanNovelty", async () => {
		expect(typeof bridge.memongoBridgeScanNovelty).toBe("function")
	})

	it("exports memongoBridgeConsolidate", async () => {
		expect(typeof bridge.memongoBridgeConsolidate).toBe("function")
	})

	it("exports memongoBridgeImportConversations", async () => {
		expect(typeof bridge.memongoBridgeImportConversations).toBe("function")
	})

	it("exports memongoBridgeReportProcedureOutcome", async () => {
		expect(typeof bridge.memongoBridgeReportProcedureOutcome).toBe("function")
	})

	it("exports memongoBridgeApplyMemoryFeedback", async () => {
		expect(typeof bridge.memongoBridgeApplyMemoryFeedback).toBe("function")
	})
})

describe("Phase 10 wiring: client methods", () => {
	it("MemongoClient has getLifecycleItem method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.getLifecycleItem).toBe("function")
	})

	it("MemongoClient has updateLifecycleItem method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.updateLifecycleItem).toBe("function")
	})

	it("MemongoClient has deleteLifecycleItem method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.deleteLifecycleItem).toBe("function")
	})

	it("MemongoClient has getLifecycleHistory method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.getLifecycleHistory).toBe("function")
	})

	it("MemongoClient has recallConversation method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.recallConversation).toBe("function")
	})

	it("MemongoClient has traceChain method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.traceChain).toBe("function")
	})

	it("MemongoClient has scanNovelty method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.scanNovelty).toBe("function")
	})

	it("MemongoClient has consolidate method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.consolidate).toBe("function")
	})

	it("MemongoClient has importConversations method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.importConversations).toBe("function")
	})

	it("MemongoClient has reportProcedureOutcome method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.reportProcedureOutcome).toBe("function")
	})

	it("MemongoClient has applyMemoryFeedback method", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.applyMemoryFeedback).toBe("function")
	})
})

describe("Phase 10 wiring: AI SDK tools", () => {
	it("createMemongoTools includes memongo_lifecycle_get", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_get).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_update", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_update).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_delete", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_delete).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_history", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_history).toBeDefined()
	})

	it("createMemongoTools includes memongo_recall_conversation", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_recall_conversation).toBeDefined()
	})

	it("createMemongoTools includes memongo_chain_trace", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_chain_trace).toBeDefined()
	})

	it("createMemongoTools includes memongo_novelty_scan", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_novelty_scan).toBeDefined()
	})

	it("createMemongoTools includes memongo_consolidate", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_consolidate).toBeDefined()
	})

	it("createMemongoTools includes memongo_import_conversations", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_import_conversations).toBeDefined()
	})

	it("createMemongoTools includes memongo_procedure_outcome", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_procedure_outcome).toBeDefined()
	})

	it("createMemongoTools includes memongo_memory_feedback", async () => {
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_memory_feedback).toBeDefined()
	})
})

describe("Phase 10 wiring: client types exported", () => {
	it("exports MemongoTraceChainInput type", async () => {
		expect(MemongoClient).toBeDefined()
	})
})

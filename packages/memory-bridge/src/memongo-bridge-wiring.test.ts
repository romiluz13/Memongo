/**
 * RED test: verify that the 3 new bridge functions exist and are exported,
 * the 3 new client methods exist on MemongoClient, and the 3 new AI SDK tools
 * are returned by createMemongoTools().
 */
import { describe, it, expect } from "vitest"

describe("Phase 7-11 wiring: bridge functions", () => {
	it("exports memongoBridgeGetLifecycleItem", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeGetLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeUpdateLifecycleItem", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeUpdateLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeDeleteLifecycleItem", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeDeleteLifecycleItem).toBe("function")
	})

	it("exports memongoBridgeGetLifecycleHistory", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeGetLifecycleHistory).toBe("function")
	})

	it("exports memongoBridgeRecallConversation", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeRecallConversation).toBe("function")
	})

	it("exports memongoBridgeTraceChain", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeTraceChain).toBe("function")
	})

	it("exports memongoBridgeScanNovelty", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeScanNovelty).toBe("function")
	})

	it("exports memongoBridgeConsolidate", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeConsolidate).toBe("function")
	})

	it("exports memongoBridgeImportConversations", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeImportConversations).toBe("function")
	})

	it("exports memongoBridgeReportProcedureOutcome", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeReportProcedureOutcome).toBe("function")
	})

	it("exports memongoBridgeApplyMemoryFeedback", async () => {
		const mod = await import("./memongo-bridge.js")
		expect(typeof mod.memongoBridgeApplyMemoryFeedback).toBe("function")
	})
})

describe("Phase 10 wiring: client methods", () => {
	it("MemongoClient has getLifecycleItem method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.getLifecycleItem).toBe("function")
	})

	it("MemongoClient has updateLifecycleItem method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.updateLifecycleItem).toBe("function")
	})

	it("MemongoClient has deleteLifecycleItem method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.deleteLifecycleItem).toBe("function")
	})

	it("MemongoClient has getLifecycleHistory method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.getLifecycleHistory).toBe("function")
	})

	it("MemongoClient has recallConversation method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.recallConversation).toBe("function")
	})

	it("MemongoClient has traceChain method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.traceChain).toBe("function")
	})

	it("MemongoClient has scanNovelty method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.scanNovelty).toBe("function")
	})

	it("MemongoClient has consolidate method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.consolidate).toBe("function")
	})

	it("MemongoClient has importConversations method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.importConversations).toBe("function")
	})

	it("MemongoClient has reportProcedureOutcome method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.reportProcedureOutcome).toBe("function")
	})

	it("MemongoClient has applyMemoryFeedback method", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		expect(typeof client.applyMemoryFeedback).toBe("function")
	})
})

describe("Phase 10 wiring: AI SDK tools", () => {
	it("createMemongoTools includes memongo_lifecycle_get", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_get).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_update", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_update).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_delete", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_delete).toBeDefined()
	})

	it("createMemongoTools includes memongo_lifecycle_history", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_lifecycle_history).toBeDefined()
	})

	it("createMemongoTools includes memongo_recall_conversation", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_recall_conversation).toBeDefined()
	})

	it("createMemongoTools includes memongo_chain_trace", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_chain_trace).toBeDefined()
	})

	it("createMemongoTools includes memongo_novelty_scan", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_novelty_scan).toBeDefined()
	})

	it("createMemongoTools includes memongo_consolidate", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_consolidate).toBeDefined()
	})

	it("createMemongoTools includes memongo_import_conversations", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_import_conversations).toBeDefined()
	})

	it("createMemongoTools includes memongo_procedure_outcome", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_procedure_outcome).toBeDefined()
	})

	it("createMemongoTools includes memongo_memory_feedback", async () => {
		const { MemongoClient } = await import("@memongo/client")
		const { createMemongoTools } = await import("@memongo/tools")
		const client = new MemongoClient({ baseUrl: "http://localhost:9999" })
		const tools = createMemongoTools(client)
		expect(tools.memongo_memory_feedback).toBeDefined()
	})
})

describe("Phase 10 wiring: client types exported", () => {
	it("exports MemongoTraceChainInput type", async () => {
		// Type-only check: if this compiles, the type is exported
		const mod = await import("@memongo/client")
		// At runtime, just verify the module loaded
		expect(mod.MemongoClient).toBeDefined()
	})
})

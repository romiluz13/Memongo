import os from "node:os"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { resolveAgentWorkspaceDir } from "./agent-config.js"

describe("resolveAgentWorkspaceDir", () => {
	it("keeps simple agent ids on the historical default path", () => {
		expect(resolveAgentWorkspaceDir({}, "main")).toBe(
			path.join(os.homedir(), ".memongo", "agents", "main"),
		)
	})

	it("keeps traversal-shaped agent ids inside the agents directory", () => {
		const root = path.join(os.homedir(), ".memongo", "agents")
		const resolved = resolveAgentWorkspaceDir({}, "../../../..")
		const relative = path.relative(root, resolved)

		expect(relative).not.toBe("")
		expect(relative.startsWith("..")).toBe(false)
		expect(path.isAbsolute(relative)).toBe(false)
	})

	it("honors an explicitly configured workspace", () => {
		expect(
			resolveAgentWorkspaceDir(
				{ agents: { defaults: { workspace: "/tmp/memongo-workspace" } } },
				"../../../..",
			),
		).toBe("/tmp/memongo-workspace")
	})
})

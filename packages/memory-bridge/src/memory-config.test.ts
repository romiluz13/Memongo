import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import {
	buildMemongoConfig,
	resolveMemongoConfigFilePath,
	resolveMemongoStandaloneWorkspaceDir,
	resolveBridgeConfig,
} from "./memory-config.js"

describe("memory-config standalone", () => {
	const prev = { ...process.env }

	afterEach(() => {
		process.env = { ...prev }
	})

	it("uses ~/.memongo/workspace when MEMONGO_WORKSPACE_DIR is unset", () => {
		const ws = resolveMemongoStandaloneWorkspaceDir({})
		expect(ws).toBe(path.join(os.homedir(), ".memongo", "workspace"))
	})

	it("respects MEMONGO_WORKSPACE_DIR", () => {
		const dir = resolveMemongoStandaloneWorkspaceDir({
			MEMONGO_WORKSPACE_DIR: "/tmp/mws",
		})
		expect(dir).toBe("/tmp/mws")
	})

	it("buildMemongoConfig preserves the mongodb backend by default", () => {
		process.env = { ...prev, MEMONGO_STANDALONE: "1" }
		const cfg = buildMemongoConfig(process.env)
		expect(cfg.memory?.backend).toBe("mongodb")
	})

	it("buildMemongoConfig uses MEMONGO_MONGODB_URI when it is set", () => {
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI: "mongodb://127.0.0.1:27017/x",
		}
		const cfg = buildMemongoConfig(process.env)
		expect(cfg.memory?.mongodb?.uri).toBe("mongodb://127.0.0.1:27017/x")
	})

	it("resolveBridgeConfig reads from process.env", () => {
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI: "mongodb://127.0.0.1:27017/bridge",
		}
		const cfg = resolveBridgeConfig()
		expect(cfg.memory?.mongodb?.uri).toBe("mongodb://127.0.0.1:27017/bridge")
	})

	it("reads collection prefix from process.env", () => {
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI: "mongodb://127.0.0.1:27017/bridge",
			MEMONGO_MONGODB_COLLECTION_PREFIX: "memongo_bench_",
		}
		const cfg = buildMemongoConfig(process.env)
		expect(cfg.memory?.mongodb?.collectionPrefix).toBe("memongo_bench_")
	})

	it("buildMemongoConfig merges URI from env", () => {
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI:
				"mongodb://127.0.0.1:27017/memongo?directConnection=true",
		}
		const cfg = buildMemongoConfig(process.env)
		expect(cfg.memory?.backend).toBe("mongodb")
		expect(cfg.memory?.mongodb?.uri).toBe(
			"mongodb://127.0.0.1:27017/memongo?directConnection=true",
		)
		expect(cfg.agents?.defaults?.workspace).toBeTruthy()
	})

	// ---------------------------------------------------------------------------
	// P2.6: MEMONGO_FORCE_MONGODB_URI precedence matrix.
	// Rule (shared with the engine via @memongo/lib): FORCE wins over every
	// other URI source, in every layer. Among non-force sources the bridge is
	// env-first (plain env URI beats the file-config URI).
	// ---------------------------------------------------------------------------

	function envWithFileConfig(
		fileUri: string | undefined,
		extra: NodeJS.ProcessEnv = {},
	): { env: NodeJS.ProcessEnv; cleanup: () => void } {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-cfg-p26-"))
		const cfgPath = path.join(dir, "memongo.json")
		if (fileUri !== undefined) {
			fs.writeFileSync(
				cfgPath,
				JSON.stringify({ memory: { mongodb: { uri: fileUri } } }),
				"utf-8",
			)
		}
		return {
			env: { MEMONGO_CONFIG_PATH: cfgPath, ...extra },
			cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
		}
	}

	it("plain env URI only -> plain env URI wins", () => {
		const { env, cleanup } = envWithFileConfig(undefined, {
			MEMONGO_MONGODB_URI: "mongodb://plain:27017/db",
		})
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://plain:27017/db")
		} finally {
			cleanup()
		}
	})

	it("force env URI only -> force URI wins", () => {
		const { env, cleanup } = envWithFileConfig(undefined, {
			MEMONGO_FORCE_MONGODB_URI: "mongodb://force:27017/db",
		})
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://force:27017/db")
		} finally {
			cleanup()
		}
	})

	it("plain + force env URIs -> force URI wins (P2.6 conflict fix)", () => {
		const { env, cleanup } = envWithFileConfig(undefined, {
			MEMONGO_MONGODB_URI: "mongodb://plain:27017/db",
			MEMONGO_FORCE_MONGODB_URI: "mongodb://force:27017/db",
		})
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://force:27017/db")
		} finally {
			cleanup()
		}
	})

	it("neither env URI + file-config URI -> file URI wins", () => {
		const { env, cleanup } = envWithFileConfig("mongodb://file:27017/db")
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://file:27017/db")
		} finally {
			cleanup()
		}
	})

	it("plain + force + file-config URI -> force URI wins over both", () => {
		const { env, cleanup } = envWithFileConfig("mongodb://file:27017/db", {
			MEMONGO_MONGODB_URI: "mongodb://plain:27017/db",
			MEMONGO_FORCE_MONGODB_URI: "mongodb://force:27017/db",
		})
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://force:27017/db")
		} finally {
			cleanup()
		}
	})

	it("plain env URI + file-config URI -> plain env URI wins (env-first)", () => {
		const { env, cleanup } = envWithFileConfig("mongodb://file:27017/db", {
			MEMONGO_MONGODB_URI: "mongodb://plain:27017/db",
		})
		try {
			const cfg = buildMemongoConfig(env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://plain:27017/db")
		} finally {
			cleanup()
		}
	})

	it("reads optional memongo.json when present", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "memongo-cfg-"))
		const cfgPath = path.join(dir, "memongo.json")
		fs.writeFileSync(
			cfgPath,
			JSON.stringify({
				memory: {
					mongodb: { database: "fromfile" },
				},
			}),
			"utf-8",
		)
		process.env = {
			...prev,
			MEMONGO_CONFIG_PATH: cfgPath,
			MEMONGO_MONGODB_URI: "mongodb://h/",
		}
		const cfg = buildMemongoConfig(process.env)
		expect(cfg.memory?.mongodb?.database).toBe("fromfile")
		expect(resolveMemongoConfigFilePath(process.env)).toBe(cfgPath)
		fs.rmSync(dir, { recursive: true, force: true })
	})
})

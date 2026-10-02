import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
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
		// MEMONGO_CONFIG_PATH selects the file explicitly, so it must always
		// exist and be valid: an explicitly selected missing file now fails
		// clearly instead of silently reverting to env/defaults.
		fs.writeFileSync(
			cfgPath,
			fileUri === undefined
				? "{}"
				: JSON.stringify({ memory: { mongodb: { uri: fileUri } } }),
			"utf-8",
		)
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

// ---------------------------------------------------------------------------
// Loader failure behavior: an absent OPTIONAL default config is allowed, but
// an explicitly selected missing file, an unreadable existing file, malformed
// JSON, or a non-object top level must fail clearly instead of silently
// dropping file-only settings (for example retention) back to defaults.
// Error text must never echo file content (it may carry credentials).
// ---------------------------------------------------------------------------

describe("memongo.json loader failure behavior", () => {
	const prev = { ...process.env }

	afterEach(() => {
		process.env = { ...prev }
	})

	function tempDir(): string {
		return fs.mkdtempSync(path.join(os.tmpdir(), "memongo-cfg-fail-"))
	}

	it("allows an absent default config file", () => {
		const home = tempDir()
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home)
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI: "mongodb://127.0.0.1:27017/x",
		}
		delete process.env.MEMONGO_CONFIG_PATH
		try {
			const cfg = buildMemongoConfig(process.env)
			expect(cfg.memory?.mongodb?.uri).toBe("mongodb://127.0.0.1:27017/x")
		} finally {
			homedir.mockRestore()
			fs.rmSync(home, { recursive: true, force: true })
		}
	})

	it("throws when the MEMONGO_CONFIG_PATH-selected file is missing", () => {
		const dir = tempDir()
		const cfgPath = path.join(dir, "absent.json")
		process.env = { ...prev, MEMONGO_CONFIG_PATH: cfgPath }
		expect(() => buildMemongoConfig(process.env)).toThrow(
			/Memongo config file not found at ".*absent\.json".*MEMONGO_CONFIG_PATH/,
		)
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("throws on malformed JSON without echoing file content", () => {
		const dir = tempDir()
		const cfgPath = path.join(dir, "memongo.json")
		fs.writeFileSync(
			cfgPath,
			'{"memory":{"mongodb":{"uri":"mongodb://user:SECRET-CREDENTIAL@host/db"},},}',
			"utf-8",
		)
		process.env = { ...prev, MEMONGO_CONFIG_PATH: cfgPath }
		let message = ""
		try {
			buildMemongoConfig(process.env)
		} catch (error) {
			message = (error as Error).message
		}
		expect(message).toMatch(/is not valid JSON/)
		expect(message).toContain(cfgPath)
		expect(message).not.toContain("SECRET-CREDENTIAL")
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("throws on a non-object top level (array)", () => {
		const dir = tempDir()
		const cfgPath = path.join(dir, "memongo.json")
		fs.writeFileSync(cfgPath, '["memory"]', "utf-8")
		process.env = { ...prev, MEMONGO_CONFIG_PATH: cfgPath }
		expect(() => buildMemongoConfig(process.env)).toThrow(
			/must contain a JSON object at the top level/,
		)
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("throws on a non-object top level (primitive)", () => {
		const dir = tempDir()
		const cfgPath = path.join(dir, "memongo.json")
		fs.writeFileSync(cfgPath, "42", "utf-8")
		process.env = { ...prev, MEMONGO_CONFIG_PATH: cfgPath }
		expect(() => buildMemongoConfig(process.env)).toThrow(
			/must contain a JSON object at the top level/,
		)
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("throws on malformed JSON at the default path too", () => {
		const home = tempDir()
		const cfgDir = path.join(home, ".memongo")
		fs.mkdirSync(cfgDir, { recursive: true })
		fs.writeFileSync(path.join(cfgDir, "memongo.json"), "{not json", "utf-8")
		const homedir = vi.spyOn(os, "homedir").mockReturnValue(home)
		process.env = {
			...prev,
			MEMONGO_MONGODB_URI: "mongodb://127.0.0.1:27017/x",
		}
		delete process.env.MEMONGO_CONFIG_PATH
		try {
			expect(() => buildMemongoConfig(process.env)).toThrow(/is not valid JSON/)
		} finally {
			homedir.mockRestore()
			fs.rmSync(home, { recursive: true, force: true })
		}
	})

	it("throws when the existing config file cannot be read", () => {
		// A directory used as the config path makes readFileSync fail
		// deterministically across platforms without relying on permission bits.
		const dir = tempDir()
		process.env = { ...prev, MEMONGO_CONFIG_PATH: dir }
		expect(() => buildMemongoConfig(process.env)).toThrow(/could not be read/)
		fs.rmSync(dir, { recursive: true, force: true })
	})
})

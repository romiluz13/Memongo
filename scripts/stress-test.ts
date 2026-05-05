const BASE = process.env.MEMONGO_API_URL ?? "http://127.0.0.1:3847"
const API_KEY = process.env.MEMONGO_API_KEY ?? ""

type PhaseResult = {
	name: string
	passed: number
	failed: number
	avgMs: number
	errors: string[]
}

const headers: Record<string, string> = { "Content-Type": "application/json" }
if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`

async function api(
	method: string,
	path: string,
	body?: unknown,
): Promise<{ ok: boolean; status: number; data: unknown; ms: number }> {
	const start = performance.now()
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers,
		body: body ? JSON.stringify(body) : undefined,
	})
	const ms = performance.now() - start
	const data = await res.json().catch(() => null)
	return { ok: res.ok, status: res.status, data, ms }
}

function percentile(arr: number[], p: number): number {
	if (arr.length === 0) return 0
	const sorted = [...arr].sort((a, b) => a - b)
	const idx = Math.ceil((p / 100) * sorted.length) - 1
	return sorted[Math.max(0, idx)]
}

// ─── PHASE 1: WRITE STRESS ─────────────────────────────────────────────────

const CONVERSATION_BODIES = [
	"I'm working on a SaaS product called DataVault. It's a data pipeline tool for small teams. We need to support PostgreSQL, MySQL, and MongoDB as sources.",
	"The architecture should use event sourcing with a CQRS pattern. We'll have a command bus for writes and materialized views for reads. Redis for the event store buffer.",
	"For authentication, let's go with OAuth2 + PKCE for the web app and API keys with rotation for the CLI. We need RBAC with workspace-level isolation.",
	"Meeting notes from sprint planning: decided to prioritize the connector framework first. Each connector will be a plugin with a standard interface. Target: 10 connectors by Q3.",
	"Bug report: the CSV parser fails on files with mixed line endings (CR+LF and LF). The regex splitter assumes uniform endings. Need to normalize before splitting.",
	"Code review feedback: the retry logic in the HTTP client doesn't respect Retry-After headers. Also missing exponential backoff with jitter for 429 responses.",
	"Performance analysis: the main bottleneck is the aggregation pipeline for dashboard widgets. The $lookup stage is doing a full collection scan. Need compound indexes.",
	"Customer feedback from Acme Corp: they love the real-time sync but need better conflict resolution for concurrent edits. Currently last-write-wins is losing data.",
	"Technical spec for the notification system: use WebSocket for real-time, SSE as fallback, and email digest for offline users. Fan-out should be async via job queue.",
	"Security audit findings: 1) API keys stored in plaintext in config table, 2) No rate limiting on auth endpoints, 3) CORS allows *, 4) Missing CSP headers.",
	"Database migration plan: moving from single-tenant to multi-tenant schema. Each tenant gets a schema prefix. Shared tables use RLS policies. Target: zero downtime.",
	"The ML pipeline for anomaly detection uses an isolation forest model trained on 30 days of metrics. Inference runs every 5 minutes. Alert threshold is 2 sigma.",
	"Infrastructure costs report: $4,200/month on AWS. Biggest items: RDS Multi-AZ ($1,800), ECS Fargate ($900), CloudFront ($600), S3 ($300), other ($600).",
	"Onboarding flow redesign: reduce steps from 7 to 3. Step 1: connect data source. Step 2: select tables. Step 3: configure sync schedule. Remove the manual schema mapping.",
	"API versioning strategy: URL-based (/v1/, /v2/) for major changes. Header-based (Accept-Version) for minor. Sunset period of 6 months with deprecation warnings.",
	"The webhook delivery system needs at-least-once semantics. Store events in an outbox table, poll with a worker, deliver with retry. Dead letter queue after 10 failures.",
	"Monitoring stack: Prometheus for metrics, Grafana for dashboards, Loki for logs, Tempo for traces. All self-hosted on a dedicated k8s node pool.",
	"Data quality rules engine: define rules as JSON schemas per table. Run validation on each sync batch. Quarantine failed rows. Dashboard shows quality score trends.",
	"Testing strategy: unit tests with vitest (>80% coverage), integration tests with testcontainers (PostgreSQL, Redis), E2E tests with Playwright for critical flows.",
	"Release process: trunk-based development, feature flags for incomplete work, canary deploys to 5% of traffic, automated rollback on error rate spike above 1%.",
	"I prefer dark mode in all my tools. My timezone is UTC+2. I typically work from 9am to 6pm. I use VS Code with Vim keybindings. My terminal is kitty.",
	"Remember that I'm allergic to peanuts and shellfish. When suggesting restaurants or recipes, always exclude these. I also don't eat red meat.",
	"My team members are: Alice (backend lead), Bob (frontend), Carol (DevOps), Dave (QA). Alice and I pair program on Tuesdays. Bob is on parental leave until April.",
	"The project deadline is March 30, 2026. We have 3 milestones: M1 (core engine, Feb 15), M2 (connectors, Mar 10), M3 (dashboard + polish, Mar 28).",
	"Coding conventions: TypeScript strict mode, no any, prefer const, 2-space indent, single quotes, trailing commas. Use zod for runtime validation. Prefer composition over inheritance.",
	"我们的中国市场策略需要本地化支付集成，支持支付宝和微信支付。数据必须存储在中国境内的服务器上，符合数据本地化法规。",
	"Le système de traduction doit supporter le français, l'allemand, le japonais et le chinois simplifié. Utiliser ICU MessageFormat pour la pluralisation.",
	"The Kubernetes deployment uses Helm charts with environment-specific values files. Staging mirrors production topology but with smaller instance sizes.",
	"GraphQL schema design: use Relay-style connections for pagination. Implement DataLoader for N+1 prevention. Rate limit by query complexity score, not request count.",
	"Feature flag system design: use LaunchDarkly SDK with local fallback cache. Flags are evaluated client-side for UI and server-side for API. Audit log all flag changes.",
]

const SCOPES = ["session", "agent", "workspace", "global"] as const
const ROLES = ["user", "assistant", "system", "tool"] as const

async function phase1WriteStress(): Promise<PhaseResult> {
	const result: PhaseResult = {
		name: "Phase 1 (Writes)",
		passed: 0,
		failed: 0,
		avgMs: 0,
		errors: [],
	}
	const latencies: number[] = []

	console.log("\n--- Phase 1: Write Stress ---")

	for (let i = 0; i < 30; i++) {
		const r = await api("POST", "/v1/write-event", {
			role: ROLES[i % ROLES.length],
			body: CONVERSATION_BODIES[i % CONVERSATION_BODIES.length],
			sessionId: `session-${Math.floor(i / 5)}`,
			scope: SCOPES[i % SCOPES.length],
		})
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(`write-event[${i}]: ${r.status}`)
			process.stdout.write("X")
		}
	}
	console.log()

	for (let i = 0; i < 15; i++) {
		const r = await api("POST", "/v1/add", {
			content: CONVERSATION_BODIES[(i + 10) % CONVERSATION_BODIES.length],
			sessionId: `add-session-${i % 3}`,
		})
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(`add[${i}]: ${r.status} ${JSON.stringify(r.data)}`)
			process.stdout.write("X")
		}
	}
	console.log()

	const structuredEntries = [
		{
			type: "fact",
			key: "company-name",
			value: "DataVault Inc.",
			salience: "high",
		},
		{
			type: "fact",
			key: "tech-stack",
			value: "TypeScript, PostgreSQL, Redis, Kubernetes",
			salience: "high",
		},
		{
			type: "preference",
			key: "editor",
			value: "VS Code with Vim keybindings",
			salience: "normal",
		},
		{
			type: "preference",
			key: "theme",
			value: "dark mode",
			salience: "normal",
		},
		{ type: "preference", key: "timezone", value: "UTC+2", salience: "low" },
		{
			type: "person",
			key: "team-alice",
			value: "Alice is backend lead, pair programs on Tuesdays",
			salience: "high",
		},
		{
			type: "person",
			key: "team-bob",
			value: "Bob is frontend dev, on parental leave until April",
			salience: "normal",
		},
		{
			type: "decision",
			key: "auth-strategy",
			value: "OAuth2+PKCE for web, API keys with rotation for CLI",
			salience: "critical",
		},
		{
			type: "decision",
			key: "db-migration",
			value: "Moving to multi-tenant with schema prefix and RLS",
			salience: "high",
		},
		{
			type: "project",
			key: "q3-target",
			value: "10 data connectors by Q3",
			salience: "high",
		},
		{
			type: "fact",
			key: "dietary",
			value: "Allergic to peanuts and shellfish, no red meat",
			salience: "critical",
		},
		{
			type: "todo",
			key: "deadline",
			value: "Project deadline March 30 2026, 3 milestones",
			salience: "critical",
		},
	]
	for (let i = 0; i < structuredEntries.length; i++) {
		const r = await api("POST", "/v1/write-structured", {
			entry: structuredEntries[i],
		})
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(
				`structured[${i}]: ${r.status} ${JSON.stringify(r.data)}`,
			)
			process.stdout.write("X")
		}
	}
	console.log()

	const procedures = [
		{
			procedureId: "proc-deploy-production",
			name: "deploy-production",
			steps: [
				"Run tests",
				"Build Docker image",
				"Push to ECR",
				"Update Helm values",
				"Canary 5%",
				"Full rollout",
			],
			state: "active",
		},
		{
			procedureId: "proc-incident-response",
			name: "incident-response",
			steps: [
				"Acknowledge alert",
				"Assess severity",
				"Notify stakeholders",
				"Mitigate",
				"Root cause analysis",
				"Postmortem",
			],
			state: "active",
		},
		{
			procedureId: "proc-onboard-connector",
			name: "onboard-connector",
			steps: [
				"Define schema interface",
				"Implement adapter",
				"Add integration tests",
				"Write docs",
				"Submit for review",
			],
			state: "active",
		},
		{
			procedureId: "proc-database-migration",
			name: "database-migration",
			steps: [
				"Create migration script",
				"Test on staging",
				"Backup production",
				"Apply migration",
				"Verify data",
				"Update application",
			],
			state: "active",
		},
		{
			procedureId: "proc-security-review",
			name: "security-review",
			steps: [
				"Dependency audit",
				"SAST scan",
				"DAST scan",
				"Manual review",
				"Fix findings",
				"Sign off",
			],
			state: "active",
		},
	]
	for (let i = 0; i < procedures.length; i++) {
		const r = await api("POST", "/v1/write-procedure", { entry: procedures[i] })
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(
				`procedure[${i}]: ${r.status} ${JSON.stringify(r.data)}`,
			)
			process.stdout.write("X")
		}
	}
	console.log()

	console.log("  Concurrency burst (20 simultaneous)...")
	const burst = await Promise.allSettled(
		Array.from({ length: 20 }, (_, i) =>
			i % 2 === 0
				? api("POST", "/v1/add", {
						content: `Concurrent write ${i}: ${CONVERSATION_BODIES[i % CONVERSATION_BODIES.length].slice(0, 100)}`,
					})
				: api("POST", "/v1/write-event", {
						role: "user",
						body: `Concurrent event ${i}: rapid-fire test`,
						sessionId: "burst-session",
					}),
		),
	)
	for (const b of burst) {
		if (b.status === "fulfilled") {
			latencies.push(b.value.ms)
			if (b.value.ok) result.passed++
			else {
				result.failed++
				result.errors.push(`burst: ${b.value.status}`)
			}
		} else {
			result.failed++
			result.errors.push(`burst-reject: ${b.reason}`)
		}
	}

	result.avgMs = Math.round(
		latencies.reduce((a, b) => a + b, 0) / latencies.length,
	)
	console.log(
		`  Phase 1 done: ${result.passed} passed, ${result.failed} failed, avg ${result.avgMs}ms`,
	)
	return result
}

// ─── PHASE 2: SEARCH STRESS ────────────────────────────────────────────────

async function phase2SearchStress(): Promise<PhaseResult> {
	const result: PhaseResult = {
		name: "Phase 2 (Search)",
		passed: 0,
		failed: 0,
		avgMs: 0,
		errors: [],
	}
	const latencies: number[] = []

	console.log("\n--- Phase 2: Search Stress ---")

	await new Promise((r) => setTimeout(r, 3000))
	console.log("  (waited 3s for indexing)")

	const searchQueries = [
		{ query: "authentication strategy OAuth API keys", label: "semantic-auth" },
		{ query: "database migration multi-tenant", label: "semantic-db" },
		{
			query: "performance bottleneck aggregation pipeline",
			label: "semantic-perf",
		},
		{ query: "Kubernetes deployment Helm charts", label: "semantic-k8s" },
		{
			query: "security audit findings rate limiting",
			label: "semantic-security",
		},
		{ query: "what is the project deadline", label: "semantic-deadline" },
		{ query: "team members and their roles", label: "semantic-team" },
		{ query: "coding conventions TypeScript", label: "semantic-conventions" },
		{ query: "webhook delivery at-least-once", label: "semantic-webhook" },
		{ query: "monitoring Prometheus Grafana", label: "semantic-monitoring" },
		{ query: "CSV parser bug mixed line endings", label: "keyword-bug" },
		{ query: "DataVault", label: "keyword-product" },
		{ query: "peanuts shellfish allergy", label: "personal-dietary" },
		{ query: "dark mode VS Code Vim", label: "personal-prefs" },
		{ query: "中国市场策略", label: "chinese-query" },
	]

	for (const sq of searchQueries) {
		const r = await api("POST", "/v1/search", {
			query: sq.query,
			maxResults: 5,
		})
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(`search[${sq.label}]: ${r.status}`)
			process.stdout.write("X")
		}
	}
	console.log()

	for (const q of [
		"data pipeline connector",
		"security best practices",
		"API design",
	]) {
		const r = await api("POST", "/v1/search-kb", { query: q })
		latencies.push(r.ms)
		if (r.ok) {
			result.passed++
			process.stdout.write(".")
		} else {
			result.failed++
			result.errors.push(`search-kb: ${r.status}`)
			process.stdout.write("X")
		}
	}
	console.log()

	const profileR = await api("POST", "/v1/profile", {
		maxEntities: 20,
		maxEpisodes: 5,
	})
	latencies.push(profileR.ms)
	if (profileR.ok) {
		result.passed++
		console.log("  Profile synthesis: OK")
	} else {
		result.failed++
		result.errors.push(
			`profile: ${profileR.status} ${JSON.stringify(profileR.data)}`,
		)
		console.log("  Profile synthesis: FAIL")
	}

	console.log("  Concurrent search burst (15 simultaneous)...")
	const searchBurst = await Promise.allSettled(
		searchQueries
			.slice(0, 15)
			.map((sq) =>
				api("POST", "/v1/search", { query: sq.query, maxResults: 3 }),
			),
	)
	for (const b of searchBurst) {
		if (b.status === "fulfilled") {
			latencies.push(b.value.ms)
			if (b.value.ok) result.passed++
			else {
				result.failed++
				result.errors.push(`search-burst: ${b.value.status}`)
			}
		} else {
			result.failed++
			result.errors.push(`search-burst-reject: ${b.reason}`)
		}
	}

	const edgeCases = [
		{ query: "", label: "empty" },
		{ query: "a".repeat(2500), label: "very-long" },
		{ query: "'; DROP TABLE chunks; --", label: "sql-injection" },
		{ query: '{"$gt":""}', label: "nosql-injection" },
		{ query: "🔥💻🚀 emoji query with unicode: Ωαβγ", label: "unicode" },
		{ query: "<script>alert('xss')</script>", label: "xss-attempt" },
	]
	for (const ec of edgeCases) {
		const r = await api("POST", "/v1/search", {
			query: ec.query,
			maxResults: 3,
		})
		latencies.push(r.ms)
		if (ec.label === "empty") {
			if (r.status === 400) {
				result.passed++
				process.stdout.write(".")
			} else {
				result.failed++
				result.errors.push(`edge[${ec.label}]: expected 400, got ${r.status}`)
				process.stdout.write("X")
			}
		} else {
			if (r.ok || r.status === 400) {
				result.passed++
				process.stdout.write(".")
			} else {
				result.failed++
				result.errors.push(`edge[${ec.label}]: ${r.status}`)
				process.stdout.write("X")
			}
		}
	}
	console.log()

	result.avgMs = Math.round(
		latencies.reduce((a, b) => a + b, 0) / latencies.length,
	)
	console.log(
		`  Phase 2 done: ${result.passed} passed, ${result.failed} failed, avg ${result.avgMs}ms`,
	)
	return result
}

// ─── PHASE 3: ADMIN/DIAGNOSTICS ────────────────────────────────────────────

async function phase3Admin(): Promise<PhaseResult> {
	const result: PhaseResult = {
		name: "Phase 3 (Admin)",
		passed: 0,
		failed: 0,
		avgMs: 0,
		errors: [],
	}
	const latencies: number[] = []

	console.log("\n--- Phase 3: Admin/Diagnostics ---")

	const endpoints: Array<[string, string]> = [
		["GET", "/v1/status"],
		["GET", "/v1/status/detailed"],
		["GET", "/v1/stats"],
		["GET", "/v1/probes/embedding"],
		["GET", "/v1/probes/vector"],
		["GET", "/v1/admin/relevance/sample-rate"],
	]
	for (const [method, path] of endpoints) {
		const r = await api(method, path)
		latencies.push(r.ms)
		const label = path.split("/").pop()
		if (r.ok) {
			result.passed++
			console.log(`  ${label}: OK (${Math.round(r.ms)}ms)`)
		} else {
			result.failed++
			result.errors.push(`${label}: ${r.status} ${JSON.stringify(r.data)}`)
			console.log(`  ${label}: FAIL ${r.status}`)
		}
	}

	const syncR = await api("POST", "/v1/sync", { force: true })
	latencies.push(syncR.ms)
	if (syncR.ok) {
		result.passed++
		console.log(`  sync: OK (${Math.round(syncR.ms)}ms)`)
	} else {
		result.failed++
		result.errors.push(`sync: ${syncR.status}`)
		console.log(`  sync: FAIL ${syncR.status}`)
	}

	const explainR = await api("POST", "/v1/admin/relevance/explain", {
		query: "database migration strategy",
	})
	latencies.push(explainR.ms)
	if (explainR.ok) {
		result.passed++
		console.log(`  relevance-explain: OK (${Math.round(explainR.ms)}ms)`)
	} else {
		result.failed++
		result.errors.push(
			`relevance-explain: ${explainR.status} ${JSON.stringify(explainR.data)}`,
		)
		console.log(`  relevance-explain: FAIL ${explainR.status}`)
	}

	result.avgMs = Math.round(
		latencies.reduce((a, b) => a + b, 0) / latencies.length,
	)
	console.log(
		`  Phase 3 done: ${result.passed} passed, ${result.failed} failed, avg ${result.avgMs}ms`,
	)
	return result
}

// ─── PHASE 4: ENDURANCE / CONCURRENCY ──────────────────────────────────────

async function phase4Endurance(): Promise<
	PhaseResult & { latencies: number[] }
> {
	const result: PhaseResult & { latencies: number[] } = {
		name: "Phase 4 (Endurance)",
		passed: 0,
		failed: 0,
		avgMs: 0,
		errors: [],
		latencies: [],
	}

	console.log("\n--- Phase 4: Endurance (30s sustained load) ---")

	const endTime = Date.now() + 30_000
	let reqCount = 0
	const agents = [
		"agent-alpha",
		"agent-beta",
		"agent-gamma",
		"agent-delta",
		"agent-epsilon",
	]

	while (Date.now() < endTime) {
		const batch = Array.from({ length: 8 }, (_, i) => {
			const agentId = agents[i % agents.length]
			if (i % 3 === 0) {
				return api("POST", "/v1/search", {
					query: CONVERSATION_BODIES[
						reqCount % CONVERSATION_BODIES.length
					].slice(0, 80),
					agentId,
					maxResults: 3,
				})
			}
			if (i % 3 === 1) {
				return api("POST", "/v1/add", {
					content: `Endurance write ${reqCount}: ${Date.now()}`,
					agentId,
				})
			}
			return api("POST", "/v1/write-event", {
				role: "user",
				body: `Endurance event ${reqCount}`,
				agentId,
				sessionId: `endurance-${agentId}`,
			})
		})

		const results = await Promise.allSettled(batch)
		for (const r of results) {
			reqCount++
			if (r.status === "fulfilled") {
				result.latencies.push(r.value.ms)
				if (r.value.ok) result.passed++
				else result.failed++
			} else {
				result.failed++
			}
		}
		if (reqCount % 40 === 0) process.stdout.write(`[${reqCount}]`)
	}
	console.log()

	console.log("  Connection pool stress (50 simultaneous)...")
	const poolBurst = await Promise.allSettled(
		Array.from({ length: 50 }, (_, i) => {
			const endpoints = ["/v1/status", "/v1/stats", "/v1/search", "/v1/add"]
			const ep = endpoints[i % endpoints.length]
			if (ep === "/v1/search")
				return api("POST", ep, { query: `pool-test-${i}`, maxResults: 2 })
			if (ep === "/v1/add")
				return api("POST", ep, { content: `pool-burst-${i}` })
			return api("GET", ep)
		}),
	)
	for (const b of poolBurst) {
		if (b.status === "fulfilled") {
			result.latencies.push(b.value.ms)
			if (b.value.ok) result.passed++
			else result.failed++
		} else {
			result.failed++
		}
	}

	console.log("  Large payload test (50KB)...")
	const largeContent = "This is a test of large document ingestion. ".repeat(
		1200,
	)
	const largeR = await api("POST", "/v1/add", { content: largeContent })
	result.latencies.push(largeR.ms)
	if (largeR.ok) {
		result.passed++
		console.log(
			`  Large payload: OK (${Math.round(largeR.ms)}ms, ${Math.round(largeContent.length / 1024)}KB)`,
		)
	} else {
		result.failed++
		result.errors.push(`large-payload: ${largeR.status}`)
		console.log(`  Large payload: FAIL`)
	}

	result.avgMs = Math.round(
		result.latencies.reduce((a, b) => a + b, 0) /
			(result.latencies.length || 1),
	)
	console.log(
		`  Phase 4 done: ${result.passed} passed, ${result.failed} failed, avg ${result.avgMs}ms, total requests: ${result.passed + result.failed}`,
	)
	return result
}

// ─── MAIN ──────────────────────────────────────────────────────────────────

async function main() {
	console.log("╔══════════════════════════════════════════════╗")
	console.log("║     MEMONGO REAL RUNTIME STRESS TEST         ║")
	console.log("╠══════════════════════════════════════════════╣")
	console.log(`║ Target: ${BASE}`)
	console.log(`║ Time:   ${new Date().toISOString()}`)
	console.log("╚══════════════════════════════════════════════╝")

	const healthR = await api("GET", "/health")
	if (!healthR.ok) {
		console.error("FATAL: API server not reachable at", BASE)
		process.exit(1)
	}
	console.log("Health check: OK")

	const p1 = await phase1WriteStress()
	const p2 = await phase2SearchStress()
	const p3 = await phase3Admin()
	const p4 = await phase4Endurance()

	const allLatencies = p4.latencies

	console.log("\n╔══════════════════════════════════════════════════════════╗")
	console.log("║          MEMONGO STRESS TEST REPORT                     ║")
	console.log("╠══════════════════════════════════════════════════════════╣")
	console.log(
		`║ ${p1.name.padEnd(22)} ${String(p1.passed).padStart(3)}/${String(p1.passed + p1.failed).padStart(3)} passed  avg ${String(p1.avgMs).padStart(5)}ms`,
	)
	console.log(
		`║ ${p2.name.padEnd(22)} ${String(p2.passed).padStart(3)}/${String(p2.passed + p2.failed).padStart(3)} passed  avg ${String(p2.avgMs).padStart(5)}ms`,
	)
	console.log(
		`║ ${p3.name.padEnd(22)} ${String(p3.passed).padStart(3)}/${String(p3.passed + p3.failed).padStart(3)} passed  avg ${String(p3.avgMs).padStart(5)}ms`,
	)
	console.log(
		`║ ${p4.name.padEnd(22)} ${String(p4.passed).padStart(3)}/${String(p4.passed + p4.failed).padStart(3)} passed  avg ${String(p4.avgMs).padStart(5)}ms`,
	)
	if (allLatencies.length > 0) {
		console.log(
			`║ Endurance latency:     p50=${Math.round(percentile(allLatencies, 50))}ms  p95=${Math.round(percentile(allLatencies, 95))}ms  p99=${Math.round(percentile(allLatencies, 99))}ms`,
		)
	}
	console.log("╠══════════════════════════════════════════════════════════╣")

	const totalPassed = p1.passed + p2.passed + p3.passed + p4.passed
	const totalFailed = p1.failed + p2.failed + p3.failed + p4.failed
	console.log(
		`║ TOTAL: ${totalPassed}/${totalPassed + totalFailed} passed (${totalFailed} failures)`,
	)

	const allErrors = [...p1.errors, ...p2.errors, ...p3.errors, ...p4.errors]
	if (allErrors.length > 0) {
		console.log("╠══════════════════════════════════════════════════════════╣")
		console.log("║ ERRORS (first 15):")
		for (const e of allErrors.slice(0, 15)) {
			console.log(`║   ${e.slice(0, 70)}`)
		}
	}
	console.log("╚══════════════════════════════════════════════════════════╝")

	if (totalFailed === 0) console.log("\n  ALL TESTS PASSED")
	else console.log(`\n  ${totalFailed} FAILURES detected`)
}

main().catch((err) => {
	console.error("Stress test crashed:", err)
	process.exit(1)
})

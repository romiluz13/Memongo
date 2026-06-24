"use client"

import { MemongoClient } from "@memongo/client"
import type { ReactNode } from "react"
import { useMemo, useState } from "react"

const defaultApi =
	process.env.NEXT_PUBLIC_MEMONGO_API_URL ?? "http://127.0.0.1:3847"

type Tab = "overview" | "search" | "kb" | "profile" | "write"

type OutputState = {
	title: string
	body: string
	state: "idle" | "success" | "error"
}

type OverviewState = {
	health?: { ok?: boolean; service?: string }
	status?: Record<string, unknown>
	stats?: Record<string, unknown>
	openApiPathCount?: number
	lastRefreshAt?: string
}

type Style = Record<string, string | number>

const palette = {
	page: "#f6f8fb",
	ink: "#172033",
	muted: "#667085",
	border: "#d6dde8",
	panel: "#ffffff",
	panelAlt: "#eef3f8",
	accent: "#0f766e",
	accentDark: "#115e59",
	code: "#0b1220",
	success: "#047857",
	error: "#b42318",
	warning: "#b54708",
}

const fieldStyle: Style = {
	width: "100%",
	boxSizing: "border-box",
	border: `1px solid ${palette.border}`,
	borderRadius: 6,
	padding: "9px 10px",
	font: "inherit",
	color: palette.ink,
	background: "#fff",
}

function pretty(value: unknown): string {
	return JSON.stringify(value, null, 2)
}

function statusLabel(ok?: boolean): string {
	if (ok === true) {
		return "Healthy"
	}
	if (ok === false) {
		return "Unhealthy"
	}
	return "Not checked"
}

function buttonStyle(kind: "primary" | "secondary" = "secondary"): Style {
	return {
		border:
			kind === "primary"
				? `1px solid ${palette.accent}`
				: `1px solid ${palette.border}`,
		background: kind === "primary" ? palette.accent : "#fff",
		color: kind === "primary" ? "#fff" : palette.ink,
		borderRadius: 6,
		padding: "9px 12px",
		cursor: "pointer",
		fontWeight: 650,
	}
}

function tabButtonStyle(active: boolean): Style {
	return {
		border: active ? `1px solid ${palette.accent}` : "1px solid transparent",
		background: active ? "#d9f4ef" : "transparent",
		color: active ? palette.accentDark : palette.muted,
		padding: "8px 10px",
		borderRadius: 6,
		cursor: "pointer",
		fontWeight: 650,
	}
}

function MetricCard({
	label,
	value,
	help,
	tone = "neutral",
}: {
	label: string
	value: string
	help: string
	tone?: "neutral" | "success" | "warning"
}) {
	const valueColor =
		tone === "success"
			? palette.success
			: tone === "warning"
				? palette.warning
				: palette.ink

	return (
		<div
			style={{
				border: `1px solid ${palette.border}`,
				borderRadius: 8,
				padding: 14,
				background: palette.panel,
				minHeight: 108,
			}}
		>
			<div
				style={{
					fontSize: 12,
					color: palette.muted,
					marginBottom: 8,
					textTransform: "uppercase",
					fontWeight: 700,
				}}
			>
				{label}
			</div>
			<div
				style={{
					fontSize: 22,
					fontWeight: 760,
					marginBottom: 6,
					color: valueColor,
				}}
			>
				{value}
			</div>
			<div style={{ fontSize: 13, color: palette.muted, lineHeight: 1.35 }}>
				{help}
			</div>
		</div>
	)
}

function Field({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div style={{ display: "grid", gap: 6 }}>
			<span style={{ color: palette.muted, fontSize: 13, fontWeight: 650 }}>
				{label}
			</span>
			{children}
		</div>
	)
}

export default function Home() {
	const [baseUrl, setBaseUrl] = useState(defaultApi)
	const [apiKey, setApiKey] = useState("")
	const [agentId, setAgentId] = useState("main")
	const [scopeValue, setScopeValue] = useState("default")
	const [tab, setTab] = useState<Tab>("overview")
	const [query, setQuery] = useState("What does this user prefer?")
	const [writeContent, setWriteContent] = useState(
		"The user prefers concise release notes and Friday deploy windows.",
	)
	const [loading, setLoading] = useState(false)
	const [output, setOutput] = useState<OutputState>({
		title: "Console output",
		body: "Run an action to inspect live Memongo responses.",
		state: "idle",
	})
	const [overview, setOverview] = useState<OverviewState>({})

	const root = useMemo(() => baseUrl.replace(/\/$/, ""), [baseUrl])
	const client = useMemo(
		() =>
			new MemongoClient({
				baseUrl: root,
				apiKey: apiKey.trim() || undefined,
			}),
		[apiKey, root],
	)

	function authHeaders(): Record<string, string> {
		const headers: Record<string, string> = {}
		if (apiKey.trim()) {
			headers.Authorization = `Bearer ${apiKey.trim()}`
		}
		return headers
	}

	async function fetchJson(path: string): Promise<unknown> {
		const response = await fetch(`${root}${path}`, { headers: authHeaders() })
		const text = await response.text()
		if (!response.ok) {
			throw new Error(`${path} returned HTTP ${response.status}\n${text}`)
		}
		return text ? JSON.parse(text) : null
	}

	async function withOutput(title: string, action: () => Promise<unknown>) {
		setLoading(true)
		try {
			const result = await action()
			setOutput({ title, body: pretty(result), state: "success" })
		} catch (error) {
			setOutput({
				title: `${title} failed`,
				body: error instanceof Error ? error.message : String(error),
				state: "error",
			})
		} finally {
			setLoading(false)
		}
	}

	async function refreshOverview() {
		await withOutput("Overview refresh", async () => {
			const [health, status, stats, openApi] = await Promise.all([
				fetchJson("/health"),
				client.status(agentId),
				client.stats(agentId),
				fetchJson("/openapi.json"),
			])
			const nextOverview: OverviewState = {
				health: health as OverviewState["health"],
				status: status as Record<string, unknown>,
				stats: stats as Record<string, unknown>,
				openApiPathCount: Object.keys(
					((openApi as { paths?: Record<string, unknown> }).paths ??
						{}) as Record<string, unknown>,
				).length,
				lastRefreshAt: new Date().toISOString(),
			}
			setOverview(nextOverview)
			return nextOverview
		})
	}

	async function runCurrentTab() {
		if (tab === "overview") {
			await refreshOverview()
			return
		}
		if (tab === "search") {
			await withOutput("Search results", async () => {
				return await client.search({
					agentId,
					query,
					limit: 8,
					sessionKey: scopeValue,
				})
			})
			return
		}
		if (tab === "kb") {
			await withOutput("Knowledge base results", async () => {
				return await client.searchKB({
					agentId,
					query,
					limit: 8,
				})
			})
			return
		}
		if (tab === "profile") {
			await withOutput("Profile synthesis", async () => {
				return await client.profile({
					agentId,
					maxEntities: 10,
					maxEpisodes: 10,
					scopeRef: scopeValue,
				})
			})
			return
		}
		await withOutput("Memory write", async () => {
			return await client.add({
				agentId,
				content: writeContent,
				sessionId: scopeValue,
			})
		})
	}

	const backend = String(
		(overview.status?.backend as string | undefined) ?? "unknown",
	)
	const sources = (
		(overview.status?.sources as string[] | undefined) ?? []
	).join(", ")
	const outputBorder =
		output.state === "error"
			? palette.error
			: output.state === "success"
				? palette.success
				: palette.border

	return (
		<div style={{ background: palette.page, minHeight: "100vh" }}>
			<main
				style={{
					maxWidth: 1200,
					margin: "0 auto",
					padding: "24px 18px 36px",
					color: palette.ink,
				}}
			>
				<header
					style={{
						display: "flex",
						justifyContent: "space-between",
						gap: 16,
						alignItems: "flex-end",
						marginBottom: 22,
						flexWrap: "wrap",
					}}
				>
					<div>
						<div
							style={{
								color: palette.accentDark,
								fontSize: 13,
								fontWeight: 760,
								marginBottom: 6,
							}}
						>
							MongoDB-native memory
						</div>
						<h1 style={{ margin: 0, fontSize: 34, letterSpacing: 0 }}>
							Memongo Console
						</h1>
						<p
							style={{
								color: palette.muted,
								marginTop: 8,
								marginBottom: 0,
								maxWidth: 720,
								lineHeight: 1.5,
							}}
						>
							Operate the supported Memongo API surface: inspect health, search
							memory, query the knowledge base, synthesize profiles, and write a
							test event.
						</p>
					</div>
					<div
						style={{
							border: `1px solid ${palette.border}`,
							borderRadius: 8,
							padding: "10px 12px",
							background: palette.panel,
							minWidth: 240,
						}}
					>
						<div style={{ fontSize: 12, color: palette.muted }}>
							Connected to
						</div>
						<div
							style={{
								fontSize: 14,
								fontWeight: 700,
								overflowWrap: "anywhere",
								marginTop: 3,
							}}
						>
							{root}
						</div>
					</div>
				</header>

				<section
					style={{
						display: "grid",
						gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
						gap: 12,
						marginBottom: 18,
					}}
				>
					<MetricCard
						label="API health"
						value={statusLabel(overview.health?.ok)}
						tone={overview.health?.ok ? "success" : "warning"}
						help={
							overview.health?.service ?? "Refresh overview to probe the API"
						}
					/>
					<MetricCard
						label="OpenAPI paths"
						value={String(overview.openApiPathCount ?? 0)}
						help="Standalone HTTP contract"
					/>
					<MetricCard
						label="Memory backend"
						value={backend}
						help={`Sources: ${sources || "unknown"}`}
					/>
					<MetricCard
						label="Chunk count"
						value={String(
							(overview.stats?.totalChunks as number | undefined) ?? 0,
						)}
						help={`Files: ${String((overview.stats?.totalFiles as number | undefined) ?? 0)}`}
					/>
				</section>

				<section
					style={{
						display: "grid",
						gridTemplateColumns: "minmax(300px, 390px) minmax(0, 1fr)",
						gap: 18,
						alignItems: "start",
					}}
				>
					<div
						style={{
							border: `1px solid ${palette.border}`,
							borderRadius: 8,
							padding: 18,
							background: palette.panel,
						}}
					>
						<h2 style={{ marginTop: 0, marginBottom: 14, fontSize: 18 }}>
							Connection
						</h2>
						<div style={{ display: "grid", gap: 12 }}>
							<Field label="API base URL">
								<input
									value={baseUrl}
									onChange={(e) => setBaseUrl(e.target.value)}
									style={fieldStyle}
								/>
							</Field>
							<Field label="API key">
								<input
									type="password"
									value={apiKey}
									onChange={(e) => setApiKey(e.target.value)}
									placeholder="Optional bearer token"
									style={fieldStyle}
								/>
							</Field>
							<Field label="Agent ID">
								<input
									value={agentId}
									onChange={(e) => setAgentId(e.target.value)}
									style={fieldStyle}
								/>
							</Field>
							<Field label="Session / scope value">
								<input
									value={scopeValue}
									onChange={(e) => setScopeValue(e.target.value)}
									style={fieldStyle}
								/>
							</Field>
						</div>

						<h2 style={{ marginBottom: 10, marginTop: 22, fontSize: 18 }}>
							Actions
						</h2>
						<div
							style={{
								display: "flex",
								gap: 6,
								flexWrap: "wrap",
								background: palette.panelAlt,
								padding: 4,
								borderRadius: 8,
								marginBottom: 14,
							}}
						>
							{(
								[
									["overview", "Overview"],
									["search", "Search"],
									["kb", "KB"],
									["profile", "Profile"],
									["write", "Write"],
								] as const
							).map(([key, label]) => (
								<button
									key={key}
									type="button"
									onClick={() => setTab(key)}
									style={tabButtonStyle(tab === key)}
								>
									{label}
								</button>
							))}
						</div>

						{(tab === "search" || tab === "kb") && (
							<Field label="Query">
								<input
									value={query}
									onChange={(e) => setQuery(e.target.value)}
									style={{ ...fieldStyle, marginBottom: 14 }}
								/>
							</Field>
						)}

						{tab === "write" && (
							<Field label="Memory content">
								<textarea
									value={writeContent}
									onChange={(e) => setWriteContent(e.target.value)}
									rows={5}
									style={{
										...fieldStyle,
										resize: "vertical",
										marginBottom: 14,
										lineHeight: 1.45,
									}}
								/>
							</Field>
						)}

						<div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
							<button
								type="button"
								onClick={() => void runCurrentTab()}
								disabled={loading}
								style={{
									...buttonStyle("primary"),
									opacity: loading ? 0.65 : 1,
								}}
							>
								{loading ? "Running..." : `Run ${tab}`}
							</button>
							<button
								type="button"
								onClick={() =>
									void withOutput("OpenAPI document", () =>
										fetchJson("/openapi.json"),
									)
								}
								disabled={loading}
								style={{
									...buttonStyle(),
									opacity: loading ? 0.65 : 1,
								}}
							>
								Show OpenAPI
							</button>
						</div>

						<p
							style={{
								color: palette.muted,
								fontSize: 12,
								marginTop: 15,
								marginBottom: 0,
							}}
						>
							Last overview refresh: {overview.lastRefreshAt ?? "not yet run"}
						</p>
					</div>

					<div
						style={{
							border: `1px solid ${outputBorder}`,
							borderRadius: 8,
							padding: 18,
							background: palette.panel,
							minHeight: 520,
						}}
					>
						<div
							style={{
								display: "flex",
								alignItems: "center",
								justifyContent: "space-between",
								gap: 10,
								marginBottom: 12,
							}}
						>
							<h2 style={{ margin: 0, fontSize: 18 }}>{output.title}</h2>
							<span
								style={{
									color:
										output.state === "error"
											? palette.error
											: output.state === "success"
												? palette.success
												: palette.muted,
									fontSize: 12,
									fontWeight: 760,
									textTransform: "uppercase",
								}}
							>
								{output.state}
							</span>
						</div>
						<pre
							style={{
								background: palette.code,
								border: "1px solid #1f2937",
								borderRadius: 8,
								color: "#dbeafe",
								padding: 16,
								overflow: "auto",
								whiteSpace: "pre-wrap",
								fontSize: 13,
								lineHeight: 1.5,
								minHeight: 438,
								margin: 0,
							}}
						>
							{output.body}
						</pre>
					</div>
				</section>
			</main>
		</div>
	)
}

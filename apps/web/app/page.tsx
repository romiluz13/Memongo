"use client"

import { useEffect, useRef } from "react"

const memoryLayers = [
	{
		label: "Events",
		title: "Every interaction stays source-backed.",
		body: "Conversations, tool calls, documents, and agent actions land as durable memory events with timestamps, scope, provenance, and metadata.",
	},
	{
		label: "Structure",
		title: "Facts become current state, not loose notes.",
		body: "Preferences, procedures, profile details, revisions, and superseded values are modeled so an agent can know what changed and what still holds.",
	},
	{
		label: "Retrieval",
		title: "Semantic, lexical, graph, and hybrid recall work together.",
		body: "Vector similarity finds meaning, full-text search catches names and exact facts, graph links recover relationships, and hybrid ranking chooses the right evidence.",
	},
	{
		label: "Proof",
		title: "The answer can point back to the memory.",
		body: "Context bundles preserve source IDs, scores, roles, timestamps, and stale/current labels so memory can be inspected instead of trusted blindly.",
	},
]

const capabilities = [
	[
		"Document memory",
		"Events, facts, KB chunks, procedures, graph edges, and telemetry live together.",
	],
	[
		"Vector recall",
		"High-recall semantic search for fuzzy questions and long-running context.",
	],
	[
		"Lexical recall",
		"Exact names, dates, identifiers, and proper nouns stay recoverable.",
	],
	[
		"Hybrid ranking",
		"Semantic and keyword evidence can be fused without leaving the memory store.",
	],
	[
		"Graph context",
		"Episodes, entities, sessions, and scopes become traversable relationships.",
	],
	[
		"Operational truth",
		"Health, indexes, provenance, cleanup, and release gates are first-class.",
	],
]

const codeSample = `const memongo = new MemongoClient({
  baseUrl: "http://127.0.0.1:3847"
})

await memongo.add({
  sessionId: "agent-42",
  content: "Romi prefers concise release notes."
})

const context = await memongo.search({
  sessionKey: "agent-42",
  query: "How should I write the launch note?",
  limit: 8
})`

export default function LandingPage() {
	const rootRef = useRef<HTMLElement>(null)

	useEffect(() => {
		const root = rootRef.current
		if (!root) {
			return
		}

		const reduceMotion = window.matchMedia(
			"(prefers-reduced-motion: reduce)",
		).matches

		if (reduceMotion) {
			root.dataset.motion = "reduced"
			return
		}

		let cleanup = () => {}

		void (async () => {
			const [{ gsap }, { ScrollTrigger }] = await Promise.all([
				import("gsap"),
				import("gsap/ScrollTrigger"),
			])

			gsap.registerPlugin(ScrollTrigger)

			const context = gsap.context(() => {
				gsap
					.timeline({ defaults: { ease: "power4.out" } })
					.from(".hero-kicker", { opacity: 0, y: 18, duration: 0.7 })
					.from(
						".hero-title span",
						{
							opacity: 0,
							yPercent: 70,
							rotateX: -35,
							stagger: 0.08,
							duration: 0.9,
						},
						"-=0.4",
					)
					.from(
						".hero-copy, .hero-actions",
						{
							opacity: 0,
							y: 22,
							duration: 0.8,
							stagger: 0.12,
						},
						"-=0.45",
					)
					.from(
						".memory-constellation",
						{
							opacity: 0,
							scale: 0.96,
							duration: 1,
						},
						"-=0.8",
					)

				gsap.to(".memory-orbit", {
					rotate: 360,
					duration: 48,
					repeat: -1,
					ease: "none",
					transformOrigin: "50% 50%",
				})

				gsap.to(".memory-core", {
					scale: 1.08,
					duration: 2.8,
					yoyo: true,
					repeat: -1,
					ease: "sine.inOut",
				})

				gsap.utils.toArray<HTMLElement>(".reveal").forEach((element) => {
					gsap.from(element, {
						opacity: 0,
						y: 44,
						duration: 0.9,
						ease: "power4.out",
						scrollTrigger: {
							trigger: element,
							start: "top 82%",
						},
					})
				})

				gsap.to(".system-line", {
					scaleY: 1,
					ease: "none",
					scrollTrigger: {
						trigger: ".system-story",
						start: "top 74%",
						end: "bottom 68%",
						scrub: true,
					},
				})
			}, root)

			cleanup = () => context.revert()
		})()

		return () => cleanup()
	}, [])

	return (
		<main ref={rootRef} className="landing-shell">
			<section className="landing-hero">
				<nav className="landing-nav" aria-label="Primary navigation">
					<a className="brand-mark" href="/" aria-label="Memongo home">
						<span className="brand-mark__glyph">M</span>
						<span>Memongo</span>
					</a>
					<div className="nav-links">
						<a href="#architecture">Architecture</a>
						<a href="#memory-model">Memory model</a>
						<a href="/console">Console</a>
						<a href="https://github.com/romiluz13/memongo">GitHub</a>
					</div>
				</nav>

				<div className="hero-grid">
					<div className="hero-copy-block">
						<p className="hero-kicker">MongoDB-native agent memory</p>
						<h1 className="hero-title">
							<span>Memory,</span>
							<span>minus the</span>
							<span>
								<code className="hero-title-code">.md</code> tax.
							</span>
						</h1>
						<p className="hero-copy">
							A <code>.md</code> file is fine for the first run. It fails when
							every turn makes the agent reread the whole past. Memongo stores
							memory in MongoDB, then retrieves only the slice that matters:
							source, search, graph, and proof.
						</p>
						<div className="hero-actions">
							<a className="button button-primary" href="#quickstart">
								Start in five minutes
							</a>
							<a className="button button-secondary" href="/console">
								Open console
							</a>
						</div>
					</div>

					<div
						className="memory-constellation"
						role="img"
						aria-label="Animated memory system diagram"
					>
						<div className="memory-ring memory-ring--outer" />
						<div className="memory-ring memory-ring--inner" />
						<div className="memory-orbit">
							<span className="memory-node memory-node--event">events</span>
							<span className="memory-node memory-node--vector">vector</span>
							<span className="memory-node memory-node--graph">graph</span>
							<span className="memory-node memory-node--text">text</span>
						</div>
						<div className="memory-core">
							<span className="memory-core__label">one memory store</span>
							<strong>source, search, graph, proof</strong>
						</div>
					</div>
				</div>
			</section>

			<section className="signal-strip" aria-label="Memongo capabilities">
				<div>
					<span>Stores</span>
					<strong>events, facts, procedures, docs</strong>
				</div>
				<div>
					<span>Retrieves</span>
					<strong>vector, lexical, hybrid, graph</strong>
				</div>
				<div>
					<span>Explains</span>
					<strong>sources, scores, roles, timestamps</strong>
				</div>
			</section>

			<section id="architecture" className="section-grid system-story">
				<div className="section-heading reveal">
					<p className="eyebrow">The hidden hard part</p>
					<h2>Memory is not a vector table.</h2>
					<p>
						A useful agent needs more than nearest neighbors. It needs the
						actual event, the current fact, the old fact it replaced, the exact
						name a user typed, the relationship between sessions, and the proof
						that a context bundle was assembled honestly.
					</p>
				</div>
				<div className="system-steps">
					<div className="system-line" />
					{memoryLayers.map((layer) => (
						<article className="system-step reveal" key={layer.label}>
							<span>{layer.label}</span>
							<h3>{layer.title}</h3>
							<p>{layer.body}</p>
						</article>
					))}
				</div>
			</section>

			<section id="memory-model" className="capability-section reveal">
				<div className="capability-intro">
					<p className="eyebrow">The shape of the system</p>
					<h2>One memory substrate, many recall modes.</h2>
					<p>
						Memongo is built around a simple belief: agent memory should live
						where documents, indexes, relationships, operational queries, and
						provenance can be reasoned about together.
					</p>
				</div>
				<div className="capability-grid">
					{capabilities.map(([title, body]) => (
						<article className="capability-tile" key={title}>
							<h3>{title}</h3>
							<p>{body}</p>
						</article>
					))}
				</div>
			</section>

			<section className="proof-section reveal">
				<div>
					<p className="eyebrow">Not benchmark theater</p>
					<h2>Built for audit before bragging.</h2>
					<p>
						Memongo keeps benchmark claims scoped. Retrieval evidence and judged
						answer quality are separated. Source IDs, commands, metadata,
						topology, cleanup proof, and model posture matter more than a
						headline.
					</p>
				</div>
				<div className="proof-card">
					<span className="proof-card__status">Public posture</span>
					<strong>
						Selected retrieval evidence is published. Broad ecosystem leadership
						is not claimed.
					</strong>
					<p>
						The product is open source now. The benchmark work remains honest,
						reproducible, and deliberately scoped.
					</p>
				</div>
			</section>

			<section id="quickstart" className="quickstart-section reveal">
				<div>
					<p className="eyebrow">Use it like infrastructure</p>
					<h2>Add memory, search memory, inspect the answer.</h2>
					<p>
						Run the API, connect the SDK, then let your agent retrieve context
						from the same place that stores the source evidence.
					</p>
					<div className="hero-actions">
						<a
							className="button button-primary"
							href="https://github.com/romiluz13/memongo#quickstart"
						>
							Read the quickstart
						</a>
						<a className="button button-secondary" href="/console">
							Try the console
						</a>
					</div>
				</div>
				<pre className="code-window">
					<code>{codeSample}</code>
				</pre>
			</section>
		</main>
	)
}

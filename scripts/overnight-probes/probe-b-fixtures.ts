export const B_MAX_CALLS = 60
export const B_MAX_ATTEMPTS_PER_CASE = 2
export const B_MAX_EXTRA_POLLS = 30

const CONTROL_ENTITIES = [
	"Brindlewick",
	"Corvane",
	"Dunmarrow",
	"Eskerfell",
	"Falconreach",
	"Gildermoor",
	"Harrowgate",
	"Ilmenhurst",
	"Jorvikshire",
	"Kestrelmoor",
	"Lowenthal",
	"Marrowdene",
	"Nethersby",
	"Oakhollow",
	"Pennyroyal",
	"Quillhaven",
	"Ravenscroft",
	"Stonebarrow",
	"Thistledown",
	"Underhaugh",
] as const

const UNKNOWN_ENTITIES = [
	"Vexmoor",
	"Wyndcastle",
	"Xandermere",
	"Yarrowfield",
	"Zephyrholt",
	"Amberlock",
	"Bramblecote",
	"Cinderfell",
	"Duskwater",
	"Emberstone",
] as const

const ABSENT_ATTRIBUTE = "delivery address"

export type BSeed = { id: string; kind: "control" | "distractor"; text: string }

export type BControl = {
	caseId: string
	entity: string
	question: string
	marker: string
}

export type BNever = {
	caseId: string
	kind: "unknown-entity" | "unknown-attribute"
	question: string
	absent: string[]
	pairedControl: string
}

export type BFixture = {
	seeds: BSeed[]
	controls: BControl[]
	never: BNever[]
}

function index(position: number): string {
	return String(position + 1).padStart(2, "0")
}

export function buildBFixture(
	markerFor: (position: number) => string,
): BFixture {
	const controls = CONTROL_ENTITIES.map(
		(entity, position): BControl => ({
			caseId: `B/control/${index(position)}`,
			entity,
			question: `What is the access code for the ${entity} vault?`,
			marker: markerFor(position),
		}),
	)
	const seeds: BSeed[] = controls.map((control) => ({
		id: control.caseId,
		kind: "control",
		text: `The access code for the ${control.entity} vault is ${control.marker}.`,
	}))
	for (const [position, entity] of CONTROL_ENTITIES.entries()) {
		if (position < 10) continue
		seeds.push({
			id: `B/distractor/${index(position)}`,
			kind: "distractor",
			text: `The ${entity} vault is located on level ${position - 8}.`,
		})
	}
	const unknown = UNKNOWN_ENTITIES.map(
		(entity, position): BNever => ({
			caseId: `B/never/${index(position)}`,
			kind: "unknown-entity",
			question: `What is the access code for the ${entity} vault?`,
			absent: [entity],
			pairedControl: controls[position]?.caseId ?? "",
		}),
	)
	const attribute = CONTROL_ENTITIES.slice(0, 10).map(
		(entity, position): BNever => ({
			caseId: `B/never/${index(position + 10)}`,
			kind: "unknown-attribute",
			question: `What is the ${ABSENT_ATTRIBUTE} for the ${entity} vault?`,
			absent: [ABSENT_ATTRIBUTE],
			pairedControl: controls[position]?.caseId ?? "",
		}),
	)
	return { seeds, controls, never: [...unknown, ...attribute] }
}

export function fixtureViolations(fixture: BFixture): string[] {
	const violations: string[] = []
	const corpus = fixture.seeds.map((seed) => seed.text.toLowerCase())
	const controlIds = new Set(fixture.controls.map((control) => control.caseId))
	for (const item of fixture.never) {
		for (const token of item.absent) {
			if (corpus.some((text) => text.includes(token.toLowerCase()))) {
				violations.push(
					`${item.caseId}: "${token}" is present in the seeded data`,
				)
			}
		}
		if (!controlIds.has(item.pairedControl)) {
			violations.push(
				`${item.caseId}: paired control ${item.pairedControl} does not exist`,
			)
		}
		for (const control of fixture.controls) {
			if (item.question.includes(control.marker)) {
				violations.push(`${item.caseId}: question contains a control marker`)
			}
		}
	}
	const markers = fixture.controls.map((control) => control.marker)
	if (new Set(markers).size !== markers.length) {
		violations.push("control markers are not unique")
	}
	for (const control of fixture.controls) {
		if (
			fixture.controls.some(
				(other) => other !== control && other.marker.includes(control.marker),
			)
		) {
			violations.push(
				`${control.caseId}: marker is contained in another marker`,
			)
		}
	}
	return violations
}

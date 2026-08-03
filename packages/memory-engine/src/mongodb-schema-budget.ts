// Search index budget per deployment profile (P4.3 split from mongodb-schema.ts).
import type { MemoryMongoDBDeploymentProfile } from "@memongo/lib"
import type { MongoIndexBudgetCheck } from "./mongodb-schema-types.js"

// ---------------------------------------------------------------------------
// Index budget
// ---------------------------------------------------------------------------

// P3.8: budget enforcement was dead code while every profile was "unbounded".
// community-mongot (self-hosted mongot, finite heap per indexed collection)
// gets a real numeric ceiling sized to the fullest planned profile (15 default
// + 2 evidence-mirror indexes). Exceeding it degrades to the reduced
// chunks-only target list, so adding a search index becomes a deliberate act
// that must bump this budget. The rest of the budget machinery is targeted
// for deletion under P4.1 — do not build on it further.
const PROFILE_BUDGETS: Record<
	MemoryMongoDBDeploymentProfile,
	number | "unbounded"
> = {
	"atlas-local-preview": "unbounded",
	"atlas-managed": "unbounded",
	"community-mongot": 17,
}

export function assertIndexBudget(
	profile: MemoryMongoDBDeploymentProfile,
	plannedCount: number,
): MongoIndexBudgetCheck {
	const budget = PROFILE_BUDGETS[profile]
	if (typeof budget === "number") {
		return {
			profile,
			plannedSearchIndexes: plannedCount,
			budget,
			withinBudget: plannedCount <= budget,
		}
	}
	return {
		profile,
		plannedSearchIndexes: plannedCount,
		budget,
		withinBudget: true,
	}
}

/**
 * The local fuse — the PRIMARY enforcement (<100ms, offline). Decides
 * whether a call may proceed; the SaaS 429 is only the secondary gate.
 * Pure: budgets arrive with spentUsd precomputed (the store provides it) and
 * the route's reasoning set arrives pre-resolved (the caller provides it).
 *
 * ## Reasoning caps are ranked by the ROUTE, never by a local table
 *
 * `ReasoningEffortId` is adapter-owned and opaque: the harness core "brands
 * identifiers but does not enumerate their values; each adapter owns the
 * ordered set, display names, and optional deployment default", and
 * `LlmModelReasoningInfo.efforts` is published in "adapter-preferred display
 * order". A locally invented ordinal table — or worse, an ordering derived
 * from the id's characters — would rank an adapter id such as `none`/`off`
 * ABOVE `high` and cut the CHEAPEST possible request: a false-positive lock,
 * the exact failure the proposal's Phase 6 gate measures.
 *
 * So the cap compares indices inside the route's own ordered effort list.
 * When that list is unavailable (no route metadata, or an id the route does
 * not publish) the cap is UNENFORCEABLE, not satisfied: the decision reports
 * it through {@link FuseDecision.notEnforced} so the caller can warn and the
 * panel can show the gap. It never fabricates a verdict.
 */

export interface FuseBudget {
	limitUsd: number;
	spentUsd: number;
	window: "month" | "day";
}

export interface FusePolicies {
	/** Highest allowed reasoning effort, as an id from the route's own set. */
	maxReasoningEffort?: string;
	allowedModels?: string[];
	denylistedProjects?: string[];
}

export interface FuseDecision {
	allowed: boolean;
	rule: string | null;
	resetAt: string | null;
	/**
	 * Configured policies that could not be evaluated for this call (an
	 * observable gap, never a silent pass). Empty when every policy applied.
	 */
	notEnforced: string[];
}

/** Index of `effort` inside the route's ordered effort ids, or -1. */
function effortIndex(efforts: readonly string[], effort: string): number {
	return efforts.indexOf(effort);
}

export function fuseDecision(input: {
	project: string;
	model: string;
	reasoningEffort?: string;
	estimatedCostUsd: number;
	budgets: FuseBudget[];
	policies: FusePolicies;
	now: Date;
	/**
	 * The route's ordered reasoning-effort ids, cheapest first (harness
	 * `LlmModelReasoningInfo.efforts`, adapter-preferred display order).
	 * Absent/empty means the route publishes no reasoning metadata.
	 */
	reasoningEfforts?: readonly string[];
}): FuseDecision {
	const notEnforced: string[] = [];

	if (input.policies.denylistedProjects?.includes(input.project)) {
		return {
			allowed: false,
			rule: `denylist:${input.project}`,
			resetAt: null,
			notEnforced,
		};
	}

	if (
		input.policies.allowedModels &&
		!input.policies.allowedModels.includes(input.model)
	) {
		return {
			allowed: false,
			rule: `model_not_allowed:${input.model}`,
			resetAt: null,
			notEnforced,
		};
	}

	const cap = input.policies.maxReasoningEffort;
	const requested = input.reasoningEffort;
	if (cap && requested) {
		const efforts = input.reasoningEfforts ?? [];
		const requestedIndex = effortIndex(efforts, requested);
		const capIndex = effortIndex(efforts, cap);
		if (requestedIndex < 0 || capIndex < 0) {
			// Not rankable against this route — report it, never guess.
			notEnforced.push(`reasoning_cap:${cap}`);
		} else if (requestedIndex > capIndex) {
			return {
				allowed: false,
				rule: `reasoning_cap:${cap}`,
				resetAt: null,
				notEnforced,
			};
		}
	}

	for (const budget of input.budgets) {
		if (budget.spentUsd + input.estimatedCostUsd > budget.limitUsd) {
			const reset = new Date(input.now);
			if (budget.window === "month")
				reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
			else reset.setUTCDate(reset.getUTCDate() + 1);
			reset.setUTCHours(0, 0, 0, 0);
			return {
				allowed: false,
				rule: "budget_exceeded",
				resetAt: reset.toISOString(),
				notEnforced,
			};
		}
	}

	return { allowed: true, rule: null, resetAt: null, notEnforced };
}

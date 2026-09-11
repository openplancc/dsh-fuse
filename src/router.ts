/**
 * dsh-router — policy-based routing (proposal §1, módulo router).
 *
 * MVP = heuristic rules, honest and calibrated: pick the CHEAPEST allowed
 * model from a cascade (cheap → expensive) and escalate one step per retry
 * when the current route fails (FrugalGPT/RouteLLM pattern: rules first,
 * cheap→expensive, no hidden quality degradation — a router that visibly
 * degrades is worse than no router). Pure — no I/O.
 */

export interface RouterPolicies {
	/** Models a policy allows; absent = no model restriction. */
	allowedModels?: string[];
	/** Models explicitly excluded (provider denylist). */
	denylistedModels?: string[];
}

export type RouteReason =
	| "requested" // the harness's own choice passes policy — no routing needed
	| "allowed_first" // requested model denied → cheapest allowed from the cascade
	| "escalated"; // retry: the current route failed → next (more expensive) step

export interface RouteDecision {
	model: string;
	reason: RouteReason;
}

/** Pick a policy-compliant model for this attempt. */
export function routeDecision(input: {
	/** The model the harness asked for. */
	requestedModel: string;
	/** Attempt index (0 = first try, 1 = first retry, …). */
	attempt: number;
	/** Ordered cascade cheap → expensive (model ids, provider-prefixed). */
	cascade: string[];
	policies?: RouterPolicies;
}): RouteDecision {
	const allowed = input.cascade.filter(
		(model) =>
			(!input.policies?.allowedModels ||
				input.policies.allowedModels.includes(model)) &&
			!input.policies?.denylistedModels?.includes(model),
	);

	// First attempt + requested model allowed → the harness's choice stands.
	if (
		input.attempt === 0 &&
		input.policies?.allowedModels?.includes(input.requestedModel)
	) {
		return { model: input.requestedModel, reason: "requested" };
	}
	// First attempt + requested model denied → the cheapest allowed route.
	if (input.attempt === 0) {
		const fallback = allowed[0];
		if (!fallback) return { model: input.requestedModel, reason: "requested" };
		return { model: fallback, reason: "allowed_first" };
	}
	// Retry: escalate one step up the cascade from the currently used model
	// (the cheap route failed — the next is more capable, never cheaper).
	const currentIndex = allowed.indexOf(input.requestedModel);
	const next =
		allowed[currentIndex + 1] ??
		allowed[allowed.length - 1] ??
		input.requestedModel;
	return { model: next, reason: "escalated" };
}

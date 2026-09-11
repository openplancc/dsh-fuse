import { describe, expect, it } from "vitest";
import { fuseDecision } from "../src/fuse.js";

describe("fuseDecision — budgets", () => {
	it("blocks when the projected spend exceeds the budget", () => {
		const decision = fuseDecision({
			project: "daytrader",
			model: "m",
			estimatedCostUsd: 0.5,
			budgets: [{ limitUsd: 10, spentUsd: 9.6, window: "month" }],
			policies: {},
			now: new Date("2026-08-27T12:00:00Z"),
		});
		expect(decision.allowed).toBe(false);
		expect(decision.rule).toBe("budget_exceeded");
		expect(decision.resetAt).toContain("2026-09-01");
	});

	it("allows under-budget calls", () => {
		const decision = fuseDecision({
			project: "daytrader",
			model: "m",
			estimatedCostUsd: 0.1,
			budgets: [{ limitUsd: 10, spentUsd: 9.6, window: "month" }],
			policies: {},
			now: new Date("2026-08-27T12:00:00Z"),
		});
		expect(decision.allowed).toBe(true);
		expect(decision.notEnforced).toEqual([]);
	});

	it("counts the estimate, not just the spend already recorded", () => {
		// This is the pre-emptive property: spent alone is under the cap, but
		// this call would cross it.
		const decision = fuseDecision({
			project: "p",
			model: "m",
			estimatedCostUsd: 5,
			budgets: [{ limitUsd: 10, spentUsd: 9, window: "day" }],
			policies: {},
			now: new Date("2026-08-27T12:00:00Z"),
		});
		expect(decision.allowed).toBe(false);
	});
});

describe("fuseDecision — policy gates", () => {
	it("denies a denylisted project before any budget is consulted", () => {
		const decision = fuseDecision({
			project: "blocked-project",
			model: "m",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { denylistedProjects: ["blocked-project"] },
			now: new Date(),
		});
		expect(decision.rule).toBe("denylist:blocked-project");
	});

	it("denies a model outside the allowlist", () => {
		const decision = fuseDecision({
			project: "p",
			model: "dear/model",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { allowedModels: ["cheap/model"] },
			now: new Date(),
		});
		expect(decision.rule).toBe("model_not_allowed:dear/model");
	});
});

describe("fuseDecision — reasoning cap ranked by the route's own set", () => {
	/** A route whose ids are NOT the plugin's old hardcoded vocabulary. */
	const ROUTE = ["none", "low", "medium", "high"];

	it("allows an effort at or below the cap", () => {
		for (const effort of ["none", "low", "medium"]) {
			const decision = fuseDecision({
				project: "p",
				model: "m",
				reasoningEffort: effort,
				estimatedCostUsd: 0,
				budgets: [],
				policies: { maxReasoningEffort: "medium" },
				reasoningEfforts: ROUTE,
				now: new Date(),
			});
			expect(decision.allowed).toBe(true);
		}
	});

	it("denies an effort above the cap", () => {
		const decision = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "high",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "medium" },
			reasoningEfforts: ROUTE,
			now: new Date(),
		});
		expect(decision.allowed).toBe(false);
		expect(decision.rule).toBe("reasoning_cap:medium");
	});

	it("does NOT cut the cheapest request on a route whose ids are unknown to a static table", () => {
		// `none` is the cheapest possible effort. A character-code rank (the
		// previous implementation) scored it 110, above `high`, and blocked it.
		const decision = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "none",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "high" },
			reasoningEfforts: ROUTE,
			now: new Date(),
		});
		expect(decision.allowed).toBe(true);
		expect(decision.rule).toBeNull();
	});

	it("ranks by index, not by id spelling", () => {
		// An adapter is free to order its ids differently; the cap follows the
		// ROUTE's order. Here `high` is the cheapest tier and `low` the dearest.
		const inverted = ["high", "medium", "low"];
		const allowed = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "high",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "high" },
			reasoningEfforts: inverted,
			now: new Date(),
		});
		expect(allowed.allowed).toBe(true);
		const denied = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "low",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "high" },
			reasoningEfforts: inverted,
			now: new Date(),
		});
		expect(denied.allowed).toBe(false);
	});

	it("reports an unrankable cap instead of guessing when the route publishes nothing", () => {
		const decision = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "high",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "medium" },
			reasoningEfforts: [],
			now: new Date(),
		});
		// Not enforced, and visibly so — never a silent pass, never a false cut.
		expect(decision.allowed).toBe(true);
		expect(decision.notEnforced).toEqual(["reasoning_cap:medium"]);
	});

	it("reports an unrankable cap when the requested id is not in the route's set", () => {
		const decision = fuseDecision({
			project: "p",
			model: "m",
			reasoningEffort: "xhigh",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "medium" },
			reasoningEfforts: ["low", "medium", "high"],
			now: new Date(),
		});
		expect(decision.allowed).toBe(true);
		expect(decision.notEnforced).toEqual(["reasoning_cap:medium"]);
	});

	it("does not evaluate the cap when the call states no effort", () => {
		const decision = fuseDecision({
			project: "p",
			model: "m",
			estimatedCostUsd: 0,
			budgets: [],
			policies: { maxReasoningEffort: "medium" },
			reasoningEfforts: ["low", "high"],
			now: new Date(),
		});
		expect(decision.allowed).toBe(true);
		expect(decision.notEnforced).toEqual([]);
	});
});

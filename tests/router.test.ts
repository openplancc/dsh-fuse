import { describe, expect, it } from "vitest";
import { routeDecision } from "../src/router.js";

const CASCADE = [
	"openrouter/deepseek-chat", // cheapest
	"openrouter/qwen3-coder",
	"anthropic/claude-sonnet-5",
];

describe("routeDecision — cascata barato→caro (proposal dsh-router MVP)", () => {
	it("lets the harness's choice stand when it is allowed", () => {
		const decision = routeDecision({
			requestedModel: "anthropic/claude-sonnet-5",
			attempt: 0,
			cascade: CASCADE,
			policies: { allowedModels: CASCADE },
		});
		expect(decision).toEqual({
			model: "anthropic/claude-sonnet-5",
			reason: "requested",
		});
	});

	it("routes to the cheapest allowed model when the request is denied", () => {
		const decision = routeDecision({
			requestedModel: "anthropic/claude-sonnet-5",
			attempt: 0,
			cascade: CASCADE,
			policies: { allowedModels: ["openrouter/deepseek-chat"] },
		});
		expect(decision).toEqual({
			model: "openrouter/deepseek-chat",
			reason: "allowed_first",
		});
	});

	it("escalates one step per retry (the cheap route failed)", () => {
		const first = routeDecision({
			requestedModel: "openrouter/deepseek-chat",
			attempt: 1,
			cascade: CASCADE,
		});
		expect(first.reason).toBe("escalated");
		expect(first.model).toBe("openrouter/qwen3-coder");
		const second = routeDecision({
			requestedModel: "openrouter/qwen3-coder",
			attempt: 2,
			cascade: CASCADE,
		});
		expect(second.model).toBe("anthropic/claude-sonnet-5");
	});

	it("never escalates past the last allowed cascade step", () => {
		const decision = routeDecision({
			requestedModel: "anthropic/claude-sonnet-5",
			attempt: 3,
			cascade: CASCADE,
		});
		expect(decision.model).toBe("anthropic/claude-sonnet-5");
	});

	it("honors a provider denylist", () => {
		const decision = routeDecision({
			requestedModel: "anthropic/claude-sonnet-5",
			attempt: 0,
			cascade: CASCADE,
			policies: { denylistedModels: ["anthropic/claude-sonnet-5"] },
		});
		expect(decision).toEqual({
			model: "openrouter/deepseek-chat",
			reason: "allowed_first",
		});
	});

	it("falls back to the requested model when no cascade route is allowed", () => {
		const decision = routeDecision({
			requestedModel: "anthropic/claude-sonnet-5",
			attempt: 0,
			cascade: CASCADE,
			policies: { allowedModels: ["gpt-5.6"] },
		});
		expect(decision.model).toBe("anthropic/claude-sonnet-5");
		expect(decision.reason).toBe("requested");
	});

	it("escalation only considers allowed steps", () => {
		const decision = routeDecision({
			requestedModel: "openrouter/deepseek-chat",
			attempt: 1,
			cascade: CASCADE,
			policies: {
				allowedModels: [
					"openrouter/deepseek-chat",
					"anthropic/claude-sonnet-5",
				],
			},
		});
		// qwen3-coder is denied → jump to the next allowed step.
		expect(decision.model).toBe("anthropic/claude-sonnet-5");
	});
});

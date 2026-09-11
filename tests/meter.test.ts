import { describe, expect, it } from "vitest";
import { hashSessionId, projectCall } from "../src/meter.js";

describe("projectCall — the meter", () => {
	it("hashes the session id (the raw id never leaves the machine)", async () => {
		const hashed = await hashSessionId("session-abc");
		expect(hashed).not.toContain("session-abc");
		expect(hashed).toHaveLength(64);
		// Stable: the same session always hashes the same, so the SaaS can
		// group calls into a session without ever seeing the id.
		expect(await hashSessionId("session-abc")).toBe(hashed);
	});

	it("takes the model and provider from the message provenance", () => {
		const projection = projectCall({
			provenance: {
				provider: "command-code",
				model: "deepseek/deepseek-v4.1-flash",
			},
			header: {
				provider: "other",
				model: "other-model",
				reasoningEffort: "high",
			},
			usage: { inputTokens: 10, outputTokens: 20 },
			settledAt: 1000,
		});
		expect(projection.model).toBe("deepseek/deepseek-v4.1-flash");
		expect(projection.provider).toBe("command-code");
		// Reasoning effort only exists on the header — the log has no other home.
		expect(projection.reasoningEffort).toBe("high");
	});

	it("falls back to the header when provenance is absent", () => {
		const projection = projectCall({
			header: { provider: "p", model: "m" },
			usage: { inputTokens: 1, outputTokens: 1 },
			settledAt: 1000,
		});
		expect(projection.model).toBe("m");
		expect(projection.provider).toBe("p");
		expect(projection.reasoningEffort).toBe("");
	});

	it("carries the full disjoint token accounting", () => {
		const projection = projectCall({
			usage: {
				inputTokens: 100,
				outputTokens: 50,
				cacheReadTokens: 900,
				cacheWriteTokens: 400,
			},
			settledAt: 1000,
		});
		expect(projection.counts).toEqual({
			inputTokens: 100,
			outputTokens: 50,
			cacheReadTokens: 900,
			cacheWriteTokens: 400,
		});
	});

	it("coerces absent or nonsensical counts to zero rather than NaN", () => {
		const projection = projectCall({
			usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: -5 },
			settledAt: 1000,
		});
		expect(projection.counts.cacheReadTokens).toBe(0);
		expect(projection.counts.cacheWriteTokens).toBe(0);
	});

	it("measures the step's model-request latency from step/start", () => {
		expect(
			projectCall({
				usage: { inputTokens: 1, outputTokens: 1 },
				settledAt: 2500,
				stepStartedAt: 500,
			}).durationMs,
		).toBe(2000);
	});

	it("reports no duration when the step start was not observed", () => {
		expect(
			projectCall({
				usage: { inputTokens: 1, outputTokens: 1 },
				settledAt: 2500,
			}).durationMs,
		).toBeNull();
		// A settlement before the recorded start is not a negative duration.
		expect(
			projectCall({
				usage: { inputTokens: 1, outputTokens: 1 },
				settledAt: 100,
				stepStartedAt: 500,
			}).durationMs,
		).toBeNull();
	});
});

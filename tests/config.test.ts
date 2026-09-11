import { describe, expect, it } from "vitest";
import {
	assertUsableConfig,
	type DshPluginConfig,
	resolveConfig,
} from "../src/config.js";
import { mountPlugin } from "./support.js";

/** Resolve config through the real schema, as Cordis does before `apply`. */
function resolve(partial: Record<string, unknown>): DshPluginConfig {
	return resolveConfig(partial);
}

describe("Config schema", () => {
	it("fills every default a deployment is likely to keep", () => {
		const config = resolve({});
		// Empty storeUrl means the harness-home-anchored default store, not a
		// CWD-relative file (see store.ts: defaultStoreUrl).
		expect(config.storeUrl).toBe("");
		expect(config.project).toBe("default");
		expect(config.dev).toBe("unknown");
		expect(config.budgets).toEqual([]);
		expect(config.cascade).toEqual([]);
		expect(config.syncIntervalMs).toBe(60_000);
		expect(config.policyRefreshMs).toBe(300_000);
		expect(config.pricingTable).toEqual({});
		expect(config.pricingAliases).toEqual({});
		expect(config.pricingRegistryUrl).toBe("https://models.dev/api.json");
		expect(config.pricingGatewayUrl).toBe("");
		// The model-facing status tool is on by default.
		expect(config.budgetStatusTool).toBe(true);
		// An empty object — the priceFor guard treats it as absent.
		expect(config.unpricedFallback).toEqual({});
		// Policies resolve to a definite shape with explicit "unset" encodings.
		expect(config.policies).toEqual({
			maxReasoningEffort: "",
			allowedModels: [],
			denylistedProjects: [],
		});
	});

	it("refuses a wrong type instead of loading half-configured", () => {
		expect(() => resolve({ budgets: "nope" })).toThrow();
		expect(() => resolve({ syncIntervalMs: "soon" })).toThrow();
		expect(() =>
			resolve({ pricingTable: { m: { inputCentsPerM: "x" } } }),
		).toThrow();
	});

	it("refuses an invalid budget window", () => {
		expect(() =>
			resolve({ budgets: [{ limitUsd: 10, window: "week" }] }),
		).toThrow();
	});

	it("keeps a valid config intact", () => {
		const config = resolve({
			storeUrl: ":memory:",
			project: "openplan",
			budgets: [{ limitUsd: 50, window: "month" }],
			pricingTable: {
				"gpt-4o": { inputCentsPerM: 250, outputCentsPerM: 1000 },
			},
		});
		expect(config.project).toBe("openplan");
		expect(config.budgets).toEqual([{ limitUsd: 50, window: "month" }]);
		expect(config.pricingTable["gpt-4o"]?.inputCentsPerM).toBe(250);
	});
});

describe("assertUsableConfig — refuses configuration it cannot act on", () => {
	it("accepts budgets with NO price source — prices resolve generically", () => {
		// The old "budgets require a price source" gate forced every deployment
		// to hand-maintain a table. Prices now resolve by model id generically;
		// an unpriced call is a visible state, not a boot failure.
		expect(() =>
			assertUsableConfig(
				resolve({ budgets: [{ limitUsd: 10, window: "day" }] }),
			),
		).not.toThrow();
	});

	it("accepts an explicit table, a fallback rate, or both", () => {
		expect(() =>
			assertUsableConfig(
				resolve({
					budgets: [{ limitUsd: 10, window: "day" }],
					pricingTable: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
				}),
			),
		).not.toThrow();
		expect(() =>
			assertUsableConfig(
				resolve({
					budgets: [{ limitUsd: 10, window: "day" }],
					unpricedFallback: {
						inputCentsPerM: 15,
						outputCentsPerM: 60,
					},
				}),
			),
		).not.toThrow();
	});

	it("refuses a malformed fallback rate", () => {
		expect(() =>
			resolve({ unpricedFallback: { inputCentsPerM: "x" } }),
		).toThrow();
	});

	it("refuses half a sync target", () => {
		expect(() => assertUsableConfig(resolve({ baseUrl: "https://x" }))).toThrow(
			/together/i,
		);
		expect(() => assertUsableConfig(resolve({ orgKey: "dsh_x" }))).toThrow(
			/together/i,
		);
		expect(() =>
			assertUsableConfig(resolve({ baseUrl: "https://x", orgKey: "dsh_x" })),
		).not.toThrow();
	});

	it("refuses a cascade that can never pick a permitted model", () => {
		expect(() =>
			assertUsableConfig(
				resolve({
					cascade: ["cheap/model"],
					policies: { allowedModels: ["other/model"] },
				}),
			),
		).toThrow(/intersect/i);
	});
});

describe("load-time behaviour", () => {
	it("mounts with budgets and no price source — resolution is generic", async () => {
		const { dispose } = await mountPlugin({
			storeUrl: ":memory:",
			budgets: [{ limitUsd: 10, window: "day" }],
		});
		await dispose();
	});

	it("fails the plugin load when the config cannot be acted on", async () => {
		await expect(
			mountPlugin({ storeUrl: ":memory:", baseUrl: "https://x" }),
		).rejects.toThrow(/together/i);
	});

	it("mounts when the config is usable", async () => {
		const { dispose } = await mountPlugin({ storeUrl: ":memory:" });
		await dispose();
	});
});

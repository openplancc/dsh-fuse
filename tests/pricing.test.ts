import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createPricingCache,
	estimateCostUsd,
	fetchPricingTable,
	parseGatewayModels,
	parsePricingRegistry,
	pricingCandidates,
	resolvePricingEntry,
} from "../src/pricing.js";

/** Registry shape (models.dev api.json), trimmed to one provider. */
const REGISTRY_SAMPLE = {
	opencode: {
		name: "OpenCode Zen",
		models: {
			"deepseek-v4-flash": {
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
			"gpt-5.5": {
				cost: { input: 5, output: 30, cache_read: 0.5 },
			},
		},
	},
	opencodego: {
		name: "OpenCode Go",
		models: {
			"deepseek-v4-flash": {
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
			"deepseek-v4.1-flash": {
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
		},
	},
	deepseek: {
		name: "DeepSeek",
		models: {
			"deepseek-v4-flash": {
				cost: { input: 0.15, output: 0.6, cache_read: 0.003 },
			},
		},
	},
};

describe("registry parsing (models.dev shape)", () => {
	it("keys by provider/model AND publishes the modal bare-model quote", () => {
		const { table, routes, models } = parsePricingRegistry(REGISTRY_SAMPLE);
		// USD per 1M → cents per 1M.
		expect(table["opencodego/deepseek-v4-flash"]).toEqual({
			inputCentsPerM: 15,
			outputCentsPerM: 60,
			cacheReadCentsPerM: 0.3,
		});
		expect(table["opencode/deepseek-v4-flash"]).toEqual({
			inputCentsPerM: 15,
			outputCentsPerM: 60,
			cacheReadCentsPerM: 0.3,
		});
		// Modal bare model: all three providers agree at 15/60/0.3.
		expect(table["deepseek-v4-flash"]).toEqual({
			inputCentsPerM: 15,
			outputCentsPerM: 60,
			cacheReadCentsPerM: 0.3,
		});
		expect(routes).toBe(5);
		expect(models).toBe(3);
	});

	it("picks the MODAL quote across providers, not the mean", () => {
		const json = {
			a: { models: { m: { cost: { input: 0.15, output: 0.6 } } } },
			b: { models: { m: { cost: { input: 0.15, output: 0.6 } } } },
			c: { models: { m: { cost: { input: 5, output: 30 } } } },
			d: { models: { m: { cost: { input: 0.15, output: 0.6 } } } },
		};
		const { table } = parsePricingRegistry(json);
		// 3 of 4 agree at the list price — the modal value wins despite one
		// wide outlier (this is the measured gpt-5.5 distribution).
		expect(table.m).toEqual({ inputCentsPerM: 15, outputCentsPerM: 60 });
	});

	it("is honest about garbage: no prices means an empty table", () => {
		expect(parsePricingRegistry(null).table).toEqual({});
		expect(parsePricingRegistry({ p: { models: { m: {} } } }).table).toEqual(
			{},
		);
		expect(
			parsePricingRegistry({
				p: { models: { m: { cost: { input: -1, output: 1 } } } },
			}).table,
		).toEqual({});
	});
});

describe("gateway /models parsing (OpenRouter / DeepInfra / Novita shapes)", () => {
	it("reads OpenRouter's per-token pricing", () => {
		const res = parseGatewayModels(
			{
				data: [
					{
						id: "gpt-5.5",
						pricing: {
							prompt: "0.000005",
							completion: "0.00003",
							input_cache_read: "0.0000005",
							input_cache_write: "0.00000625",
						},
					},
				],
			},
			"openrouter",
		);
		expect(res.priced).toBe(1);
		expect(res.total).toBe(1);
		expect(res.table["openrouter/gpt-5.5"]).toEqual({
			inputCentsPerM: 5 * 100, // 0.000005 → $5/1M → 500 cents
			outputCentsPerM: 30 * 100, // 0.00003 → $30/1M → 3000
			cacheReadCentsPerM: 0.0000005 * 1e6 * 100,
			cacheWriteCentsPerM: 0.00000625 * 1e6 * 100,
		});
	});

	it("reads DeepInfra's metadata.pricing (USD per 1M)", () => {
		const res = parseGatewayModels(
			{
				data: [
					{
						id: "meta-models/Muse-Glimmer-30B",
						metadata: {
							pricing: {
								input_tokens: 0.3,
								output_tokens: 1.2,
								cache_read_tokens: 0.04,
							},
						},
					},
				],
			},
			"deepinfra",
		);
		expect(res.table["deepinfra/muse-glimmer-30b"]).toEqual({
			inputCentsPerM: 30,
			outputCentsPerM: 120,
			cacheReadCentsPerM: 4,
		});
	});

	it("reads Novita's per-1M top-level fields ($0.0001 units)", () => {
		const res = parseGatewayModels(
			{
				data: [
					{
						id: "glm-5.2",
						input_token_price_per_m: 15_000,
						output_token_price_per_m: 44_000,
					},
				],
			},
			"novita",
		);
		// 15000 → $1.50/1M → 150 cents/1M input; 44000 → $4.40 → 440 cents.
		expect(res.table["novita/glm-5.2"]).toEqual({
			inputCentsPerM: 150,
			outputCentsPerM: 440,
		});
	});

	it("returns an empty priced table when the gateway publishes no prices", () => {
		const res = parseGatewayModels(
			{
				data: [
					{
						id: "deepseek-v4-flash",
						context_length: 1_000_000,
						owned_by: "command-code",
					},
				],
			},
			"command-code",
		);
		expect(res.priced).toBe(0);
		expect(res.total).toBe(1);
		expect(res.table).toEqual({});
	});
});

describe("fetchPricingTable — merge sources, never throw, override wins", () => {
	it("reads the gateway first, then the registry, and lets config override", async () => {
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						data: [
							{ id: "deepseek-v4-flash", cost: { input: 0.99, output: 0.99 } },
						],
					}),
				),
			)
			.mockResolvedValueOnce(new Response(JSON.stringify(REGISTRY_SAMPLE)));
		const { table, failures, gatewayPriced } = await fetchPricingTable({
			registryUrl: "https://models.dev/api.json",
			gatewayUrl: "https://api.commandcode.ai/provider/v1/models",
			gatewayProvider: "command-code",
			override: {
				"opencodego/deepseek-v4-flash": {
					inputCentsPerM: 1,
					outputCentsPerM: 2,
				},
			},
			fetchImpl,
		});
		expect(failures).toEqual([]);
		expect(gatewayPriced).toBe(1);
		// The gateway's own number wins for ITS route.
		expect(table["command-code/deepseek-v4-flash"]).toEqual({
			inputCentsPerM: 99,
			outputCentsPerM: 99,
		});
		// The registry fills the other routes.
		expect(table["opencodego/deepseek-v4.1-flash"]).toEqual({
			inputCentsPerM: 15,
			outputCentsPerM: 60,
			cacheReadCentsPerM: 0.3,
		});
		// The user's explicit table wins over the registry on a per-key basis.
		expect(table["opencodego/deepseek-v4-flash"]).toEqual({
			inputCentsPerM: 1,
			outputCentsPerM: 2,
		});
	});

	it("a failed fetch never throws — the config table survives", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"));
		const { table, failures } = await fetchPricingTable({
			registryUrl: "https://models.dev/api.json",
			override: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
			fetchImpl,
		});
		expect(failures.length).toBeGreaterThanOrEqual(1);
		expect(table.m).toEqual({ inputCentsPerM: 1, outputCentsPerM: 1 });
	});
});

describe("pricing cache (TTL, non-blocking)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("hydrates from persisted state and refreshes past the TTL", async () => {
		vi.useFakeTimers();
		let calls = 0;
		const cache = createPricingCache(
			() =>
				new Promise((resolve) =>
					setTimeout(() => {
						calls += 1;
						resolve({
							table: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
						});
					}, 10),
				),
			1000,
		);
		// A persisted table is available before any fetch (offline first boot).
		cache.hydrate({ m: { inputCentsPerM: 5, outputCentsPerM: 5 } });
		expect(cache.current().m).toEqual({
			inputCentsPerM: 5,
			outputCentsPerM: 5,
		});
		cache.refresh();
		cache.refresh(); // deduped while in flight
		await vi.advanceTimersByTimeAsync(20);
		expect(cache.current().m).toEqual({
			inputCentsPerM: 1,
			outputCentsPerM: 1,
		});
		expect(calls).toBe(1);
		// Within the TTL: no refetch.
		cache.refresh();
		await vi.advanceTimersByTimeAsync(20);
		expect(calls).toBe(1);
		// Past the TTL: refetches.
		await vi.advanceTimersByTimeAsync(1100);
		cache.refresh();
		await vi.advanceTimersByTimeAsync(20);
		expect(calls).toBe(2);
	});
});

describe("price-key resolution — the provider-prefixed id", () => {
	const TABLE = {
		"deepseek-v4.1-flash": { inputCentsPerM: 14, outputCentsPerM: 28 },
		"openai/gpt-4o": { inputCentsPerM: 250, outputCentsPerM: 1000 },
		"command-code/deepseek-v4.1-flash": {
			inputCentsPerM: 15,
			outputCentsPerM: 60,
		},
		"claude-sonnet-5": { inputCentsPerM: 300, outputCentsPerM: 1500 },
	};

	it("offers the full id then each stripped suffix", () => {
		expect(pricingCandidates("deepseek/deepseek-v4.1-flash")).toEqual([
			"deepseek/deepseek-v4.1-flash",
			"deepseek-v4.1-flash",
		]);
		expect(pricingCandidates("openrouter/anthropic/claude-sonnet-5")).toEqual([
			"openrouter/anthropic/claude-sonnet-5",
			"anthropic/claude-sonnet-5",
			"claude-sonnet-5",
		]);
		// With a known route, the provider-qualified form is tried too.
		expect(pricingCandidates("gpt-4o", "openai")).toEqual([
			"gpt-4o",
			"openai/gpt-4o",
		]);
	});

	it("prefers the exact ROUTE key — the same model costs differently per route", () => {
		const resolved = resolvePricingEntry(
			TABLE,
			"deepseek/deepseek-v4.1-flash",
			{ provider: "command-code" },
		);
		// The route key wins over the bare suffix: the route's own price (15/60)
		// must not be shadowed by a bare-key price (14/28) from another route.
		expect(resolved?.key).toBe("command-code/deepseek-v4.1-flash");
		expect(resolved?.via).toBe("route");
	});

	it("falls back to the bare modal key when the route is absent", () => {
		const resolved = resolvePricingEntry(
			TABLE,
			"deepseek/deepseek-v4.1-flash",
			{ provider: "private-gateway" },
		);
		expect(resolved?.key).toBe("deepseek-v4.1-flash");
		expect(resolved?.via).toBe("model");
	});

	it("resolves a bare reported id against a provider-qualified table key", () => {
		const resolved = resolvePricingEntry(TABLE, "gpt-4o", {
			provider: "openai",
		});
		expect(resolved?.key).toBe("openai/gpt-4o");
		expect(resolved?.via).toBe("route");
	});

	it("prefers an explicit alias above every derived candidate", () => {
		const resolved = resolvePricingEntry(
			{ ...TABLE, "my-rate": { inputCentsPerM: 1, outputCentsPerM: 1 } },
			"deepseek/deepseek-v4.1-flash",
			{ aliases: { "deepseek/deepseek-v4.1-flash": "my-rate" } },
		);
		expect(resolved?.key).toBe("my-rate");
		expect(resolved?.via).toBe("alias");
	});

	it("returns null for an unpriced model instead of inventing zero", () => {
		expect(resolvePricingEntry(TABLE, "nobody/model")).toBeNull();
		expect(
			estimateCostUsd(TABLE, "nobody/model", {
				inputTokens: 1000,
				outputTokens: 1000,
				cacheReadTokens: 0,
			}),
		).toBeNull();
	});

	it("prices the real call shape end to end", () => {
		const priced = estimateCostUsd(
			TABLE,
			"deepseek/deepseek-v4.1-flash",
			{
				inputTokens: 4000,
				outputTokens: 512,
				cacheReadTokens: 0,
			},
			{ provider: "command-code" },
		);
		// Route rate: 4000·15/1e6 + 512·60/1e6, in cents, ÷100 → $0.0009072.
		expect(priced?.costUsd).toBeCloseTo(0.0009072, 10);
	});

	it("prices cache reads and writes when the table publishes them", () => {
		const table = {
			m: {
				inputCentsPerM: 100,
				outputCentsPerM: 200,
				cacheReadCentsPerM: 10,
				cacheWriteCentsPerM: 125,
			},
		};
		// 1M of each: $1 + $2 + $0.10 + $1.25 = $4.35
		const priced = estimateCostUsd(table, "m", {
			inputTokens: 1_000_000,
			outputTokens: 1_000_000,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		expect(priced?.costUsd).toBeCloseTo(4.35, 8);
	});

	it("falls back to the input rate for cache tokens the table omits (conservative)", () => {
		const table = { m: { inputCentsPerM: 100, outputCentsPerM: 100 } };
		const priced = estimateCostUsd(table, "m", {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 1_000_000,
			cacheWriteTokens: 1_000_000,
		});
		expect(priced?.costUsd).toBeCloseTo(2, 8);
	});
});

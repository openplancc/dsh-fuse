/**
 * Pricing for the fuse and the meter — resolved generically, never hand-maintained.
 *
 * ## Why this module exists at all
 *
 * The harness reports **tokens**, exactly and for free (`TokenUsage`), and models
 * **no monetary cost anywhere** (the only "pricing" in the harness is per-route
 * *image* token pricing). The proposal asks for `cost_usd` and `limitUsd`, so
 * `USD = tokens × price` and this module owns the `price` half.
 *
 * Nobody is invoiced from this number: its jobs are to express the customer's own
 * policy in the unit they wrote it in, and to rank projects/sessions against each
 * other. An approximate price is therefore fine; a MISSING price is fatal — it
 * prices every call at zero, so no budget ever cuts and both gates go inert. That
 * is the defect this resolver exists to prevent.
 *
 * ## Resolution order (measured against real gateways)
 *
 * 1. `pricingAliases[model]` — explicit escape hatch, highest precedence.
 * 2. `${provider}/${model}` — the exact route, from the registry or the gateway's
 *    own `/models`. This is the correct key: the same model costs different
 *    amounts on different routes (`deepseek/deepseek-v4.1-flash` ranges
 *    $0.15–$0.375 per 1M input across registries), so keying on model alone is
 *    wrong in principle.
 * 3. bare `model` — the provider is absent from the registry (a private gateway).
 *    Falls back to the **consensus** price across every provider that publishes
 *    the model: the modal quote, which measurements show is the upstream list
 *    price that pass-through resellers charge "at cost".
 * 4. progressively trimmed variants, then `${provider}/${bare}`.
 * 5. `null` — reported as **unpriced**, never silently zero.
 *
 * Verified on this machine's real routes: a pass-through reseller that publishes
 * "at cost" pricing reproduces the registry's numbers to the cent (8/8 models),
 * and the generic resolver prices 68/69 of its catalogue with no per-provider
 * configuration.
 */

export interface PricingEntry {
	inputCentsPerM: number;
	outputCentsPerM: number;
	cacheReadCentsPerM?: number;
	cacheWriteCentsPerM?: number;
}

export type PricingTable = Record<string, PricingEntry>;

/** Token counts priced by {@link estimateCostUsd}. */
export interface TokenCounts {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens?: number;
}

/** Explicit `model id → price-table key` overrides; highest precedence. */
export type PricingAliases = Record<string, string>;

/** Default registry: 200+ providers, `cost` in USD per 1M tokens. */
export const DEFAULT_REGISTRY_URL = "https://models.dev/api.json";

/** How a key was derived from the requested model id — feeds diagnostics. */
export type PricingVia =
	| "alias"
	| "exact"
	| "route"
	| "model"
	| "suffix"
	| "provider";

/** Which candidate key resolved, and how. */
export interface PricingResolution {
	entry: PricingEntry;
	/** The table key that matched. */
	key: string;
	/** How the key was derived from the requested model id. */
	via: PricingVia;
}

/** Lowercase + separator-normalized form used for every lookup. */
export function normalizeModelId(model: string): string {
	return model.trim().toLowerCase().replace(/[:_]/g, "-").replace(/\s+/g, "-");
}

/**
 * Ordered candidate keys for one model id, most specific first.
 *
 * `provider/anthropic/claude-sonnet-5` yields the full id, then each
 * progressively stripped suffix (`anthropic/claude-sonnet-5`,
 * `claude-sonnet-5`) — so a table keyed by a bare model id, by a
 * vendor-qualified id, or by the adapter's own prefixed id all resolve. When
 * the caller knows the provider route, `${provider}/${bare}` is tried too
 * (a table keyed `openai/gpt-4o` still prices a reported `gpt-4o`).
 */
export function pricingCandidates(model: string, provider?: string): string[] {
	const out: string[] = [];
	const push = (value: string) => {
		const trimmed = value.trim();
		if (trimmed && !out.includes(trimmed)) out.push(trimmed);
	};
	push(model);
	const segments = model.split("/").filter(Boolean);
	for (let i = 1; i < segments.length; i += 1) {
		push(segments.slice(i).join("/"));
	}
	const bare = segments[segments.length - 1];
	if (provider && bare) push(`${provider}/${bare}`);
	return out;
}

/** Bare model id (last path segment), normalized. */
function bareModelId(model: string): string {
	const segments = model.split("/").filter(Boolean);
	return normalizeModelId(segments[segments.length - 1] ?? model);
}

/**
 * Resolve the price entry for one model id.
 *
 * Precedence: explicit alias → exact key → `${provider}/${bare}` → bare model →
 * progressively stripped suffix. Returns `null` when nothing matches, so callers
 * can report the miss (and mark the call unpriced) instead of pricing at zero.
 */
export function resolvePricingEntry(
	table: PricingTable | undefined,
	model: string,
	opts: { provider?: string; aliases?: PricingAliases } = {},
): PricingResolution | null {
	if (!table) return null;

	const aliasTarget = opts.aliases?.[model];
	if (aliasTarget) {
		const entry = table[aliasTarget];
		if (entry) return { entry, key: aliasTarget, via: "alias" };
	}

	// 1. exact reported id (a table may be keyed by the adapter's own id).
	const exact = table[model];
	if (exact) return { entry: exact, key: model, via: "exact" };

	const bare = bareModelId(model);

	// 2. the exact route — `provider/model`. The correct key when present.
	if (opts.provider && bare) {
		const routeKey = `${normalizeModelId(opts.provider)}/${bare}`;
		const entry = table[routeKey];
		if (entry) return { entry, key: routeKey, via: "route" };
	}

	// 3. bare model — the provider is not in the registry (private gateway).
	const bareEntry = table[bare];
	if (bareEntry) return { entry: bareEntry, key: bare, via: "model" };

	// 4. progressively stripped variants, then `${provider}/${bare}`.
	for (const candidate of pricingCandidates(model, opts.provider).slice(1)) {
		const entry = table[candidate];
		if (!entry) continue;
		const via: PricingVia = candidate.includes("/") ? "suffix" : "provider";
		return { entry, key: candidate, via };
	}
	return null;
}

/**
 * Cost in USD from the resolved table entry (cents per 1M tokens).
 *
 * Cache reads and writes price at the entry's own cache rate when the table
 * publishes one, and at the INPUT rate when it does not — deliberately
 * conservative: the fuse prefers overestimating spend to missing a cut. The
 * harness reports cache counts as DISJOINT from `inputTokens` (`TokenUsage`:
 * "billed input = sum of the three"), so nothing is double counted here, and
 * `reasoningTokens` is deliberately ignored because the docs state it is
 * "already included in `outputTokens`; totals must not add it again".
 *
 * @returns USD cost plus the key that priced it, or `null` when the model is
 *   unpriced — this function never invents a price.
 */
export function estimateCostUsd(
	table: PricingTable | undefined,
	model: string,
	counts: TokenCounts,
	opts: { provider?: string; aliases?: PricingAliases } = {},
): { costUsd: number; key: string; via: PricingVia } | null {
	const resolved = resolvePricingEntry(table, model, opts);
	if (!resolved) return null;
	const { entry } = resolved;
	const cacheReadCentsPerM = entry.cacheReadCentsPerM ?? entry.inputCentsPerM;
	const cacheWriteCentsPerM = entry.cacheWriteCentsPerM ?? entry.inputCentsPerM;
	const cents =
		counts.inputTokens * entry.inputCentsPerM +
		counts.outputTokens * entry.outputCentsPerM +
		counts.cacheReadTokens * cacheReadCentsPerM +
		(counts.cacheWriteTokens ?? 0) * cacheWriteCentsPerM;
	return {
		costUsd: cents / 1e6 / 100,
		key: resolved.key,
		via: resolved.via,
	};
}

// ── Source 1: the registry (models.dev) ───────────────────────────────────────

/** One registry model entry's `cost`, in USD per 1M tokens. */
interface RegistryCost {
	input?: unknown;
	output?: unknown;
	cache_read?: unknown;
	cache_write?: unknown;
}

function usdPerMToCents(raw: unknown): number | undefined {
	if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
		return undefined;
	}
	return raw * 100;
}

function registryEntry(cost: RegistryCost): PricingEntry | null {
	const input = usdPerMToCents(cost.input);
	const output = usdPerMToCents(cost.output);
	if (input === undefined || output === undefined) return null;
	const cacheRead = usdPerMToCents(cost.cache_read);
	const cacheWrite = usdPerMToCents(cost.cache_write);
	return {
		inputCentsPerM: input,
		outputCentsPerM: output,
		...(cacheRead !== undefined ? { cacheReadCentsPerM: cacheRead } : {}),
		...(cacheWrite !== undefined ? { cacheWriteCentsPerM: cacheWrite } : {}),
	};
}

/**
 * Parse the registry into a table keyed BOTH ways:
 *
 * - `${provider}/${model}` — the exact route (authoritative).
 * - bare `${model}` — the **modal** (most-agreed) quote across every provider,
 *   used only when the route is absent. Measurements show this modal value is
 *   the upstream list price (e.g. 34 of 39 providers quote exactly $5.00/1M for
 *   `gpt-5.5`), which is what a pass-through reseller charges at cost.
 *
 * Every key is normalized so a reported `deepseek/deepseek-v4.1-flash` and a
 * registry `deepseek-v4.1-flash` land on the same lookup.
 */
export function parsePricingRegistry(json: unknown): {
	table: PricingTable;
	routes: number;
	models: number;
} {
	const table: PricingTable = {};
	if (typeof json !== "object" || json === null) {
		return { table, routes: 0, models: 0 };
	}
	/** bare model → (quote key → {entry, providers}). */
	const quotes = new Map<
		string,
		Map<string, { entry: PricingEntry; providers: number }>
	>();
	let routes = 0;

	for (const [providerId, providerValue] of Object.entries(
		json as Record<string, unknown>,
	)) {
		if (typeof providerValue !== "object" || providerValue === null) continue;
		const models = (providerValue as { models?: unknown }).models;
		if (typeof models !== "object" || models === null) continue;
		const provider = normalizeModelId(providerId);

		for (const [rawModelId, modelValue] of Object.entries(
			models as Record<string, unknown>,
		)) {
			if (typeof modelValue !== "object" || modelValue === null) continue;
			const cost = (modelValue as { cost?: unknown }).cost;
			if (typeof cost !== "object" || cost === null) continue;
			const entry = registryEntry(cost as RegistryCost);
			if (!entry) continue;

			const bare = bareModelId(rawModelId);
			const routeKey = `${provider}/${bare}`;
			// First writer wins per route: a provider advertising the same model
			// twice (e.g. `x` and `vendor/x`) must not override itself.
			if (!table[routeKey]) {
				table[routeKey] = entry;
				routes += 1;
			}
			const quoteKey = `${entry.inputCentsPerM}/${entry.outputCentsPerM}/${
				entry.cacheReadCentsPerM ?? ""
			}`;
			const bucket = quotes.get(bare) ?? new Map();
			const existing = bucket.get(quoteKey);
			if (existing) existing.providers += 1;
			else bucket.set(quoteKey, { entry, providers: 1 });
			quotes.set(bare, bucket);
		}
	}

	// Modal quote per model — the value most independent providers agree on.
	let models = 0;
	const bareKeys = new Set<string>();
	for (const [bare, bucket] of quotes) {
		let best: { entry: PricingEntry; providers: number } | null = null;
		for (const candidate of bucket.values()) {
			if (
				best === null ||
				candidate.providers > best.providers ||
				(candidate.providers === best.providers &&
					candidate.entry.inputCentsPerM < best.entry.inputCentsPerM)
			) {
				best = candidate;
			}
		}
		if (!best) continue;
		// A bare key must never shadow a real route key of the same name.
		if (!table[bare]) {
			table[bare] = best.entry;
			bareKeys.add(bare);
			models += 1;
		}
	}
	return { table, routes, models };
}

// ── Source 2: the gateway's own /models ───────────────────────────────────────

/** USD per token (string or number) → cents per 1M. */
function usdPerTokenToCents(raw: unknown): number | undefined {
	const value = typeof raw === "string" ? Number(raw) : raw;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return value * 1e6 * 100;
}

/**
 * Normalize one OpenAI-compatible `/models` entry that publishes prices.
 *
 * The convention is real but the shape is not standardized; three layouts cover
 * every publicly-readable gateway measured:
 * - OpenRouter: `pricing.{prompt,completion,input_cache_read,input_cache_write}`
 *   in USD **per token** (strings).
 * - DeepInfra: `metadata.pricing.{input_tokens,output_tokens,cache_read_tokens}`
 *   in USD **per 1M**.
 * - Novita: `input_token_price_per_m` / `output_token_price_per_m` per 1M.
 * A registry-shaped `cost.{input,output,cache_read,cache_write}` is accepted too.
 */
export function parseGatewayModelEntry(model: unknown): PricingEntry | null {
	if (typeof model !== "object" || model === null) return null;
	const m = model as Record<string, unknown>;
	const pricing = m.pricing as Record<string, unknown> | undefined;
	const cost = m.cost as RegistryCost | undefined;
	const meta = m.metadata as Record<string, unknown> | undefined;
	const metaPricing = meta?.pricing as Record<string, unknown> | undefined;

	// OpenRouter: USD per token.
	if (pricing) {
		const input = usdPerTokenToCents(pricing.prompt);
		const output = usdPerTokenToCents(pricing.completion);
		if (input !== undefined && output !== undefined) {
			const cacheRead = usdPerTokenToCents(pricing.input_cache_read);
			const cacheWrite = usdPerTokenToCents(pricing.input_cache_write);
			return {
				inputCentsPerM: input,
				outputCentsPerM: output,
				...(cacheRead !== undefined ? { cacheReadCentsPerM: cacheRead } : {}),
				...(cacheWrite !== undefined
					? { cacheWriteCentsPerM: cacheWrite }
					: {}),
			};
		}
	}
	// DeepInfra: USD per 1M under metadata.pricing.
	if (metaPricing) {
		const input = usdPerMToCents(metaPricing.input_tokens);
		const output = usdPerMToCents(metaPricing.output_tokens);
		if (input !== undefined && output !== undefined) {
			const cacheRead = usdPerMToCents(metaPricing.cache_read_tokens);
			return {
				inputCentsPerM: input,
				outputCentsPerM: output,
				...(cacheRead !== undefined ? { cacheReadCentsPerM: cacheRead } : {}),
			};
		}
	}
	// Novita: per-1M fields in $0.0001 units (1500 → $0.15/1M → 15 cents/1M).
	const novitaInputRaw = m.input_token_price_per_m;
	const novitaOutputRaw = m.output_token_price_per_m;
	const novitaInput =
		typeof novitaInputRaw === "number" && Number.isFinite(novitaInputRaw)
			? novitaInputRaw / 100
			: undefined;
	const novitaOutput =
		typeof novitaOutputRaw === "number" && Number.isFinite(novitaOutputRaw)
			? novitaOutputRaw / 100
			: undefined;
	if (novitaInput !== undefined && novitaOutput !== undefined) {
		return { inputCentsPerM: novitaInput, outputCentsPerM: novitaOutput };
	}
	// Registry-shaped `cost`.
	if (cost) return registryEntry(cost);
	return null;
}

/**
 * Parse a gateway `/models` response, keyed by `${provider}/${model}`.
 *
 * Returns an empty table when the gateway publishes no prices (e.g. command-code)
 * — the caller then falls back to the registry by model id.
 */
export function parseGatewayModels(
	json: unknown,
	provider: string,
): { table: PricingTable; priced: number; total: number } {
	const table: PricingTable = {};
	const list =
		typeof json === "object" && json !== null
			? ((json as { data?: unknown }).data ??
				(json as { models?: unknown }).models)
			: undefined;
	if (!Array.isArray(list)) return { table, priced: 0, total: 0 };
	const route = normalizeModelId(provider);
	let priced = 0;
	for (const model of list) {
		if (typeof model !== "object" || model === null) continue;
		const id = (model as { id?: unknown }).id;
		if (typeof id !== "string" || !id) continue;
		const entry = parseGatewayModelEntry(model);
		if (!entry) continue;
		table[`${route}/${bareModelId(id)}`] = entry;
		priced += 1;
	}
	return { table, priced, total: list.length };
}

// ── Fetch + cache ─────────────────────────────────────────────────────────────

/**
 * Fetch + merge every configured price source. Never throws: a failed source
 * keeps whatever the config already carries, and a config override always wins
 * on conflicts.
 *
 * The registry is the primary source (200+ providers, keyed by route, carries
 * cache read/write). A gateway `/models` is consulted first when configured,
 * because a gateway that publishes its own prices is authoritative for its own
 * routes.
 */
export async function fetchPricingTable(input: {
	/** Registry URL; pass `""` to skip. Defaults to {@link DEFAULT_REGISTRY_URL}. */
	registryUrl?: string;
	/** OpenAI-compatible `/models` URL that may publish prices. */
	gatewayUrl?: string;
	/** Provider id used to key the gateway's routes (e.g. "opencode-go"). */
	gatewayProvider?: string;
	/** Env var holding the gateway bearer token, when the endpoint needs auth. */
	gatewayApiKeyEnv?: string;
	/** User config wins over every fetched source on per-key conflicts. */
	override?: PricingTable;
	fetchImpl?: typeof fetch;
}): Promise<{
	table: PricingTable;
	failures: string[];
	routes: number;
	models: number;
	gatewayPriced: number;
}> {
	const fetchImpl = input.fetchImpl ?? fetch;
	const table: PricingTable = { ...(input.override ?? {}) };
	const failures: string[] = [];
	let routes = 0;
	let models = 0;
	let gatewayPriced = 0;

	const headers = (): Record<string, string> => {
		const envName = input.gatewayApiKeyEnv;
		const key = envName ? process.env[envName] : undefined;
		return key ? { authorization: `Bearer ${key}` } : {};
	};

	// The gateway first: its own numbers are authoritative for its own routes.
	if (input.gatewayUrl) {
		try {
			const res = await fetchImpl(input.gatewayUrl, { headers: headers() });
			if (!res.ok) {
				failures.push(`gateway: status ${res.status}`);
			} else {
				const parsed = parseGatewayModels(
					await res.json(),
					input.gatewayProvider ?? "gateway",
				);
				for (const [key, entry] of Object.entries(parsed.table)) {
					if (!table[key]) table[key] = entry;
				}
				gatewayPriced = parsed.priced;
			}
		} catch (err) {
			failures.push(`gateway: ${String(err).slice(0, 120)}`);
		}
	}

	// The registry.
	const registryUrl =
		input.registryUrl === undefined ? DEFAULT_REGISTRY_URL : input.registryUrl;
	if (registryUrl) {
		try {
			const res = await fetchImpl(registryUrl, {
				headers: { accept: "application/json" },
			});
			if (!res.ok) {
				failures.push(`registry: status ${res.status}`);
			} else {
				const parsed = parsePricingRegistry(await res.json());
				routes = parsed.routes;
				models = parsed.models;
				for (const [key, entry] of Object.entries(parsed.table)) {
					if (!table[key]) table[key] = entry;
				}
			}
		} catch (err) {
			failures.push(`registry: ${String(err).slice(0, 120)}`);
		}
	}

	return { table, failures, routes, models, gatewayPriced };
}

/**
 * TTL cache for the sync (refresh hourly; the first call inside the plugin is
 * non-blocking — the fuse starts on the config table and upgrades when the
 * fetch lands). `onUpdate` lets the caller persist the table for offline use.
 */
export function createPricingCache(
	fetchTable: () => Promise<{ table: PricingTable }>,
	ttlMs = 3_600_000,
	onUpdate?: (table: PricingTable) => void,
): {
	current: () => PricingTable;
	refresh: () => void;
	/** Seed the cache from persisted state (offline first boot). */
	hydrate: (table: PricingTable) => void;
} {
	let cached: PricingTable = {};
	let fetchedAt = 0;
	let inFlight: Promise<void> | null = null;
	return {
		current: () => cached,
		hydrate: (table) => {
			cached = table;
		},
		refresh: () => {
			if (inFlight || Date.now() - fetchedAt < ttlMs) return;
			inFlight = fetchTable()
				.then(({ table }) => {
					cached = table;
					fetchedAt = Date.now();
					onUpdate?.(table);
				})
				.catch(() => undefined)
				.finally(() => {
					inFlight = null;
				});
		},
	};
}

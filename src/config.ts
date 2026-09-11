/**
 * Plugin configuration — schema + cross-field validation.
 *
 * The harness plugin-config contract (develop/basic/config) asks for an
 * exported `Config` that is BOTH a TypeScript type and a runtime schema:
 * "Do not export a plain object as Config; it does not implement the Standard
 * Schema interface required by Cordis." Cordis validates it while the plugin
 * loads, so bad config fails the load "with a precise error — the plugin never
 * starts half-configured".
 *
 * ## Why the cross-field check matters more here than in a normal plugin
 *
 * A cost-enforcement plugin that loads with unusable configuration does not
 * merely misbehave — it enforces NOTHING, silently, while the deployment
 * believes it is protected. Configuration that cannot be acted on is refused
 * at load time (the documented rule: "A plugin should also reject
 * schema-valid config that names an unavailable resource or provider"), and
 * the shape that produces a silent no-op is rejected explicitly:
 *
 *  1. exactly one of `baseUrl` / `orgKey`. Half a sync target is not a
 *     degraded sync, it is no sync (plus no `GET /v1/policy`, so the panel
 *     cannot reach the local fuse at all).
 *
 * Prices are NOT required here: the plugin resolves them generically by model
 * id (see pricing.ts) and reports an unpriced call visibly rather than
 * refusing to load. The old "budgets require a price source" gate was removed
 * because it forced every deployment to hand-maintain a price table — exactly
 * the maintenance burden the generic resolver exists to eliminate; a missing
 * price is a visible state, not a boot failure and not a silent zero.
 */

import Schema from "@deepseek-ai/schemastery";
import type { PricingAliases, PricingTable } from "./pricing.js";

export interface BudgetConfig {
	limitUsd: number;
	window: "month" | "day";
}

export interface PolicyConfig {
	/**
	 * Highest allowed reasoning effort, as an id from the route's own set.
	 * Empty string means "no cap".
	 */
	maxReasoningEffort: string;
	/** Allowed models; empty means every model the harness routes is allowed. */
	allowedModels: string[];
	/** Denied projects; empty means nothing is denied. */
	denylistedProjects: string[];
}

export interface DshPluginConfig {
	/**
	 * libsql URL — a file for the installed plugin, `:memory:` for tests.
	 * Empty means the harness-home-anchored default
	 * (`$DSH_HOME/dsh-fuse/local.db`, `~/.dsh` when `$DSH_HOME` is
	 * unset); a relative `file:` path is honored only when explicitly set.
	 */
	storeUrl: string;
	/** Project label for windowing. */
	project: string;
	/** Developer identity carried on every usage row. */
	dev: string;
	/** Local caps — the fuse's budget inputs; spent comes from the store. */
	budgets: BudgetConfig[];
	/** Policy gates: reasoning cap, allowed models, project denylist. */
	policies: PolicyConfig;
	/** Routing cascade cheap → expensive (model ids). */
	cascade: string[];
	/** SaaS sync (optional): baseUrl + orgKey enable the 429 + policy pull. */
	baseUrl?: string;
	orgKey?: string;
	/** Sync cadence in ms. */
	syncIntervalMs: number;
	/** Policy-refresh cadence in ms (`GET /v1/policy`). */
	policyRefreshMs: number;
	/**
	 * Expose the model-facing budget-status tool (`dsh_budget_status`) to the
	 * agent: the docs' "separate model-facing ask tool" paired with the fuse
	 * gate. It is status-only — reads the same store the fuse enforces and
	 * never decides. The schema rides in every request, so a deployment that
	 * wants zero tool presence on the wire can turn it off.
	 */
	budgetStatusTool: boolean;
	/**
	 * Cost table (cents per 1M tokens) — YAML-serializable so the fuse has real
	 * numbers offline. Keys may be bare (`gpt-4o`), vendor-qualified, the
	 * adapter's own prefixed id, or the normalized `provider/model` route; the
	 * resolver tries each form (see pricing.ts). Optional: prices are resolved
	 * generically when this is empty.
	 */
	pricingTable: PricingTable;
	/**
	 * Explicit `reported model id → price-table key` overrides. The escape
	 * hatch for an adapter whose id nothing else can guess.
	 */
	pricingAliases: PricingAliases;
	/**
	 * The registry of model prices, keyed by route — auto-synced, cached by the
	 * plugin for offline use, never hand-maintained. Empty string disables it.
	 */
	pricingRegistryUrl: string;
	/**
	 * The gateway's own OpenAI-compatible `/models` URL. When it publishes
	 * prices, those numbers are authoritative for its routes; when it does not
	 * (e.g. command-code), the registry resolves each model id generically.
	 */
	pricingGatewayUrl: string;
	/**
	 * Provider id used to key the gateway's routes in the table.
	 */
	pricingGatewayProvider: string;
	/**
	 * Env var holding the gateway bearer token, when `/models` needs auth.
	 */
	pricingGatewayApiKeyEnv: string;
	/**
	 * ONE optional org-level rate for models nothing prices (cents per 1M) — a
	 * knob, not a table. Lets a USD budget still cut on an unpriced route.
	 * Absent = unpriced calls count $0 and are reported visibly as unpriced.
	 */
	unpricedFallback?: {
		inputCentsPerM: number;
		outputCentsPerM: number;
		cacheReadCentsPerM?: number;
		cacheWriteCentsPerM?: number;
	};
}

/**
 * The runtime schema Cordis validates before `apply` runs.
 *
 * Annotated as `Schema<Partial<DshPluginConfig>, DshPluginConfig>`: the first
 * parameter is what a `cordis.yml` entry supplies (every field optional, filled
 * by the schema defaults) and the second is what `apply` receives (complete).
 * An explicit annotation is required because the inferred form cannot be named
 * in the emitted declarations — it reaches into Schemastery's own type helpers
 * and their vendored dependencies, which breaks the build of a package that
 * ships `.d.ts`.
 */
export const Config: Schema<
	Partial<DshPluginConfig>,
	DshPluginConfig
> = Schema.object({
	// Empty storeUrl means "the harness-home-anchored default store"
	// (store.ts) — a stable ledger that does not wander with the CWD the
	// harness was started from.
	storeUrl: Schema.string().default(""),
	project: Schema.string().default("default"),
	dev: Schema.string().default("unknown"),
	budgets: Schema.array(
		Schema.object({
			limitUsd: Schema.number().min(0).required(),
			window: Schema.union(["month", "day"]).default("month"),
		}),
	).default([]),
	// "Unset" is encoded as an empty value rather than an absent key so the
	// validated config always has a definite shape (a half-present policy
	// object is exactly the kind of state that silently disables enforcement).
	policies: Schema.object({
		maxReasoningEffort: Schema.string().default(""),
		allowedModels: Schema.array(Schema.string()).default([]),
		denylistedProjects: Schema.array(Schema.string()).default([]),
	}).default({
		maxReasoningEffort: "",
		allowedModels: [],
		denylistedProjects: [],
	}),
	cascade: Schema.array(Schema.string()).default([]),
	baseUrl: Schema.string(),
	orgKey: Schema.string().role("secret"),
	syncIntervalMs: Schema.number().min(1000).default(60_000),
	policyRefreshMs: Schema.number().min(1000).default(300_000),
	budgetStatusTool: Schema.boolean().default(true),
	pricingTable: Schema.dict(
		Schema.object({
			inputCentsPerM: Schema.number().min(0).required(),
			outputCentsPerM: Schema.number().min(0).required(),
			cacheReadCentsPerM: Schema.number().min(0),
			cacheWriteCentsPerM: Schema.number().min(0),
		}),
	).default({}),
	pricingAliases: Schema.dict(Schema.string()).default({}),
	pricingRegistryUrl: Schema.string().default("https://models.dev/api.json"),
	pricingGatewayUrl: Schema.string().default(""),
	pricingGatewayProvider: Schema.string().default(""),
	pricingGatewayApiKeyEnv: Schema.string().default(""),
	unpricedFallback: Schema.object({
		inputCentsPerM: Schema.number().min(0),
		outputCentsPerM: Schema.number().min(0),
		cacheReadCentsPerM: Schema.number().min(0),
		cacheWriteCentsPerM: Schema.number().min(0),
	}),
});

/**
 * Validate raw configuration and apply defaults, exactly as Cordis does when it
 * loads the plugin. Exposed so tests and embedders can exercise the schema
 * without a cast: the parameter is the partially-populated shape a
 * `cordis.yml` entry supplies, and Schemastery fills every absent field.
 *
 * @throws when a value has the wrong type — Cordis surfaces that as a FAILED
 *   fibre ("invalid configuration fails the load with an actionable error").
 */
export function resolveConfig(raw: unknown): DshPluginConfig {
	// A schema's whole job is to validate untrusted input, so this is the one
	// place where the boundary is stated rather than assumed: `raw` is whatever
	// a `cordis.yml` entry (or a test) contains, and Schemastery throws on a
	// value whose type is wrong.
	return Config(raw as Partial<DshPluginConfig> | null);
}

/**
 * Cross-field constraints the schema cannot express, evaluated on the resolved
 * config (defaults applied) so they see exactly what `apply` will receive.
 *
 * @throws Error with an actionable message — Cordis turns it into a FAILED
 *   fiber, which is the documented outcome for config naming what the plugin
 *   cannot serve.
 */
export function assertUsableConfig(config: DshPluginConfig): void {
	if (Boolean(config.baseUrl) !== Boolean(config.orgKey)) {
		throw new Error(
			"baseUrl and orgKey must be configured together: without both, the plugin would report nothing and the panel could not reach the local fuse (local-only mode omits both).",
		);
	}
	if (config.cascade.length > 0 && config.policies.allowedModels.length > 0) {
		const allowed = new Set(config.policies.allowedModels);
		const usable = config.cascade.some((model) => allowed.has(model));
		if (!usable) {
			throw new Error(
				"cascade and policies.allowedModels do not intersect: the router could never pick a permitted model.",
			);
		}
	}
}

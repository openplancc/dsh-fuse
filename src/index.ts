/**
 * The dsh fuse — metering ≡ enforcement for local coding agents.
 *
 * A free plugin for the DeepSeek Harness that exports per-call telemetry
 * (metrics only: model, tokens, cost — never content) and enforces the org's
 * cost policy locally, before any token is spent. The SaaS aggregates the
 * team's sessions and publishes the policy; the local fuse applies it offline
 * and the batch's 429 is the secondary, central gate.
 *
 * ## How it extends the harness
 *
 * It is a **hook plugin** in the harness's own vocabulary (extension
 * cookbook): "an ordinary Cordis plugin on an interception point". It listens
 * on the `agent/pre-step` and `agent/request` waterfalls, and observes the
 * durable feed through `session/event`. It is deliberately NOT a tool (the
 * docs are explicit that deployment policy does not belong in a tool the
 * model must choose to call) and it modifies no part of the loop.
 *
 * ## Local-only mode
 *
 * Without `baseUrl`/`orgKey` nothing ever leaves the machine: the fuse
 * enforces the configured budgets and policies entirely offline, and the
 * local libsql store (`$DSH_HOME/dsh-fuse/local.db` by default) is
 * the spend source.
 */

export const name = "fuse";

import { Config as PluginConfig } from "./config.js";
import { apply as pluginApply } from "./harness.js";

export {
	assertUsableConfig,
	type BudgetConfig,
	Config,
	type DshPluginConfig,
	type PolicyConfig,
	resolveConfig,
} from "./config.js";
export {
	type FuseBudget,
	type FuseDecision,
	type FusePolicies,
	fuseDecision,
} from "./fuse.js";
export {
	type CallProjection,
	hashSessionId,
	type MessageProvenance,
	projectCall,
	type RequestHeaderView,
	type TokenUsageLike,
} from "./meter.js";
export {
	createPricingCache,
	DEFAULT_REGISTRY_URL,
	estimateCostUsd,
	fetchPricingTable,
	normalizeModelId,
	type PricingAliases,
	type PricingEntry,
	type PricingResolution,
	type PricingTable,
	type PricingVia,
	parseGatewayModelEntry,
	parseGatewayModels,
	parsePricingRegistry,
	pricingCandidates,
	resolvePricingEntry,
	type TokenCounts,
} from "./pricing.js";
export {
	type RouteDecision,
	type RouteReason,
	type RouterPolicies,
	routeDecision,
} from "./router.js";
export {
	createLocalStore,
	type LocalStore,
	type RemotePolicy,
	type StoredUsage,
	type UsageRecord,
} from "./store.js";
export {
	fetchPolicy,
	parseRemotePolicy,
	type SyncResult,
	type SyncTarget,
	syncBatch,
} from "./sync.js";
export type { BatchEvent, CutEvent, UsageEvent } from "./wire.js";

/**
 * The Cordis entry.
 *
 * The DEFAULT export is the object form `{ name, apply, Config }` because the
 * loader unwraps a module to `exports.default` before mounting it
 * (`Loader.unwrapExports`) and then reads `plugin.Config` to validate the row's
 * config. Exporting the bare `apply` function as default — the shape this
 * package originally shipped — leaves `Config` undefined, so the schema is
 * skipped, defaults are never applied, and `apply` receives partial config.
 * The object form is the documented shape that keeps both together.
 *
 * The named exports above/below serve programmatic mounting and tests.
 */
export const apply = pluginApply;
export { pluginApply as plugin };

export default {
	name,
	apply: pluginApply,
	Config: PluginConfig,
};

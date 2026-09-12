/**
 * The harness integration — the Cordis wiring that makes the pure modules
 * live against the DeepSeek Harness runtime.
 *
 * Types are the REAL `@deepseek-ai/*` packages (exact-rc devDeps): the
 * waterfall signatures, `PreStepDecision`, `LlmCallConfig` and `SessionEvent`
 * come from the installed declarations, never from local re-declarations.
 *
 * ## Wiring, and the dispatch contracts each one obeys
 *
 * - `session/event` → **meter**. This event is `@mode emit`: a synchronous,
 *   fire-and-forget broadcast ("returned promises and values are not awaited
 *   or collected") emitted post-commit. An `async` listener therefore leaves a
 *   floating promise that a one-shot headless run can exit before it lands.
 *   The handler is consequently SYNCHRONOUS and only enqueues; a single shared
 *   drain writes to libsql, and the plugin flushes it on `turn/end`,
 *   `session/disposed`, and its own disposal — the same non-blocking-enqueue +
 *   explicit-drain contract the harness's own telemetry seam documents for
 *   this exact hot path.
 * - `agent/pre-step` → **fuse**. `@mode waterfall`; returning
 *   `{ kind: 'reject' }` without calling `next()` short-circuits the step
 *   before any token is spent.
 * - `agent/request` → **router**. `@mode waterfall`; always calls `next()` and
 *   rewrites the returned config, never the messages.
 * - interval → **sync + policy pull**, registered through `ctx.effect()` so
 *   every resource Cordis does not manage itself is released on unload, hot
 *   reload, config edit, or loss of a required service.
 *
 * The plugin declares **no `inject`**: `ctx.logger` is framework surface, not
 * an injectable service, and `tokenMeter` / `llm` are optional — a hard
 * dependency on an optional service would leave the fiber PENDING forever,
 * silently enforcing nothing.
 */

import type { Context } from "@deepseek-ai/cordis";
import type {
	Agent,
	PreStepDecision,
	RequestErrorAction,
} from "@deepseek-ai/dsh-agent";
import type {
	LlmCallConfig,
	LlmRuntime,
	MessageId,
	UserMessage,
} from "@deepseek-ai/dsh-llm";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import type { ToolRuntime } from "@deepseek-ai/dsh-tools";
import {
	type BudgetStatus,
	createBudgetStatusTool,
	type ScopedBudgetStatus,
} from "./budget-tool.js";
import { assertUsableConfig, type DshPluginConfig } from "./config.js";
import { clearCredentials, loadCredentials } from "./credentials.js";
import { type FuseBudget, type FusePolicies, fuseDecision } from "./fuse.js";
import { hashSessionId, projectCall } from "./meter.js";
import {
	createPricingCache,
	estimateCostUsd,
	fetchPricingTable,
	type PricingTable,
	type TokenCounts,
} from "./pricing.js";
import { routeDecision } from "./router.js";
import { createLocalStore, type RemotePolicy } from "./store.js";
import { fetchPolicy, syncBatch } from "./sync.js";
import type { BatchEvent } from "./wire.js";

/**
 * The harness token meter, reached structurally through `ctx.get('tokenMeter')`.
 * It is a separate package (`dsh-token-meter`) that a composition may not
 * mount, so the plugin probes for it instead of depending on it. The shape
 * used here is the documented `measure(session)` snapshot; `surfaceTokens` is
 * the surface-only route-priced total (the docs are explicit that
 * `totalTokens` is request-and-response pressure).
 */
interface OptionalTokenMeter {
	measure(session: Session): {
		totalTokens: number;
		surfaceTokens: number;
		deltaTokens: number;
	};
}

/** Fixed-density fallback estimate (chars/4) when no token meter is mounted. */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/** Estimated response size used to price a step before it runs. */
const DEFAULT_OUTPUT_TOKENS = 512;

function windowStart(now: Date, window: "month" | "day"): string {
	const start = new Date(now);
	if (window === "month") start.setUTCDate(1);
	start.setUTCHours(0, 0, 0, 0);
	return start.toISOString();
}

/** Window reset fallback when a 429 arrives without a reset_at. */
function windowReset(now: Date, window: "month" | "day"): string {
	const reset = new Date(now);
	if (window === "month") reset.setUTCMonth(reset.getUTCMonth() + 1, 1);
	else reset.setUTCDate(reset.getUTCDate() + 1);
	reset.setUTCHours(0, 0, 0, 0);
	return reset.toISOString();
}

/** Payload view of the session firehose's per-session latest request header. */
interface LatestHeader {
	provider: string;
	model: string;
	reasoningEffort?: string;
}

/** One metered call waiting to be persisted. */
interface QueuedWrite {
	/**
	 * The session's hashed identity, carried as the PROMISE rather than its
	 * value: hashing is async, the enqueue must stay synchronous, and a drain
	 * that fired first would otherwise persist an empty session id.
	 */
	sessionHash: Promise<string>;
	at: string;
	model: string;
	provider: string;
	reasoningEffort: string;
	counts: Required<TokenCounts>;
	costUsd: number;
	unpriced: boolean;
	/** Client-generated stable id — the SaaS dedupes on (org, event_id). */
	eventId: string;
	/** Tool names this step called (metrics only — never arguments). */
	tools: string[];
	durationMs: number | null;
}

/**
 * The plugin entry points.
 *
 * Exported as NAMED functions (the shape the harness's own tutorials use) and
 * re-assembled into the object form by `index.ts`, which is what the loader
 * needs: it unwraps a module to `exports.default` when one exists
 * (`Loader.unwrapExports`) and then reads `plugin.Config` to validate the row's
 * config. A bare-function default export therefore arrives with `Config`
 * undefined — the schema is skipped, defaults are never applied, and `apply`
 * receives partial config. That failure is silent at the type level and only
 * shows up against a real profile, which is why the smoke test boots one.
 */
export function apply(ctx: Context, config: DshPluginConfig): void {
	// Refuse configuration the plugin cannot act on (see config.ts) — Cordis
	// turns the throw into a FAILED fiber, which is the documented outcome.
	assertUsableConfig(config);

	const store = createLocalStore(config.storeUrl);
	const project = config.project;
	const dev = config.dev;

	/** Per-session latest request header (model/provider/reasoning effort). */
	const headers = new Map<string, LatestHeader>();
	/** Per `sessionId:turn:step` step-open time, for the latency measure. */
	const stepStarts = new Map<string, number>();
	/** Tool NAMES per step (metrics only — never arguments). */
	const stepTools = new Map<string, string[]>();
	/** Session id → sha256, computed once per session. */
	const sessionHashes = new Map<string, Promise<string>>();
	/** Models already reported as unpriced — one warning each, not per call. */
	const unpricedReported = new Set<string>();
	/** Routes whose reasoning set could not be resolved — warned once. */
	const unrankableReported = new Set<string>();
	/** Reasoning-effort ids per route, resolved from the harness lazily. */
	const routeEfforts = new Map<string, readonly string[]>();

	const logger = ctx.logger;
	const tokenMeter = (): OptionalTokenMeter | undefined =>
		(ctx.get?.("tokenMeter") as OptionalTokenMeter | undefined) ?? undefined;
	const llm = (): LlmRuntime | undefined =>
		(ctx.get?.("llm") as LlmRuntime | undefined) ?? undefined;

	/**
	 * In-session cut notices: when the fuse blocks a step, the harness ends the
	 * turn as `{ kind: "blocked" }` with no visible explanation — the user is
	 * told nothing. The harness's convention for "something just happened" is a
	 * plugin-producer `notice`-form user message on the SESSION LOG (the same
	 * `session.append("user/message", …, { surfaceOp: "append" })` the agent
	 * loop itself uses at every message boundary), which the client
	 * conversation renders as a collapsed one-line row expandable to the full
	 * text. One notice per (rule, window) per process: a budget that stays
	 * tripped must not restate itself on every blocked step, and a new window
	 * that re-trips it should announce that again.
	 *
	 * NOT `agent.inject`: that writes into the model's inbox (context for the
	 * NEXT step — invisible to the GUI), it never touches the session log. A
	 * turn that ends blocked has no next step, so an injected notice would sit
	 * in the inbox forever, never rendered. This bug is why the 0.1.1 cut
	 * alerts were silent in the panel.
	 */
	const cutNotices = new Set<string>();
	/** Set when a bearer 401 revokes the device token mid-sync; the next step
	 * announces it to the session once (the timer has no agent to address). */
	let revocationNoticePending = false;
	/**
	 * Append a plugin-producer `notice`-form user message to the session log —
	 * the GUI renders it as a collapsed row. Shared by the fuse cut notice and
	 * the revocation announcement.
	 */
	function appendSessionNotice(
		agent: Agent,
		input: { summary: string; detail: string },
	): void {
		try {
			agent.session.append(
				"user/message",
				{
					id: crypto.randomUUID() as MessageId,
					role: "user",
					content: [{ type: "text", text: input.detail }],
					source: {
						kind: "plugin",
						plugin: "@openplan/dsh-fuse",
						form: "notice",
						summary: input.summary,
					},
				} as UserMessage,
				{ surfaceOp: "append" },
			);
		} catch (error) {
			// A notice must never break the reject/sync path — the underlying
			// event (cut or revocation) already landed; the UI alert is
			// best-effort.
			logger.warn("[dsh] session notice not delivered", {
				summary: input.summary,
				error: String(error),
			});
		}
	}

	function notifyCut(
		agent: Agent,
		input: { rule: string; summary: string; detail: string },
	): void {
		const window = windowStart(new Date(), "day");
		const key = `${input.rule}\u0000${window}`;
		if (cutNotices.has(key)) return;
		cutNotices.add(key);
		appendSessionNotice(agent, input);
	}

	/**
	 * Documented load-time rule: *"A plugin should also reject schema-valid
	 * config that names an unavailable resource or provider as soon as it can
	 * resolve that reference."*
	 *
	 * Enforced for what this plugin can actually know: when the `llm` service
	 * IS mounted, any provider prefix named by `cascade` / `allowedModels` must
	 * be a registered route. A model id is NOT rejected for being absent from a
	 * catalog — the docs are explicit that catalog membership is advisory.
	 *
	 * Runs only when `llm` is present: a hard `inject` on an optional service
	 * would leave the fiber PENDING forever, silently enforcing nothing.
	 */
	function assertProvidersResolvable(): void {
		const runtime = llm();
		if (!runtime) return;
		let registered: readonly { id: string }[];
		try {
			registered = runtime.listProviders();
		} catch {
			return; // topology unavailable — nothing to verify against
		}
		const known = new Set(registered.map((provider) => provider.id));
		if (known.size === 0) return;
		const named = [...config.cascade, ...config.policies.allowedModels];
		const missing = new Set<string>();
		for (const model of named) {
			const prefix = model.split("/")[0];
			// Only provider-prefixed ids name a route; a bare id does not.
			if (!prefix || prefix === model) continue;
			if (!known.has(prefix)) missing.add(prefix);
		}
		if (missing.size > 0) {
			throw new Error(
				`configuration names provider(s) with no registered route: ${[...missing].join(", ")}. Registered providers: ${[...known].join(", ")}.`,
			);
		}
	}
	assertProvidersResolvable();

	// ── Pricing: config table + optional registry/gateway sync ─────────────
	// Seeded from whatever the last successful fetch persisted, so enforcement
	// is offline-capable from the first boot; the live fetch upgrades it and
	// repersists. The generic resolver keys by `provider/model` first, then by
	// the modal price across every provider that publishes the model.
	const pricingCache = createPricingCache(
		() =>
			fetchPricingTable({
				registryUrl: config.pricingRegistryUrl,
				gatewayUrl: config.pricingGatewayUrl || undefined,
				gatewayProvider: config.pricingGatewayProvider || undefined,
				gatewayApiKeyEnv: config.pricingGatewayApiKeyEnv || undefined,
				override: config.pricingTable,
			}),
		3_600_000,
		// A refresh can resolve AFTER unload (slow network, test teardown):
		// persisting a table into a closed store must be a swallowed no-op,
		// never an unhandled rejection.
		(table) => void store.setPricingTable(table).catch(() => undefined),
	);
	void store.pricingTable().then((persisted) => {
		if (persisted) pricingCache.hydrate(persisted as PricingTable);
		if (config.pricingRegistryUrl || config.pricingGatewayUrl) {
			pricingCache.refresh();
		}
	});
	const pricingTableNow = (): PricingTable => ({
		...pricingCache.current(),
		...config.pricingTable,
	});

	/**
	 * Price one call. An unresolvable model is reported once per model and
	 * prices at zero for the row (tokens are still real and still stored) —
	 * never silently: an unpriced call is flagged on the wire and, when the
	 * deployment set one, covered by the single org fallback rate.
	 */
	function priceFor(
		model: string,
		provider: string,
		counts: TokenCounts,
	): { costUsd: number; unpriced: boolean } {
		const priced = estimateCostUsd(pricingTableNow(), model, counts, {
			provider,
			aliases: config.pricingAliases,
		});
		if (priced) return { costUsd: priced.costUsd, unpriced: false };
		if (model && !unpricedReported.has(model)) {
			unpricedReported.add(model);
			logger.warn(
				`[dsh] no price for model "%s" on route "%s" — call metered but priced at zero (unpriced); set pricingAliases/pricingTable or an unpricedFallback`,
				model,
				provider,
			);
		}
		if (
			config.unpricedFallback &&
			typeof config.unpricedFallback.inputCentsPerM === "number" &&
			typeof config.unpricedFallback.outputCentsPerM === "number"
		) {
			const fb = config.unpricedFallback;
			const cents =
				counts.inputTokens * fb.inputCentsPerM +
				counts.outputTokens * fb.outputCentsPerM +
				counts.cacheReadTokens * (fb.cacheReadCentsPerM ?? fb.inputCentsPerM) +
				(counts.cacheWriteTokens ?? 0) *
					(fb.cacheWriteCentsPerM ?? fb.inputCentsPerM);
			return { costUsd: cents / 1e6 / 100, unpriced: true };
		}
		return { costUsd: 0, unpriced: true };
	}

	// ── Meter: enqueue synchronously, drain off the hot path ───────────────
	let queue: QueuedWrite[] = [];
	let draining: Promise<void> | null = null;

	async function drainLoop(): Promise<void> {
		while (queue.length > 0) {
			const batch = queue;
			queue = [];
			for (const row of batch) {
				try {
					await store.record({
						sessionId: await row.sessionHash,
						project,
						costUsd: row.costUsd,
						at: row.at,
						model: row.model,
						provider: row.provider,
						reasoningEffort: row.reasoningEffort,
						inputTokens: row.counts.inputTokens,
						outputTokens: row.counts.outputTokens,
						cacheReadTokens: row.counts.cacheReadTokens,
						cacheWriteTokens: row.counts.cacheWriteTokens,
						durationMs: row.durationMs,
						unpriced: row.unpriced,
						eventId: row.eventId,
						tools: row.tools,
					});
				} catch (err) {
					logger.warn("[dsh] meter write failed", { err: String(err) });
				}
			}
		}
	}

	function scheduleDrain(): void {
		if (draining) return;
		draining = drainLoop().finally(() => {
			draining = null;
		});
	}

	/** Settle once every enqueued row has been handed to the store. */
	async function flushMeter(): Promise<void> {
		for (;;) {
			if (!draining && queue.length > 0) scheduleDrain();
			if (!draining) return;
			await draining;
		}
	}

	function sessionHash(sessionId: string): Promise<string> {
		let cached = sessionHashes.get(sessionId);
		if (!cached) {
			cached = hashSessionId(sessionId);
			sessionHashes.set(sessionId, cached);
		}
		return cached;
	}

	// ── Firehose ───────────────────────────────────────────────────────────
	ctx.on("session/event", (session: Session, event: SessionEvent): void => {
		const sessionId = session.id;
		switch (event.type) {
			case "step/start": {
				stepStarts.set(
					`${sessionId}:${event.data.turn}:${event.data.step}`,
					event.time,
				);
				stepTools.set(`${sessionId}:${event.data.turn}:${event.data.step}`, []);
				return;
			}
			case "tool/call": {
				// Metrics only: the tool NAME, never the arguments.
				const key = `${sessionId}:${event.data.turn}:${event.data.step}`;
				const tools = stepTools.get(key);
				if (tools && !tools.includes(event.data.name))
					tools.push(event.data.name);
				return;
			}
			case "request/header": {
				const call = event.data.header.config;
				headers.set(sessionId, {
					provider: call.provider,
					model: call.model,
					reasoningEffort: call.reasoningEffort,
				});
				return;
			}
			case "assistant/message": {
				if (!event.data.usage) return;
				// A request succeeded — the next request of this turn is a fresh
				// attempt, not a retry, so the escalation counter clears.
				retryCounts.delete(retryKey(sessionId, event.data.turn));
				const header = headers.get(sessionId);
				// `AssistantMessage.source` IS `ModelMessageSource` (the harness
				// types an assistant message's provenance directly), so the model
				// and provider that served this call need no lookup and no cast.
				const source = event.data.message.source;
				const stepKey = `${sessionId}:${event.data.turn}:${event.data.step}`;
				// Tool names observed during this step — consumed here, then
				// dropped so a long session's map cannot grow unbounded.
				const tools = stepTools.get(stepKey) ?? [];
				stepTools.delete(stepKey);
				const projection = projectCall({
					provenance: { provider: source.provider, model: source.model },
					header,
					usage: event.data.usage,
					settledAt: event.time,
					stepStartedAt: stepStarts.get(stepKey),
				});
				stepStarts.delete(stepKey);
				const priced = priceFor(
					projection.model,
					projection.provider,
					projection.counts,
				);
				queue.push({
					sessionHash: sessionHash(sessionId),
					at: new Date(event.time).toISOString(),
					model: projection.model,
					provider: projection.provider,
					reasoningEffort: projection.reasoningEffort,
					counts: projection.counts,
					costUsd: priced.costUsd,
					unpriced: priced.unpriced,
					eventId: crypto.randomUUID(),
					tools,
					durationMs: projection.durationMs,
				});
				scheduleDrain();
				logger.info("[dsh] metered", {
					model: projection.model,
					costUsd: priced.costUsd,
					unpriced: priced.unpriced,
				});
				return;
			}
			case "turn/end": {
				for (const key of stepStarts.keys()) {
					if (key.startsWith(`${sessionId}:`)) stepStarts.delete(key);
				}
				for (const key of retryCounts.keys()) {
					if (key.startsWith(`${sessionId}\u0000`)) retryCounts.delete(key);
				}
				void flushMeter();
				return;
			}
			default:
				return;
		}
	});

	ctx.on("session/disposed", (session: Session): void => {
		headers.delete(session.id);
		sessionHashes.delete(session.id);
		void flushMeter();
	});

	// ── Policy: the panel publishes it, the local fuse enforces it ─────────
	/**
	 * Budgets/policies in force for this call. The SaaS-published policy wins
	 * per field when present (the panel is the control plane); the deployment's
	 * `cordis.yml` values are the offline fallback, so enforcement never
	 * depends on the network being reachable at boot.
	 */
	async function effectivePolicy(): Promise<{
		budgets: FuseBudget[];
		policies: FusePolicies;
	}> {
		const remote: RemotePolicy | null = await store.remotePolicy();
		const now = new Date();
		const limits = remote?.budgets?.length ? remote.budgets : config.budgets;

		/**
		 * Which budgets govern THIS call. A published budget applies only to
		 * the calls in its scope, never globally:
		 * - `org`     → every call on this machine; spend is this machine's total.
		 * - `project` → only calls whose project label matches `reference`; spend
		 *   is this project's.
		 * - `dev`     → only calls whose dev matches `reference`; spend is this
		 *   dev's.
		 * A local `config.budgets` entry has no scope and applies to this
		 * project on this machine (the offline fallback's meaning).
		 */
		const budgets: FuseBudget[] = [];
		for (const budget of limits) {
			const scope = (budget as { scope?: string }).scope;
			if (scope === "project") {
				const reference = (budget as { reference?: string }).reference;
				// Absent reference = legacy publication: apply to this project.
				if (reference !== undefined && reference !== project) continue;
			}
			if (scope === "dev") {
				const reference = (budget as { reference?: string }).reference;
				if (reference !== undefined && reference !== dev) continue;
			}
			const spentUsd =
				scope === "project"
					? await store.spentForWindow({
							project,
							since: windowStart(now, budget.window),
						})
					: scope === "dev"
						? await store.spentForWindow({
								dev,
								since: windowStart(now, budget.window),
							})
						: await store.spentForWindow({
								since: windowStart(now, budget.window),
							});
			budgets.push({
				limitUsd: budget.limitUsd,
				window: budget.window,
				spentUsd,
			});
		}
		return {
			budgets,
			// The SaaS-published value wins per field when it is present; the
			// config's empty encodings ("no cap", "all allowed", "none denied")
			// translate back to absent so the fuse treats them as unrestricted.
			policies: {
				maxReasoningEffort:
					remote?.maxReasoningEffort ||
					config.policies.maxReasoningEffort ||
					undefined,
				allowedModels: remote?.allowedModels?.length
					? remote.allowedModels
					: config.policies.allowedModels.length > 0
						? config.policies.allowedModels
						: undefined,
				denylistedProjects: remote?.denylistedProjects?.length
					? remote.denylistedProjects
					: config.policies.denylistedProjects.length > 0
						? config.policies.denylistedProjects
						: undefined,
			},
		};
	}

	// ── Model-facing status: the documented "separate model-facing ask tool" ─
	/**
	 * The model-facing view of the policy state — same scope filtering as
	 * `effectivePolicy`, so the numbers the agent reads are exactly the numbers
	 * the fuse enforces. A local `config.budgets` entry (no scope) is the
	 * offline fallback and reads as an org-level budget on this machine.
	 */
	async function readBudgetStatus(): Promise<BudgetStatus> {
		const now = new Date();
		const remote: RemotePolicy | null = await store.remotePolicy();
		const limits = remote?.budgets?.length ? remote.budgets : config.budgets;
		const budgets: ScopedBudgetStatus[] = [];
		for (const budget of limits) {
			const scope =
				(budget as { scope?: "org" | "project" | "dev" }).scope ?? "org";
			const reference = (budget as { reference?: string }).reference;
			if (
				scope === "project" &&
				reference !== undefined &&
				reference !== project
			)
				continue;
			if (scope === "dev" && reference !== undefined && reference !== dev)
				continue;
			const spentUsd =
				scope === "project"
					? await store.spentForWindow({
							project,
							since: windowStart(now, budget.window),
						})
					: scope === "dev"
						? await store.spentForWindow({
								dev,
								since: windowStart(now, budget.window),
							})
						: await store.spentForWindow({
								since: windowStart(now, budget.window),
							});
			budgets.push({
				scope,
				...(reference !== undefined ? { reference } : {}),
				window: budget.window,
				limitUsd: budget.limitUsd,
				spentUsd,
			});
		}
		const block = await store.remoteBlockFor({ project, dev });
		return {
			project,
			dev,
			at: now.toISOString(),
			budgets,
			block,
		};
	}

	/**
	 * Register `dsh_budget_status` for the agent when the composition mounts
	 * the `tools` service (`@deepseek-ai/dsh-tools`). Registration is optional
	 * by design — the plugin declares no `inject`, so an absent service skips
	 * the surface instead of holding the fiber PENDING. Status-only: the tool
	 * reads state and never decides.
	 */
	const toolsRuntime = ctx.get?.("tools") as ToolRuntime | undefined;
	if (config.budgetStatusTool && toolsRuntime) {
		ctx.effect(() =>
			toolsRuntime.register(createBudgetStatusTool(readBudgetStatus)),
		);
	}

	/**
	 * The route's ordered reasoning-effort ids, from the harness itself: the
	 * cap is ranked by index in the ADAPTER's own set, never by a local table.
	 * Cached per route; `undefined` when no llm service or no metadata, which
	 * the fuse reports as "not enforced" instead of guessing.
	 */
	async function reasoningEffortsFor(
		provider: string,
		model: string,
	): Promise<readonly string[] | undefined> {
		const runtime = llm();
		if (!runtime || !provider || !model) return undefined;
		const key = `${provider}\u0000${model}`;
		const cached = routeEfforts.get(key);
		if (cached) return cached;
		try {
			const info = await runtime.resolveModelInfo(provider, model);
			const ids = (info.reasoning?.efforts ?? []).map((effort) =>
				String(effort.id),
			);
			if (ids.length > 0) {
				routeEfforts.set(key, ids);
				return ids;
			}
		} catch {
			// The route publishes no reasoning metadata — reported below.
		}
		return undefined;
	}

	// ── Fuse: the primary gate, before any token is spent ──────────────────
	ctx.on(
		"agent/pre-step",
		async (
			payload: {
				agent: Agent;
				messages: unknown[];
				turn: number;
				step: number;
			},
			next: () => Promise<PreStepDecision>,
		): Promise<PreStepDecision> => {
			// One-time revocation announcement: a device-token 401 during sync
			// disconnected the SaaS; tell the user on the next step they run.
			if (revocationNoticePending) {
				revocationNoticePending = false;
				appendSessionNotice(payload.agent, {
					summary: "fuse: conexão com o painel revogada",
					detail:
						"O token do dispositivo foi revogado no painel — este profile voltou a local-only (nada sincroniza, o fuse continua ativo). Reconecte com `dsh plugin --profile <perfil> exec dsh-fuse-connect` quando quiser. As linhas não sincronizadas ficaram retidas.",
				});
			}

			const agentId = payload.agent.id;
			const header = headers.get(agentId);
			const model =
				header?.model ||
				(payload.agent.options as { model?: string } | undefined)?.model ||
				"";
			const provider =
				header?.provider ||
				(payload.agent.options as { provider?: string } | undefined)
					?.provider ||
				"";

			// Sync fidelity: a SaaS 429 engages the offline fuse until the
			// window resets — the team blocked centrally is blocked locally.
			// Blocks are scoped: a project budget 429 freezes only that
			// project on this machine (org blocks freeze everything).
			const remoteBlock = await store.remoteBlockFor({ project, dev });
			if (remoteBlock) {
				logger.warn("[dsh] fuse blocked (remote 429 active)", {
					rule: remoteBlock.rule,
					resetAt: remoteBlock.resetAt,
					project,
				});
				notifyCut(payload.agent, {
					rule: remoteBlock.rule,
					summary: "fuse: chamadas bloqueadas (orçamento do painel)",
					detail: `O painel central cortou as chamadas deste escopo (regra: ${remoteBlock.rule}). O bloqueio vale até ${remoteBlock.resetAt} — o fuse local segue ativo e nenhum token é gasto enquanto isso.`,
				});
				return { kind: "reject" };
			}

			const estimatedCostUsd = estimateStepCostUsd(
				payload.agent,
				payload.messages,
				model,
				provider,
			);
			const { budgets, policies } = await effectivePolicy();
			const efforts = policies.maxReasoningEffort
				? await reasoningEffortsFor(provider, model)
				: undefined;
			const decision = fuseDecision({
				project,
				model,
				reasoningEffort: header?.reasoningEffort,
				estimatedCostUsd,
				budgets,
				policies,
				now: new Date(),
				reasoningEfforts: efforts,
			});

			for (const gap of decision.notEnforced) {
				const key = `${gap}\u0000${provider}/${model}`;
				if (unrankableReported.has(key)) continue;
				unrankableReported.add(key);
				logger.warn(
					"[dsh] policy not enforceable on this route (%s): the adapter publishes no matching reasoning-effort id, so the cap was not applied",
					gap,
				);
			}
			if (!decision.allowed) {
				await store.recordCut({
					project,
					rule: decision.rule ?? "unknown",
				});
				logger.warn("[dsh] fuse blocked", {
					rule: decision.rule,
					project,
				});
				notifyCut(payload.agent, {
					rule: decision.rule ?? "unknown",
					summary: "fuse: chamada cortada — orçamento atingido",
					detail: `O fuse bloqueou a chamada antes de gastar tokens (regra: ${decision.rule ?? "unknown"}). Ajuste o budget em cordis.patch.yml ou use a ferramenta dsh_budget_status para ver o status; o limite reseta no fim da janela.`,
				});
				return { kind: "reject" };
			}
			return next();
		},
	);

	/**
	 * Price the step before it runs. Prefers the harness's own replay-aware
	 * token meter (`ctx.tokenMeter.measure`, the documented request-pressure
	 * snapshot) and falls back to the fixed chars/4 heuristic only when no
	 * meter is mounted, so the estimate does not drift from the harness's own
	 * accounting on a full composition.
	 *
	 * Uses the meter's `surfaceTokens` — the surface-only route-priced total —
	 * as the input estimate, never `totalTokens`, because the docs define
	 * `totalTokens` as *request-and-response* pressure; adding
	 * `DEFAULT_OUTPUT_TOKENS` on top of it would count the response twice and
	 * manufacture false-positive cuts.
	 */
	function estimateStepCostUsd(
		agent: Agent,
		messages: unknown[],
		model: string,
		provider: string,
	): number {
		let inputTokens: number | null = null;
		const meter = tokenMeter();
		if (meter) {
			try {
				const measurement = meter.measure(agent.session);
				inputTokens = measurement.surfaceTokens;
			} catch {
				inputTokens = null;
			}
		}
		if (inputTokens === null) {
			inputTokens = estimateTokens(
				messages.map((message) => JSON.stringify(message)).join("\n"),
			);
		}
		return priceFor(model, provider, {
			inputTokens,
			outputTokens: DEFAULT_OUTPUT_TOKENS,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		}).costUsd;
	}

	// ── Router: policy-compliant model rewrite ─────────────────────────────
	/**
	 * Escalation counter per (agent, turn): bumped on `agent/request-error`
	 * (the documented "you own recovery" seam) and cleared when a request
	 * succeeds. `payload.step` is NOT an attempt count — it increments once per
	 * step of a normal tool-using turn, so using it would walk the cascade to
	 * the most expensive model on a routine 5-step turn (the visible quality
	 * degradation the proposal rules out). Escalation therefore only happens
	 * when the immediately previous request of this turn actually failed.
	 */
	const retryCounts = new Map<string, number>();
	const retryKey = (agentId: string, turn: number): string =>
		`${agentId}\u0000${turn}`;

	ctx.on(
		"agent/request-error",
		async (
			payload: { agent: Agent; turn: number },
			next: () => Promise<RequestErrorAction>,
		): Promise<RequestErrorAction> => {
			// Observe + delegate: the plugin never owns provider retries.
			const key = retryKey(payload.agent.id, payload.turn);
			retryCounts.set(key, (retryCounts.get(key) ?? 0) + 1);
			return next();
		},
	);

	ctx.on(
		"agent/request",
		async (
			payload: { agent: Agent; turn: number; step: number },
			next: () => Promise<LlmCallConfig>,
		): Promise<LlmCallConfig> => {
			const current = await next();
			const attempt =
				retryCounts.get(retryKey(payload.agent.id, payload.turn)) ?? 0;
			const routed = routeDecision({
				requestedModel: current.model,
				attempt,
				cascade: config.cascade,
				policies: config.policies,
			});
			if (routed.model !== current.model) {
				logger.info("[dsh] routed", {
					from: current.model,
					to: routed.model,
					reason: routed.reason,
					attempt,
				});
				return { ...current, model: routed.model };
			}
			return current;
		},
	);

	// ── SaaS sync + policy pull, released by ctx.effect on unload ──────────
	// Target resolution (ADR-0020): the device token from `dsh plugin connect`
	// (credentials file) wins — it is the human-attached identity; the
	// configured orgKey/baseUrl pair stays the headless/CI path. Local-only
	// mode (neither) still owns the store.
	const resolvedTarget = (() => {
		const connected = loadCredentials();
		if (connected) {
			return {
				baseUrl: connected.baseUrl,
				auth: { kind: "bearer" as const, token: connected.token },
			};
		}
		if (config.baseUrl && config.orgKey) {
			return {
				baseUrl: config.baseUrl,
				auth: { kind: "key" as const, orgKey: config.orgKey },
			};
		}
		return null;
	})();

	ctx.effect(() => {
		if (!resolvedTarget) return () => undefined;
		const target = resolvedTarget;
		let syncing = false;
		let refreshing = false;
		let lastPolicyAt = 0;

		async function syncOnce(): Promise<void> {
			if (syncing) return;
			syncing = true;
			try {
				await flushMeter();
				const pending = await store.pendingSync(500);
				const pendingCuts = await store.pendingCuts(100);
				if (pending.length === 0 && pendingCuts.length === 0) return;
				const events: BatchEvent[] = [
					...pending.map((row) => ({
						v: 1 as const,
						event_id: row.eventId,
						session_id: row.sessionId,
						project: row.project,
						dev,
						provider: row.provider || "unknown",
						model: row.model || "unknown",
						reasoning_effort: row.reasoningEffort || undefined,
						input_tokens: row.inputTokens,
						output_tokens: row.outputTokens,
						cache_read_tokens: row.cacheReadTokens,
						cache_write_tokens: row.cacheWriteTokens,
						duration_ms: row.durationMs ?? undefined,
						cost_usd: row.costUsd,
						...(row.unpriced ? { unpriced: true } : {}),
						started_at: row.at,
						...(row.tools.length > 0 ? { tools: row.tools } : {}),
					})),
					...pendingCuts.map((cut) => ({
						kind: "cut" as const,
						project: cut.project,
						rule: cut.rule,
					})),
				];
				const result = await syncBatch({ ...target, events });
				if (result.blocked) {
					logger.warn("[dsh] SaaS blocked — engaging the local fuse", {
						rule: result.blockedRule,
						resetAt: result.resetAt,
						scope: result.blockScope,
						reference: result.blockReference,
					});
					await store.setRemoteBlock({
						rule: result.blockedRule ?? "budget_exceeded",
						resetAt: result.resetAt ?? windowReset(new Date(), "day"),
						...(result.blockScope ? { scope: result.blockScope } : {}),
						...(result.blockReference
							? { reference: result.blockReference }
							: {}),
					});
					return;
				}
				if (!result.delivered) {
					// Keep the rows: a failed batch is not a delivered batch.
					// A 401 on the BEARER path means the device token was
					// revoked at the SaaS — drop the credentials and stop
					// advertising a connected machine (the fuse keeps running
					// local-only; rows are retained for a future reconnect).
					if (result.status === 401 && target.auth.kind === "bearer") {
						logger.warn(
							"[dsh] device token revoked — disconnecting local sync (rows retained)",
							{ status: result.status },
						);
						clearCredentials();
						// The sync timer has no agent to address; surface the
						// revocation on the NEXT step the user runs, once (the
						// visible counterpart to the fuse cut notice).
						revocationNoticePending = true;
						return;
					}
					logger.warn("[dsh] sync failed — rows retained for retry", {
						status: result.status,
						error: result.error,
					});
					return;
				}
				await store.markSynced(pending.map((row) => row.id));
				await store.markCutsSynced(pendingCuts.map((cut) => cut.id));
				await store.setRemoteBlock(null);
			} finally {
				syncing = false;
			}
		}

		async function refreshPolicyOnce(): Promise<void> {
			if (refreshing) return;
			refreshing = true;
			try {
				const { policy, error } = await fetchPolicy(target);
				if (error) {
					if (error !== "unauthorized") {
						logger.warn(
							"[dsh] policy refresh failed — keeping the last published policy",
							{
								error,
							},
						);
					}
					return;
				}
				await store.setRemotePolicy(policy);
				lastPolicyAt = Date.now();
			} finally {
				refreshing = false;
			}
		}

		// Pull the org policy immediately so a freshly started session enforces
		// panel state rather than whatever the YAML happens to say.
		void refreshPolicyOnce();

		const timer = setInterval(() => {
			void syncOnce().catch((err) => {
				logger.warn("[dsh] sync failed", { err: String(err) });
			});
			if (Date.now() - lastPolicyAt >= config.policyRefreshMs) {
				void refreshPolicyOnce().catch((err) => {
					logger.warn("[dsh] policy refresh failed", { err: String(err) });
				});
			}
		}, config.syncIntervalMs);

		return async () => {
			clearInterval(timer);
			await flushMeter();
			store.close();
		};
	});

	// Local-only mode still owns the store; release it on unload.
	if (!resolvedTarget) {
		ctx.effect(
			() => async () => {
				await flushMeter();
				store.close();
			},
			"dsh-meter-flush",
		);
	}
}

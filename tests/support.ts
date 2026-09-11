/**
 * Test support: mount the plugin on a REAL Cordis context and dispatch through
 * the real event modes.
 *
 * These tests deliberately do not hand-roll a context double. A real `Context`
 * gives them the actual fibre lifecycle, so `ctx.effect()` disposers, `Config`
 * validation, and the waterfall/emit dispatch contracts are exercised the way
 * the harness exercises them, not the way a stub assumes them.
 *
 * The doubles are the harness's own inputs only: `Session` and `Agent` are
 * classes with private constructors, so the tests supply the few members the
 * plugin reads. Every payload shape below is copied from a real durable record
 * verified against a live `session.jsonl` (`request/header`, `assistant/message`,
 * `step/start`, `turn/end`); the type assertions that adapt those literals to
 * the harness declarations live here, in one place, rather than being spread
 * across the suites.
 */

import { Context } from "@deepseek-ai/cordis";
import type { Agent, PreStepDecision } from "@deepseek-ai/dsh-agent";
import type { LlmCallConfig } from "@deepseek-ai/dsh-llm";
import type {
	Session,
	SessionEvent,
	UserMessage,
} from "@deepseek-ai/dsh-session";
import { Config, type DshPluginConfig } from "../src/config.js";
import { apply } from "../src/harness.js";

/**
 * Raw plugin config, exactly as a `cordis.yml` entry supplies it: every field
 * optional, defaults supplied by the schema. Mirrors what a user writes.
 *
 * A `type` (not an `interface`) on purpose: TS gives object type aliases an
 * implicit index signature, which is what makes this assignable to the
 * `Record<string, unknown>` that {@link resolveConfig} accepts — no cast.
 */
export type RawPluginConfig = {
	storeUrl?: string;
	project?: string;
	dev?: string;
	budgets?: { limitUsd: number; window?: "month" | "day" }[];
	policies?: {
		maxReasoningEffort?: string;
		allowedModels?: string[];
		denylistedProjects?: string[];
	};
	cascade?: string[];
	baseUrl?: string;
	orgKey?: string;
	syncIntervalMs?: number;
	policyRefreshMs?: number;
	budgetStatusTool?: boolean;
	pricingTable?: Record<
		string,
		{
			inputCentsPerM: number;
			outputCentsPerM: number;
			cacheReadCentsPerM?: number;
			cacheWriteCentsPerM?: number;
		}
	>;
	pricingAliases?: Record<string, string>;
	pricingRegistryUrl?: string;
	pricingGatewayUrl?: string;
	pricingGatewayProvider?: string;
	pricingGatewayApiKeyEnv?: string;
	unpricedFallback?: {
		inputCentsPerM: number;
		outputCentsPerM: number;
		cacheReadCentsPerM?: number;
		cacheWriteCentsPerM?: number;
	};
};

export interface MountedPlugin {
	ctx: Context;
	dispose: () => Promise<void>;
}

/** Mount the plugin with schema defaults applied, as the loader does. */
export async function mountPlugin(
	config: RawPluginConfig = {},
): Promise<MountedPlugin> {
	// Cordis validates this against the plugin's exported schema and fills the
	// defaults; a `cordis.yml` row arrives in exactly this partial shape. The
	// cast states the boundary (untrusted, partially-populated input) rather
	// than asserting the resolved type.
	const raw = config as Partial<DshPluginConfig>;
	const ctx = new Context();
	// Mount with RAW config and let Cordis validate it through the exported
	// schema — exactly what the loader does for a `cordis.yml` row. Resolving
	// the config here instead would hide the very failure the smoke profile
	// caught: a plugin shape where the loader cannot find `Config`.
	const fiber = ctx.plugin({ name: "fuse", apply, Config }, raw);
	await fiber;
	return {
		ctx,
		dispose: async () => {
			await fiber.dispose();
		},
	};
}

/** A minimal session handle — only `.id` is read by the plugin. */
export function fakeSession(id: string): Session {
	return { id } as unknown as Session;
}

/** A minimal agent handle — the plugin reads `id`, `options` and `session`.
 * `inject` is spy-shaped: it records each notice so tests can assert the
 * in-session cut alert without running a full conversation. */
export function fakeAgent(
	id: string,
	options: { provider?: string; model?: string } = {},
): Agent {
	return {
		id,
		options,
		session: fakeSession(id),
		inject: (message: UserMessage) => {
			const recorded = agentInjectSpies.get(id) ?? [];
			recorded.push(message);
			agentInjectSpies.set(id, recorded);
		},
	} as unknown as Agent;
}

/**
 * Notices injected into a fake agent, keyed by agent id. Cleared by
 * {@link clearAgentInjectSpies} between cases; the plugin's own in-process
 * dedup (one notice per rule per window) intentionally survives that clear,
 * so a second blocked step within the same test still produces one notice.
 */
export const agentInjectSpies = new Map<string, UserMessage[]>();

/** Reset the recorded injections (not the plugin's dedup keys). */
export function clearAgentInjectSpies(): void {
	agentInjectSpies.clear();
}

/** Drive the `agent/pre-step` waterfall through the real dispatcher. */
export async function preStep(
	ctx: Context,
	input: { agent: Agent; messages?: unknown[]; turn?: number; step?: number },
	next: () => Promise<PreStepDecision> = async () => ({
		kind: "enter",
		messages: [],
	}),
): Promise<PreStepDecision> {
	const payload = {
		agent: input.agent,
		messages: (input.messages ?? []) as unknown as UserMessage[],
		turn: input.turn ?? 0,
		step: input.step ?? 0,
		signal: new AbortController().signal,
	};
	return (await ctx.waterfall(
		"agent/pre-step",
		payload,
		next,
	)) as PreStepDecision;
}

/** Drive the `agent/request` waterfall through the real dispatcher. */
export async function requestRoute(
	ctx: Context,
	input: { agent: Agent; step?: number; config: LlmCallConfig },
): Promise<LlmCallConfig> {
	return (await ctx.waterfall(
		"agent/request",
		{
			agent: input.agent,
			turn: 0,
			step: input.step ?? 0,
			signal: new AbortController().signal,
		},
		async () => input.config,
	)) as LlmCallConfig;
}

/** Epoch ms used by every synthesized event, so durations are exact. */
export const T0 = 1_800_000_000_000;

export function requestHeaderEvent(input: {
	seq?: number;
	time?: number;
	provider: string;
	model: string;
	reasoningEffort?: string;
}): SessionEvent {
	return {
		type: "request/header",
		seq: input.seq ?? 0,
		time: input.time ?? T0,
		data: {
			header: {
				config: {
					provider: input.provider,
					model: input.model,
					...(input.reasoningEffort
						? { reasoningEffort: input.reasoningEffort }
						: {}),
				},
			},
			reason: "initial",
		},
	} as unknown as SessionEvent;
}

export function stepStartEvent(input: {
	turn?: number;
	step?: number;
	time?: number;
	seq?: number;
}): SessionEvent {
	return {
		type: "step/start",
		seq: input.seq ?? 1,
		time: input.time ?? T0,
		data: { turn: input.turn ?? 0, step: input.step ?? 0 },
	} as unknown as SessionEvent;
}

export function turnEndEvent(input: {
	turn?: number;
	time?: number;
	seq?: number;
}): SessionEvent {
	return {
		type: "turn/end",
		seq: input.seq ?? 9,
		time: input.time ?? T0,
		data: { turn: input.turn ?? 0, reason: "completed" },
	} as unknown as SessionEvent;
}

/** An `assistant/message` shaped exactly like the durable record. */
export function assistantMessageEvent(input: {
	provider: string;
	model: string;
	usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
	};
	time?: number;
	seq?: number;
	turn?: number;
	step?: number;
}): SessionEvent {
	return {
		type: "assistant/message",
		seq: input.seq ?? 2,
		time: input.time ?? T0,
		data: {
			turn: input.turn ?? 0,
			step: input.step ?? 0,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "ok" }],
				source: {
					kind: "model",
					provider: input.provider,
					model: input.model,
				},
			},
			usage: input.usage,
		},
	} as unknown as SessionEvent;
}

/**
 * Poll until `check` passes. The meter enqueues synchronously and drains off
 * the hot path (that is the design), so a test observes the store after the
 * drain rather than assuming the write is synchronous.
 */
export async function eventually<T>(
	check: () => Promise<T> | T,
	what: string,
	timeoutMs = 2000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

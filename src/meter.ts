/**
 * The meter — projects one completed model call from the durable session log
 * into the metrics the fuse prices and the SaaS stores.
 *
 * ## Sources, and why these ones
 *
 * - **Model and provider** come from the assistant message's own provenance.
 *   `assistant/message.message.source` is `AssistantProvenance {provider,
 *   model}`: "Model-produced assistant messages name the provider and model
 *   that produced them", and the loop "stores the assembled assistant content
 *   with the provider and model that produced it". This is per-call truth. A
 *   session-keyed cache of the latest `request/header` — the previous
 *   implementation — resolves to "unknown" on a resumed session or a missing
 *   header, and then prices the call at zero.
 * - **Reasoning effort** comes from the request header's `LlmCallConfig`,
 *   which is the only place the log records it. When the caller omitted an
 *   effort and the ADAPTER materialized its own default, the log records that
 *   a default was applied (`EpochHeader.adapterDefaults.reasoningEffort`) but
 *   not the value; the projection therefore reports the effort the log states
 *   and stays empty otherwise rather than guessing.
 * - **Tokens** are the harness's own disjoint counts (`TokenUsage`: uncached
 *   input, output, cache reads, cache writes).
 * - **Duration** is measured from the step's `step/start` to the assistant
 *   settlement, i.e. the model request's latency for that step. The durable
 *   `assistant/message.stream` is not persisted by this build (verified
 *   against real logs: `data` carries only `message/step/turn/usage`), so the
 *   step boundary is the honest available source. `null` when the step's start
 *   was not observed (a resumed session, or a delivery that began before the
 *   plugin loaded).
 */

import type { TokenCounts } from "./pricing.js";

/** The harness's per-call token accounting (`TokenUsage`). */
export interface TokenUsageLike {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
}

/** `AssistantProvenance` — the provider/model that produced one message. */
export interface MessageProvenance {
	provider?: string;
	model?: string;
}

/** The subset of `EpochHeader` the meter reads (never the system prompt). */
export interface RequestHeaderView {
	provider?: string;
	model?: string;
	reasoningEffort?: string;
}

export interface CallProjection {
	model: string;
	provider: string;
	reasoningEffort: string;
	counts: Required<TokenCounts>;
	durationMs: number | null;
}

/** sha256 — the session id never leaves the machine raw. */
export async function hashSessionId(sessionId: string): Promise<string> {
	const data = new TextEncoder().encode(sessionId);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/** Coerce one provider-reported count to a non-negative integer. */
function count(value: number | undefined): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		return 0;
	return Math.floor(value);
}

/**
 * Project one completed model call. Pure — no I/O, no clock: the caller
 * supplies the settlement time and (when observed) the step's start time.
 */
export function projectCall(input: {
	provenance?: MessageProvenance;
	header?: RequestHeaderView;
	usage: TokenUsageLike;
	/** Epoch ms of the assistant settlement. */
	settledAt: number;
	/** Epoch ms when this step opened, when observed. */
	stepStartedAt?: number;
}): CallProjection {
	// Provenance wins: it identifies the model that actually served the call.
	const model = input.provenance?.model ?? input.header?.model ?? "";
	const provider =
		input.provenance?.provider ??
		input.header?.provider ??
		(model.includes("/") ? model.split("/")[0] : "") ??
		"";
	const durationMs =
		typeof input.stepStartedAt === "number" &&
		Number.isFinite(input.stepStartedAt) &&
		input.settledAt >= input.stepStartedAt
			? Math.round(input.settledAt - input.stepStartedAt)
			: null;
	return {
		model,
		provider,
		reasoningEffort: input.header?.reasoningEffort ?? "",
		counts: {
			inputTokens: count(input.usage.inputTokens),
			outputTokens: count(input.usage.outputTokens),
			cacheReadTokens: count(input.usage.cacheReadTokens),
			cacheWriteTokens: count(input.usage.cacheWriteTokens),
		},
		durationMs,
	};
}

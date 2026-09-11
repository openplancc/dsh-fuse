/**
 * The plugin's outbound wire contract.
 *
 * These types are the plugin's OWN because the plugin is distributed
 * standalone (`dsh plugin add`, npm/tarball) and therefore cannot depend on a
 * workspace package that is never published. The SaaS declares the same pair
 * in `apps/dsh/shared` for its own routes; the two are the same wire format,
 * so a change here is a change there — the api's ingest route is the consumer
 * and validates every field it reads.
 *
 * Only metrics travel: model, provider, tokens, cost, timing and the HASHED
 * session identity. No prompt, message, tool argument or result ever crosses
 * this boundary.
 */

/** One model call, projected from the harness session log (metrics only). */
export interface UsageEvent {
	v: 1;
	/**
	 * Client-generated stable id for this exact call (UUID). The SaaS inserts
	 * idempotently on (organization_id, event_id), so re-sends after a crash
	 * or a 429 can never double-count spend, tokens or budgets.
	 */
	event_id: string;
	/**
	 * SHA-256 of the harness session id, computed on the client — the raw id
	 * never leaves the machine.
	 */
	session_id: string;
	project: string;
	dev: string;
	provider: string;
	model: string;
	reasoning_effort?: string;
	input_tokens: number;
	output_tokens: number;
	cache_read_tokens?: number;
	cache_write_tokens?: number;
	cost_usd: number;
	/** True when no price resolved for this call — visible, never silent. */
	unpriced?: boolean;
	started_at: string;
	duration_ms?: number;
	tools?: string[];
}

/** A fuse-cut report — the local enforcement the panel surfaces (proposal §3). */
export interface CutEvent {
	kind: "cut";
	project: string;
	rule: string;
}

/** Anything that rides a `POST /v1/usage/batch` payload. */
export type BatchEvent = UsageEvent | CutEvent;

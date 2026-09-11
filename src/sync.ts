/**
 * Batch sync to the SaaS — the secondary gate returns 429 when blocked, and
 * `GET /v1/policy` pulls the org's enforcement state the other way.
 *
 * ## A failed batch must never look like a delivered one
 *
 * The sync watermark (`markSynced`) is what stops a row from being re-sent, so
 * treating any non-429 response as success silently DESTROYS usage rows: a 500,
 * a 502 from the proxy, or a stray HTML error page would retire the rows
 * without the SaaS ever storing them. {@link SyncResult.delivered} therefore
 * states explicitly whether the events reached the SaaS, and the caller only
 * advances the watermark when it did.
 */

import type { RemotePolicy } from "./store.js";
import type { BatchEvent } from "./wire.js";

/** A fuse-cut report (proposal §3) — rides the same batch as usage rows. */
export type { CutEvent } from "./wire.js";

export interface SyncResult {
	accepted: number;
	status: number;
	blocked: boolean;
	blockedRule?: string;
	resetAt?: string;
	/**
	 * Which budget the 429 came from. An `org` block stops every call on this
	 * machine; a `project` block stops only the referenced project; a `dev`
	 * block only the referenced dev. Absent = treat as org-wide (legacy).
	 */
	blockScope?: "org" | "project" | "dev";
	blockReference?: string;
	/**
	 * True only when the SaaS acknowledged the batch (2xx with `ok`). A blocked
	 * (429) or failed batch is NOT delivered — the caller keeps the rows.
	 */
	delivered: boolean;
	/** Transport/HTTP failure detail for the log line, when any. */
	error?: string;
}

/** Shared request shape for the two key-authed endpoints. */
export interface OrgKeyTarget {
	baseUrl: string;
	orgKey: string;
	fetchImpl?: typeof fetch;
}

function keyHeaders(orgKey: string): Record<string, string> {
	return { "x-org-key": orgKey };
}

export async function syncBatch(
	input: OrgKeyTarget & { events: BatchEvent[] },
): Promise<SyncResult> {
	const fetchImpl = input.fetchImpl ?? fetch;
	let res: Response;
	try {
		res = await fetchImpl(`${input.baseUrl}/v1/usage/batch`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				...keyHeaders(input.orgKey),
			},
			body: JSON.stringify({ events: input.events }),
		});
	} catch (err) {
		return {
			accepted: 0,
			status: 0,
			blocked: false,
			delivered: false,
			error: String(err).slice(0, 200),
		};
	}
	const body = (await res.json().catch(() => ({}))) as {
		ok?: boolean;
		accepted?: number;
		error?: string;
		rule?: string;
		reset_at?: string;
		scope?: string;
		reference?: string;
	};
	if (res.status === 429) {
		const scope =
			body.scope === "org" || body.scope === "project" || body.scope === "dev"
				? body.scope
				: undefined;
		return {
			accepted: 0,
			status: 429,
			blocked: true,
			blockedRule: body.rule,
			resetAt: body.reset_at,
			...(scope ? { blockScope: scope } : {}),
			...(typeof body.reference === "string" && body.reference
				? { blockReference: body.reference }
				: {}),
			delivered: false,
		};
	}
	if (!res.ok) {
		return {
			accepted: 0,
			status: res.status,
			blocked: false,
			delivered: false,
			error: body.error ?? `status ${res.status}`,
		};
	}
	return {
		accepted: body.accepted ?? input.events.length,
		status: res.status,
		blocked: false,
		delivered: true,
	};
}

/**
 * Pull the org's enforcement state (`GET /v1/policy`, key-authed). This is
 * what makes the panel the control plane for the PRIMARY gate: without it the
 * local fuse can only enforce whatever the deployment wrote into
 * `cordis.yml`, and a budget edited in the panel would reach nothing but the
 * secondary 429.
 *
 * Returns `null` when the SaaS has nothing published, or when the request
 * failed — the caller keeps the last cached policy either way (offline-first:
 * enforcement never depends on the network being up at boot).
 */
export async function fetchPolicy(
	input: OrgKeyTarget,
): Promise<{ policy: RemotePolicy | null; error?: string }> {
	const fetchImpl = input.fetchImpl ?? fetch;
	try {
		const res = await fetchImpl(`${input.baseUrl}/v1/policy`, {
			method: "GET",
			headers: keyHeaders(input.orgKey),
		});
		if (res.status === 401) return { policy: null, error: "unauthorized" };
		if (!res.ok) return { policy: null, error: `status ${res.status}` };
		return { policy: parseRemotePolicy(await res.json()) };
	} catch (err) {
		return { policy: null, error: String(err).slice(0, 200) };
	}
}

/**
 * Validate the published shape before it reaches the fuse: a malformed policy
 * must degrade to "no published policy", never to a half-applied rule set
 * (an `allowedModels` that arrived as a string would otherwise deny every
 * model, and a `limitUsd` that arrived as a string would compare as NaN and
 * never cut).
 */
export function parseRemotePolicy(json: unknown): RemotePolicy | null {
	if (typeof json !== "object" || json === null) return null;
	const raw = json as Record<string, unknown>;
	const policy: RemotePolicy = {};
	if (Array.isArray(raw.budgets)) {
		const budgets: RemotePolicy["budgets"] = [];
		for (const entry of raw.budgets) {
			if (typeof entry !== "object" || entry === null) continue;
			const { limitUsd, window, scope, reference } = entry as Record<
				string,
				unknown
			>;
			const limit = Number(limitUsd);
			if (!Number.isFinite(limit) || limit <= 0) continue;
			if (window !== "month" && window !== "day") continue;
			const parsedScope =
				scope === "org" || scope === "project" || scope === "dev"
					? scope
					: undefined;
			budgets.push({
				limitUsd: limit,
				window,
				...(parsedScope ? { scope: parsedScope } : {}),
				...(typeof reference === "string" && reference ? { reference } : {}),
			});
		}
		if (budgets.length > 0) policy.budgets = budgets;
	}
	if (typeof raw.maxReasoningEffort === "string" && raw.maxReasoningEffort) {
		policy.maxReasoningEffort = raw.maxReasoningEffort;
	}
	if (Array.isArray(raw.allowedModels)) {
		const models = raw.allowedModels.filter(
			(model): model is string => typeof model === "string" && model.length > 0,
		);
		if (models.length > 0) policy.allowedModels = models;
	}
	if (Array.isArray(raw.denylistedProjects)) {
		const projects = raw.denylistedProjects.filter(
			(project): project is string =>
				typeof project === "string" && project.length > 0,
		);
		if (projects.length > 0) policy.denylistedProjects = projects;
	}
	if (typeof raw.updatedAt === "string") policy.updatedAt = raw.updatedAt;
	return policy;
}

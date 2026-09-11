/**
 * dsh local store — libsql persistence for the plugin (proposal §1: "Store
 * local libsql — sem build nativa, distribuível sem compilação").
 *
 * The local fuse's spentUsd comes from HERE in local-only mode: spend is
 * recorded per project and windowed on demand, surviving restarts, and the
 * sync path pulls exactly the rows not yet acknowledged by the SaaS. The
 * store is pure persistence — enforcement math stays in fuseDecision.
 *
 * ## Fidelity
 *
 * A stored row carries everything the SaaS needs to answer "quanto queimamos,
 * quem é o vilão, o que a política travou hoje" (proposal §3): the hashed
 * session identity, the reasoning effort actually used, and the full disjoint
 * token accounting the harness reports (`TokenUsage`: uncached input, output,
 * cache reads, cache writes). Dropping any of them makes a server-side policy
 * unevaluable or a session dimension unanswerable, so they are part of the
 * schema rather than of the sync mapping.
 *
 * The `usage` table is migrated in place ({@link migrate}) so an existing
 * `file:local.db` from an earlier version keeps its spend history instead of
 * being discarded.
 */

import { type Client, createClient } from "@libsql/client";

export interface StoredUsage {
	id: number;
	/** SHA-256 of the harness session id — the raw id never leaves the machine. */
	sessionId: string;
	project: string;
	costUsd: number;
	/** ISO timestamp — windows are computed from this, never from now. */
	at: string;
	synced: boolean;
	/** Meter fidelity: the model/provider behind this spend (best effort). */
	model: string;
	provider: string;
	reasoningEffort: string;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	/** Model-request latency for the step, when the durable log provided one. */
	durationMs: number | null;
	/** True when no price resolved for this call — visible, never silent. */
	unpriced: boolean;
	/** Client-generated stable id — the SaaS dedupes on (org, event_id). */
	eventId: string;
	/** Tool names this step called (metrics only — never arguments). */
	tools: string[];
}

/** One metered call, as the meter projects it from the session log. */
export interface UsageRecord {
	sessionId?: string;
	project: string;
	costUsd: number;
	at: string;
	model?: string;
	provider?: string;
	reasoningEffort?: string;
	inputTokens?: number;
	outputTokens?: number;
	cacheReadTokens?: number;
	cacheWriteTokens?: number;
	durationMs?: number | null;
	unpriced?: boolean;
	eventId?: string;
	/** Tool names this step called (metrics only). */
	tools?: string[];
}

export interface LocalStore {
	record(event: UsageRecord): Promise<void>;
	/** Sum of spend since `since` (ISO) for a project/dev (or the whole store). */
	spentForWindow(opts: {
		project?: string | null;
		dev?: string | null;
		since: string;
	}): Promise<number>;
	/** Rows not yet acknowledged by the SaaS (the batch payload). */
	pendingSync(limit?: number): Promise<StoredUsage[]>;
	/** Mark rows as synced after a successful batch. */
	markSynced(ids: number[]): Promise<void>;
	/** Fuse cuts (proposal §3) — reported to the SaaS, never lost. */
	recordCut(event: { project: string; rule: string }): Promise<void>;
	/** Unsynced cuts (cap: a stuck sync can't grow the batch unbounded). */
	pendingCuts(
		limit?: number,
	): Promise<{ id: number; project: string; rule: string }[]>;
	markCutsSynced(ids: number[]): Promise<void>;
	/**
	 * The SaaS 429 (secondary gate) engages the local fuse too: the rule +
	 * reset at persist so the offline gate reflects the remote decision
	 * (sync fidelity — a team blocked centrally is blocked locally). Blocks
	 * are scoped: an `org` block stops every call, a `project` block only the
	 * referenced project, a `dev` block only the referenced dev — one
	 * project's 429 must never freeze another project's work.
	 */
	setRemoteBlock(
		block: {
			rule: string;
			resetAt: string;
			scope?: "org" | "project" | "dev";
			reference?: string;
		} | null,
	): Promise<void>;
	/** The active block governing a call with this project/dev, or null. */
	remoteBlockFor(input: {
		project: string;
		dev: string;
	}): Promise<{ rule: string; resetAt: string } | null>;
	/**
	 * The org policy pulled from the SaaS (`GET /v1/policy`) — the panel is the
	 * control plane, so the local fuse reads its budgets/policies from here when
	 * the deployment published them. Cached for offline use.
	 */
	setRemotePolicy(policy: RemotePolicy | null): Promise<void>;
	remotePolicy(): Promise<RemotePolicy | null>;
	/** Persist the resolved price table so enforcement is offline-capable. */
	setPricingTable(table: Record<string, unknown> | null): Promise<void>;
	pricingTable(): Promise<Record<string, unknown> | null>;
	/** Release the underlying client (tests, teardown). */
	close(): Promise<void>;
}

/**
 * The org's enforcement state as the SaaS publishes it, in the fuse's own
 * vocabulary (see `GET /v1/policy`). Optional members mean "not configured",
 * which is why the fuse treats an absent budget list as "no local cap".
 *
 * Budgets carry their `scope` and `reference` so the fuse applies each one
 * only to calls it governs — never every org budget as a global cap.
 */
export interface RemotePolicy {
	budgets?: {
		limitUsd: number;
		window: "month" | "day";
		scope?: "org" | "project" | "dev";
		/** For project/dev scopes: the project label / developer id. */
		reference?: string;
	}[];
	maxReasoningEffort?: string;
	allowedModels?: string[];
	denylistedProjects?: string[];
	/** ISO timestamp of the published revision (diagnostics). */
	updatedAt?: string;
}

const COLUMNS = {
	usage: [
		["session_id", "TEXT NOT NULL DEFAULT ''"],
		["project", "TEXT NOT NULL"],
		["cost_usd", "REAL NOT NULL"],
		["at", "TEXT NOT NULL"],
		["synced", "INTEGER NOT NULL DEFAULT 0"],
		["model", "TEXT NOT NULL DEFAULT ''"],
		["provider", "TEXT NOT NULL DEFAULT ''"],
		["reasoning_effort", "TEXT NOT NULL DEFAULT ''"],
		["input_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["output_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["cache_read_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["cache_write_tokens", "INTEGER NOT NULL DEFAULT 0"],
		["duration_ms", "INTEGER"],
		["unpriced", "INTEGER NOT NULL DEFAULT 0"],
		["event_id", "TEXT NOT NULL DEFAULT ''"],
		["tools", "TEXT NOT NULL DEFAULT '[]'"],
	],
} as const;

/**
 * Create the tables and add any column a previous version lacked. SQLite has
 * no `ADD COLUMN IF NOT EXISTS`, so the existing column set is read first —
 * an upgrade keeps its history, a fresh database creates everything at once.
 */
async function migrate(client: Client): Promise<void> {
	await client.execute(
		`CREATE TABLE IF NOT EXISTS usage (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			session_id TEXT NOT NULL DEFAULT '',
			project TEXT NOT NULL,
			cost_usd REAL NOT NULL,
			at TEXT NOT NULL,
			synced INTEGER NOT NULL DEFAULT 0,
			model TEXT NOT NULL DEFAULT '',
			provider TEXT NOT NULL DEFAULT '',
			reasoning_effort TEXT NOT NULL DEFAULT '',
			input_tokens INTEGER NOT NULL DEFAULT 0,
			output_tokens INTEGER NOT NULL DEFAULT 0,
			cache_read_tokens INTEGER NOT NULL DEFAULT 0,
			cache_write_tokens INTEGER NOT NULL DEFAULT 0,
			duration_ms INTEGER,
			unpriced INTEGER NOT NULL DEFAULT 0,
			event_id TEXT NOT NULL DEFAULT '',
			tools TEXT NOT NULL DEFAULT '[]'
		)`,
	);
	const existing = await client.execute("PRAGMA table_info(usage)");
	const present = new Set(existing.rows.map((row) => String(row.name)));
	for (const [name, definition] of COLUMNS.usage) {
		if (present.has(name)) continue;
		await client.execute(`ALTER TABLE usage ADD COLUMN ${name} ${definition}`);
	}
	await client.batch([
		{
			sql: `CREATE TABLE IF NOT EXISTS cuts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				project TEXT NOT NULL,
				rule TEXT NOT NULL,
				synced INTEGER NOT NULL DEFAULT 0
			)`,
			args: [],
		},
		{
			sql: `CREATE TABLE IF NOT EXISTS state (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			)`,
			args: [],
		},
	]);
}

/** `url`: file path for the installed plugin, `:memory:` for tests. */
export function createLocalStore(url = "file:local.db"): LocalStore {
	const client: Client = createClient({ url });
	const ready = migrate(client);

	function number(value: unknown, fallback = 0): number {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : fallback;
	}

	/** Parse the JSON-encoded tool-name column, tolerating legacy garbage. */
	function parseTools(value: unknown): string[] {
		if (typeof value !== "string" || !value) return [];
		try {
			const parsed = JSON.parse(value) as unknown;
			return Array.isArray(parsed)
				? parsed.filter((item): item is string => typeof item === "string")
				: [];
		} catch {
			return [];
		}
	}

	function rowToUsage(row: Record<string, unknown>): StoredUsage {
		const duration = row.duration_ms;
		return {
			id: number(row.id),
			sessionId: String(row.session_id ?? ""),
			project: String(row.project),
			costUsd: number(row.cost_usd),
			at: String(row.at),
			synced: Boolean(row.synced),
			model: String(row.model ?? ""),
			provider: String(row.provider ?? ""),
			reasoningEffort: String(row.reasoning_effort ?? ""),
			inputTokens: number(row.input_tokens),
			outputTokens: number(row.output_tokens),
			cacheReadTokens: number(row.cache_read_tokens),
			cacheWriteTokens: number(row.cache_write_tokens),
			durationMs:
				duration === null || duration === undefined ? null : number(duration),
			unpriced: Boolean(row.unpriced),
			eventId: String(row.event_id ?? ""),
			tools: parseTools(row.tools),
		};
	}

	return {
		async record(event) {
			await ready;
			await client.execute({
				sql: `INSERT INTO usage (
					session_id, project, cost_usd, at, synced, model, provider,
					reasoning_effort, input_tokens, output_tokens,
					cache_read_tokens, cache_write_tokens, duration_ms, unpriced,
					event_id, tools
				) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				args: [
					event.sessionId ?? "",
					event.project,
					event.costUsd,
					event.at,
					event.model ?? "",
					event.provider ?? "",
					event.reasoningEffort ?? "",
					event.inputTokens ?? 0,
					event.outputTokens ?? 0,
					event.cacheReadTokens ?? 0,
					event.cacheWriteTokens ?? 0,
					event.durationMs ?? null,
					event.unpriced ? 1 : 0,
					event.eventId ?? "",
					JSON.stringify(event.tools ?? []),
				],
			});
		},
		async spentForWindow({ project, dev, since }) {
			await ready;
			const conditions: string[] = ["at >= ?"];
			const args: (string | number)[] = [since];
			if (project) {
				conditions.push("project = ?");
				args.push(project);
			}
			if (dev) {
				conditions.push("dev = ?");
				args.push(dev);
			}
			const res = await client.execute({
				sql: `SELECT coalesce(sum(cost_usd), 0) AS total FROM usage WHERE ${conditions.join(" AND ")}`,
				args,
			});
			return number(res.rows[0]?.total);
		},
		async pendingSync(limit = 500) {
			await ready;
			const res = await client.execute({
				sql: `SELECT id, session_id, project, cost_usd, at, synced, model,
					provider, reasoning_effort, input_tokens, output_tokens,
					cache_read_tokens, cache_write_tokens, duration_ms, unpriced,
					event_id, tools
					FROM usage WHERE synced = 0 ORDER BY id LIMIT ?`,
				args: [limit],
			});
			return res.rows.map((row) => rowToUsage(row as Record<string, unknown>));
		},
		async markSynced(ids) {
			await ready;
			for (const id of ids) {
				await client.execute({
					sql: "UPDATE usage SET synced = 1 WHERE id = ?",
					args: [id],
				});
			}
		},
		async recordCut(event) {
			await ready;
			await client.execute({
				sql: "INSERT INTO cuts (project, rule, synced) VALUES (?, ?, 0)",
				args: [event.project, event.rule],
			});
		},
		async pendingCuts(limit = 100) {
			await ready;
			const res = await client.execute({
				sql: "SELECT id, project, rule FROM cuts WHERE synced = 0 ORDER BY id LIMIT ?",
				args: [limit],
			});
			return res.rows.map((row) => ({
				id: number(row.id),
				project: String(row.project),
				rule: String(row.rule),
			}));
		},
		async markCutsSynced(ids) {
			await ready;
			for (const id of ids) {
				await client.execute({
					sql: "UPDATE cuts SET synced = 1 WHERE id = ?",
					args: [id],
				});
			}
		},
		async setRemoteBlock(block) {
			await ready;
			if (block === null) {
				await client.execute({
					sql: "DELETE FROM state WHERE key = 'remote_blocks'",
					args: [],
				});
				return;
			}
			// Replacing the whole scope's block: one org, one project, one dev.
			const res = await client.execute({
				sql: "SELECT value FROM state WHERE key = 'remote_blocks'",
				args: [],
			});
			let blocks: {
				rule: string;
				resetAt: string;
				scope?: string;
				reference?: string;
			}[] = [];
			const raw = res.rows[0]?.value;
			if (raw) {
				try {
					const parsed = JSON.parse(String(raw)) as typeof blocks;
					if (Array.isArray(parsed)) blocks = parsed;
				} catch {
					blocks = [];
				}
			}
			const scope = block.scope ?? "org";
			const reference = block.reference ?? "";
			// Replacing one scope's block only: same (scope, reference) key.
			blocks = blocks.filter(
				(b) =>
					(b.scope ?? "org") !== scope || (b.reference ?? "") !== reference,
			);
			// An expired block self-clears — windows are the release.
			const now = Date.now();
			blocks = blocks.filter((b) => new Date(b.resetAt).getTime() > now);
			blocks.push(block);
			await client.execute({
				sql: "INSERT INTO state (key, value) VALUES ('remote_blocks', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				args: [JSON.stringify(blocks)],
			});
		},
		async remoteBlockFor({ project, dev }) {
			await ready;
			const res = await client.execute({
				sql: "SELECT value FROM state WHERE key = 'remote_blocks'",
				args: [],
			});
			const raw = res.rows[0]?.value;
			if (!raw) return null;
			let blocks: {
				rule: string;
				resetAt: string;
				scope?: string;
				reference?: string;
			}[] = [];
			try {
				const parsed = JSON.parse(String(raw)) as typeof blocks;
				if (Array.isArray(parsed)) blocks = parsed;
			} catch {
				blocks = [];
			}
			const now = Date.now();
			for (const block of blocks) {
				if (new Date(block.resetAt).getTime() <= now) continue;
				const scope = block.scope ?? "org";
				const reference = block.reference ?? "";
				if (scope === "org") {
					return { rule: block.rule, resetAt: block.resetAt };
				}
				if (scope === "project" && reference === project) {
					return { rule: block.rule, resetAt: block.resetAt };
				}
				if (scope === "dev" && reference === dev) {
					return { rule: block.rule, resetAt: block.resetAt };
				}
			}
			return null;
		},
		async setRemotePolicy(policy) {
			await ready;
			if (policy === null) {
				await client.execute({
					sql: "DELETE FROM state WHERE key = 'remote_policy'",
					args: [],
				});
				return;
			}
			await client.execute({
				sql: "INSERT INTO state (key, value) VALUES ('remote_policy', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				args: [JSON.stringify(policy)],
			});
		},
		async remotePolicy() {
			await ready;
			const res = await client.execute({
				sql: "SELECT value FROM state WHERE key = 'remote_policy'",
				args: [],
			});
			const raw = res.rows[0]?.value;
			if (!raw) return null;
			try {
				return JSON.parse(String(raw)) as RemotePolicy;
			} catch {
				return null;
			}
		},
		async setPricingTable(table) {
			await ready;
			if (table === null) {
				await client.execute({
					sql: "DELETE FROM state WHERE key = 'pricing_table'",
					args: [],
				});
				return;
			}
			await client.execute({
				sql: "INSERT INTO state (key, value) VALUES ('pricing_table', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
				args: [JSON.stringify(table)],
			});
		},
		async pricingTable() {
			await ready;
			const res = await client.execute({
				sql: "SELECT value FROM state WHERE key = 'pricing_table'",
				args: [],
			});
			const raw = res.rows[0]?.value;
			if (!raw) return null;
			try {
				return JSON.parse(String(raw)) as Record<string, unknown>;
			} catch {
				return null;
			}
		},
		async close() {
			client.close();
		},
	};
}

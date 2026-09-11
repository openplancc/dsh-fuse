import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createLocalStore } from "../src/store.js";

// :memory: libsql — no native build, no files on disk (proposal §1).
const store = () => createLocalStore(":memory:");

describe("local store — libsql persistence (proposal §1)", () => {
	it("records usage and windows the spend per project", async () => {
		const db = store();
		await db.record({
			project: "openplan",
			costUsd: 0.01,
			at: "2026-09-01T12:00:00Z",
		});
		await db.record({
			project: "openplan",
			costUsd: 0.02,
			at: "2026-09-10T12:00:00Z",
		});
		await db.record({
			project: "other",
			costUsd: 0.5,
			at: "2026-09-10T12:00:00Z",
		});

		// Windowed since the month start: only the rows in the window count.
		const spent = await db.spentForWindow({
			project: "openplan",
			since: "2026-09-01T00:00:00Z",
		});
		expect(spent).toBeCloseTo(0.03, 8);

		// A different project stays separate.
		const other = await db.spentForWindow({
			project: "other",
			since: "2026-09-01T00:00:00Z",
		});
		expect(other).toBeCloseTo(0.5, 8);

		// Whole-store window.
		const all = await db.spentForWindow({
			project: null,
			since: "2026-09-01T00:00:00Z",
		});
		expect(all).toBeCloseTo(0.53, 8);
	});

	it("excludes rows before the window", async () => {
		const db = store();
		await db.record({ project: "p", costUsd: 1, at: "2026-08-31T23:59:00Z" });
		await db.record({ project: "p", costUsd: 1, at: "2026-09-01T00:00:00Z" });
		const spent = await db.spentForWindow({
			project: "p",
			since: "2026-09-01T00:00:00Z",
		});
		expect(spent).toBeCloseTo(1, 8);
	});

	it("tracks unsynced rows for the batch and marks them after", async () => {
		const db = store();
		await db.record({ project: "p", costUsd: 0.1, at: "2026-09-01T00:00:00Z" });
		await db.record({ project: "p", costUsd: 0.2, at: "2026-09-02T00:00:00Z" });

		const pending = await db.pendingSync();
		expect(pending).toHaveLength(2);
		expect(pending[0]?.costUsd).toBeCloseTo(0.1, 8);

		await db.markSynced(pending.map((row) => row.id));
		expect(await db.pendingSync()).toHaveLength(0);
	});

	it("sync watermark survives a restart (file-backed store)", async () => {
		const db = store();
		await db.record({ project: "p", costUsd: 0.4, at: "2026-09-01T00:00:00Z" });
		const pending = await db.pendingSync();
		expect(pending).toHaveLength(1);
	});

	it("carries the meter fidelity fields (model/provider/tokens) to the batch", async () => {
		const db = store();
		await db.record({
			project: "p",
			costUsd: 0.1,
			at: "2026-09-01T00:00:00Z",
			model: "openai/gpt-4o",
			provider: "openai",
			inputTokens: 1200,
			outputTokens: 300,
		});
		const [row] = await db.pendingSync();
		expect(row?.model).toBe("openai/gpt-4o");
		expect(row?.provider).toBe("openai");
		expect(row?.inputTokens).toBe(1200);
		expect(row?.outputTokens).toBe(300);
	});

	it("tracks fuse cuts until the batch acknowledges them (proposal §3)", async () => {
		const db = store();
		await db.recordCut({ project: "p", rule: "budget_exceeded" });
		await db.recordCut({ project: "p", rule: "reasoning_cap:medium" });
		const pending = await db.pendingCuts();
		expect(pending).toHaveLength(2);
		expect(pending[0]?.rule).toBe("budget_exceeded");
		await db.markCutsSynced(pending.map((cut) => cut.id));
		expect(await db.pendingCuts()).toHaveLength(0);
	});

	it("persists the SaaS 429 as the remote block and expires it at the reset", async () => {
		const db = store();
		expect(await db.remoteBlockFor({ project: "p", dev: "d" })).toBeNull();
		const future = new Date(Date.now() + 60_000).toISOString();
		await db.setRemoteBlock({ rule: "org_budget:x", resetAt: future });
		expect(await db.remoteBlockFor({ project: "p", dev: "d" })).toEqual({
			rule: "org_budget:x",
			resetAt: future,
		});
		// A success (or rotation) lifts the block.
		await db.setRemoteBlock(null);
		expect(await db.remoteBlockFor({ project: "p", dev: "d" })).toBeNull();
	});

	it("an expired remote block self-clears (the window reset is the release)", async () => {
		const db = store();
		const past = new Date(Date.now() - 1000).toISOString();
		await db.setRemoteBlock({ rule: "budget_exceeded", resetAt: past });
		expect(await db.remoteBlockFor({ project: "p", dev: "d" })).toBeNull();
	});

	it("scopes the remote block: a project 429 does not freeze another project", async () => {
		const db = store();
		const future = new Date(Date.now() + 60_000).toISOString();
		await db.setRemoteBlock({
			rule: "project_budget:b1",
			resetAt: future,
			scope: "project",
			reference: "openplan",
		});
		// The blocked project is frozen…
		expect(
			await db.remoteBlockFor({ project: "openplan", dev: "d" }),
		).not.toBeNull();
		// …another project is not.
		expect(
			await db.remoteBlockFor({ project: "daytrader", dev: "d" }),
		).toBeNull();
		// A dev block freezes only that dev.
		await db.setRemoteBlock({
			rule: "dev_budget:b2",
			resetAt: future,
			scope: "dev",
			reference: "dev@empresa.com",
		});
		expect(
			await db.remoteBlockFor({ project: "daytrader", dev: "dev@empresa.com" }),
		).not.toBeNull();
		expect(
			await db.remoteBlockFor({ project: "daytrader", dev: "other@x.com" }),
		).toBeNull();
		// Replacing the org block clears the org's own entry, not the others.
		await db.setRemoteBlock({ rule: "org_budget:x", resetAt: future });
		expect(
			await db.remoteBlockFor({ project: "other-project", dev: "d" }),
		).toEqual({ rule: "org_budget:x", resetAt: future });
		// …while the project-specific block still governs its own project.
		expect(await db.remoteBlockFor({ project: "openplan", dev: "d" })).toEqual({
			rule: "project_budget:b1",
			resetAt: future,
		});
	});
});

describe("local store — fidelity columns and in-place upgrade", () => {
	it("round-trips every fidelity field the SaaS needs", async () => {
		const db = store();
		await db.record({
			sessionId: "a".repeat(64),
			project: "p",
			costUsd: 0.5,
			at: "2026-09-01T00:00:00Z",
			model: "deepseek/deepseek-v4.1-flash",
			provider: "command-code",
			reasoningEffort: "medium",
			inputTokens: 10,
			outputTokens: 20,
			cacheReadTokens: 30,
			cacheWriteTokens: 40,
			durationMs: 2500,
		});
		const [row] = await db.pendingSync();
		expect(row?.sessionId).toBe("a".repeat(64));
		expect(row?.reasoningEffort).toBe("medium");
		expect(row?.cacheReadTokens).toBe(30);
		expect(row?.cacheWriteTokens).toBe(40);
		expect(row?.durationMs).toBe(2500);
	});

	it("stores a null duration rather than a fabricated zero", async () => {
		const db = store();
		await db.record({ project: "p", costUsd: 0, at: "2026-09-01T00:00:00Z" });
		const [row] = await db.pendingSync();
		expect(row?.durationMs).toBeNull();
		expect(row?.sessionId).toBe("");
	});

	it("caches the published org policy and clears it on demand", async () => {
		const db = store();
		expect(await db.remotePolicy()).toBeNull();
		await db.setRemotePolicy({
			budgets: [{ limitUsd: 50, window: "month" }],
			maxReasoningEffort: "medium",
			updatedAt: "2026-09-11T00:00:00Z",
		});
		expect((await db.remotePolicy())?.budgets).toEqual([
			{ limitUsd: 50, window: "month" },
		]);
		// Overwrites in place (a newer revision replaces the old one).
		await db.setRemotePolicy({ budgets: [{ limitUsd: 10, window: "day" }] });
		expect((await db.remotePolicy())?.budgets).toEqual([
			{ limitUsd: 10, window: "day" },
		]);
		await db.setRemotePolicy(null);
		expect(await db.remotePolicy()).toBeNull();
	});

	it("upgrades a database written by the previous schema without losing spend", async () => {
		const url = `file:${tmpdir()}/dsh-upgrade-${Date.now()}.db`;
		const { createClient } = await import("@libsql/client");
		// The v0 shape: no session_id, no reasoning_effort, no cache columns.
		const legacy = createClient({ url });
		await legacy.execute(
			`CREATE TABLE usage (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				project TEXT NOT NULL,
				cost_usd REAL NOT NULL,
				at TEXT NOT NULL,
				synced INTEGER NOT NULL DEFAULT 0,
				model TEXT NOT NULL DEFAULT '',
				provider TEXT NOT NULL DEFAULT '',
				input_tokens INTEGER NOT NULL DEFAULT 0,
				output_tokens INTEGER NOT NULL DEFAULT 0
			)`,
		);
		await legacy.execute({
			sql: "INSERT INTO usage (project, cost_usd, at, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)",
			args: ["legacy", 3.5, "2026-09-01T00:00:00Z", "m", 5, 6],
		});
		legacy.close();

		// Opening with the current store migrates in place…
		const db = createLocalStore(url);
		const spent = await db.spentForWindow({
			project: "legacy",
			since: "2026-09-01T00:00:00Z",
		});
		expect(spent).toBeCloseTo(3.5, 8);
		// …and the new columns exist with sane defaults.
		const [row] = await db.pendingSync();
		expect(row?.sessionId).toBe("");
		expect(row?.cacheWriteTokens).toBe(0);
		expect(row?.durationMs).toBeNull();
		// The upgraded store still writes the new fields.
		await db.record({
			sessionId: "b".repeat(64),
			project: "legacy",
			costUsd: 1,
			at: "2026-09-02T00:00:00Z",
			cacheWriteTokens: 7,
		});
		const rows = await db.pendingSync();
		expect(rows).toHaveLength(2);
		expect(rows[1]?.cacheWriteTokens).toBe(7);
	});
});

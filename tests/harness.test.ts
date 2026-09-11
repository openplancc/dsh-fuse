/**
 * The harness wiring, mounted on a real Cordis context.
 *
 * These are the tests that would have caught the three load-bearing defects of
 * the 2026-09-11 audit: the model id the harness actually reports is
 * provider-prefixed, the durable event carries the model on the MESSAGE, and a
 * session-keyed cache of headers is not the source of truth.
 */

import { tmpdir } from "node:os";
import { Context } from "@deepseek-ai/cordis";
import type { ToolDefinition, ToolRuntime } from "@deepseek-ai/dsh-tools";
import { describe, expect, it } from "vitest";
import { Config, type DshPluginConfig } from "../src/config.js";
import { apply } from "../src/harness.js";
import { createLocalStore } from "../src/store.js";
import {
	agentInjectSpies,
	assistantMessageEvent,
	clearAgentInjectSpies,
	eventually,
	fakeAgent,
	fakeSession,
	mountPlugin,
	preStep,
	requestHeaderEvent,
	requestRoute,
	stepStartEvent,
	T0,
	turnEndEvent,
} from "./support.js";

const tmpStore = (name: string) =>
	`file:${tmpdir()}/dsh-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

describe("meter — pricing resolution against real harness model ids", () => {
	it("prices a provider-prefixed model id against a bare table key", async () => {
		const storeUrl = tmpStore("priced");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			// $10 per 1M tokens in and out.
			pricingTable: {
				"deepseek-v4.1-flash": { inputCentsPerM: 1000, outputCentsPerM: 1000 },
			},
		});
		const session = fakeSession("s1");
		// The adapter reports the model with its vendor prefix — the real shape.
		ctx.emit(
			"session/event",
			session,
			requestHeaderEvent({
				provider: "command-code",
				model: "deepseek/deepseek-v4.1-flash",
			}),
		);
		ctx.emit(
			"session/event",
			session,
			assistantMessageEvent({
				provider: "command-code",
				model: "deepseek/deepseek-v4.1-flash",
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
			}),
		);
		ctx.emit("session/event", session, turnEndEvent({}));

		const store = createLocalStore(storeUrl);
		await eventually(
			async () => (await store.pendingSync()).length > 0,
			"the metered row",
		);
		const [row] = await store.pendingSync();
		// 1M input tokens at $10/1M = $10 — not $0.
		expect(row?.costUsd).toBeCloseTo(10, 6);
		expect(row?.model).toBe("deepseek/deepseek-v4.1-flash");
		expect(row?.provider).toBe("command-code");
		await dispose();
	});

	it("honours pricingAliases when nothing else can guess the id", async () => {
		const storeUrl = tmpStore("alias");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: {
				"internal-rate": { inputCentsPerM: 100, outputCentsPerM: 100 },
			},
			pricingAliases: { "vendor/opaque-model-v9": "internal-rate" },
		});
		const session = fakeSession("s1");
		ctx.emit(
			"session/event",
			session,
			assistantMessageEvent({
				provider: "vendor",
				model: "vendor/opaque-model-v9",
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
			}),
		);
		ctx.emit("session/event", session, turnEndEvent({}));

		const store = createLocalStore(storeUrl);
		await eventually(
			async () => (await store.pendingSync()).length > 0,
			"the metered row",
		);
		const [row] = await store.pendingSync();
		expect(row?.costUsd).toBeCloseTo(1, 6);
		await dispose();
	});

	it("attributes the model from the message provenance, not a header cache", async () => {
		const storeUrl = tmpStore("provenance");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: {
				"model-b": { inputCentsPerM: 1000, outputCentsPerM: 1000 },
			},
		});
		const session = fakeSession("s1");
		// A header for model-a, but the message was produced by model-b.
		ctx.emit(
			"session/event",
			session,
			requestHeaderEvent({ provider: "p", model: "model-a" }),
		);
		ctx.emit(
			"session/event",
			session,
			assistantMessageEvent({
				provider: "p",
				model: "model-b",
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
			}),
		);
		ctx.emit("session/event", session, turnEndEvent({}));

		const store = createLocalStore(storeUrl);
		await eventually(
			async () => (await store.pendingSync()).length > 0,
			"the metered row",
		);
		const [row] = await store.pendingSync();
		expect(row?.model).toBe("model-b");
		expect(row?.costUsd).toBeCloseTo(10, 6);
		await dispose();
	});

	it("records full token accounting, the hashed session id and step latency", async () => {
		const storeUrl = tmpStore("fidelity");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 0, outputCentsPerM: 0 } },
		});
		const session = fakeSession("session-raw-id");
		ctx.emit("session/event", session, stepStartEvent({ time: T0 }));
		ctx.emit(
			"session/event",
			session,
			requestHeaderEvent({
				provider: "p",
				model: "m",
				reasoningEffort: "medium",
			}),
		);
		ctx.emit(
			"session/event",
			session,
			assistantMessageEvent({
				provider: "p",
				model: "m",
				time: T0 + 2500,
				usage: {
					inputTokens: 100,
					outputTokens: 50,
					cacheReadTokens: 900,
					cacheWriteTokens: 400,
				},
			}),
		);
		ctx.emit("session/event", session, turnEndEvent({}));

		const store = createLocalStore(storeUrl);
		await eventually(
			async () => (await store.pendingSync()).length > 0,
			"the metered row",
		);
		const [row] = await store.pendingSync();
		expect(row?.sessionId).toHaveLength(64);
		expect(row?.sessionId).not.toContain("session-raw-id");
		expect(row?.reasoningEffort).toBe("medium");
		expect(row?.inputTokens).toBe(100);
		expect(row?.outputTokens).toBe(50);
		expect(row?.cacheReadTokens).toBe(900);
		expect(row?.cacheWriteTokens).toBe(400);
		expect(row?.durationMs).toBe(2500);
		await dispose();
	});
});

describe("fuse — the primary gate", () => {
	it("rejects before the step when the budget cannot absorb the estimate", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			budgets: [{ limitUsd: 0.001, window: "day" }],
			// 1000 estimated tokens at $100/1M → far above the $0.001 cap.
			pricingTable: { m: { inputCentsPerM: 10000, outputCentsPerM: 10000 } },
		});
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
			messages: [{ role: "user", content: "x".repeat(4000) }],
		});
		expect(decision).toEqual({ kind: "reject" });
		await dispose();
	});

	it("delegates to next() when the budget is healthy", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			budgets: [{ limitUsd: 100, window: "day" }],
			pricingTable: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
		});
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
		});
		expect(decision).toEqual({ kind: "enter", messages: [] });
		await dispose();
	});

	it("records the cut so the batch can report it (proposal §3)", async () => {
		const storeUrl = tmpStore("cuts");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			budgets: [{ limitUsd: 0.001, window: "day" }],
			pricingTable: { m: { inputCentsPerM: 1e6, outputCentsPerM: 1e6 } },
		});
		await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
			messages: [{ role: "user", content: "hello" }],
		});
		const store = createLocalStore(storeUrl);
		const cuts = await store.pendingCuts();
		expect(cuts).toHaveLength(1);
		expect(cuts[0]?.rule).toBe("budget_exceeded");
		await dispose();
	});

	it("injects an in-session cut notice, deduped per rule and window", async () => {
		clearAgentInjectSpies();
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			budgets: [{ limitUsd: 0.001, window: "day" }],
			pricingTable: { m: { inputCentsPerM: 1e6, outputCentsPerM: 1e6 } },
		});
		const agent = fakeAgent("s1", { provider: "p", model: "m" });

		// Two blocked steps in the same window → exactly one notice: the
		// harness would otherwise restate the cut on every rejected step.
		await preStep(ctx, { agent, messages: [{ role: "user", content: "a" }] });
		await preStep(ctx, { agent, messages: [{ role: "user", content: "b" }] });

		const notices = agentInjectSpies.get("s1") ?? [];
		expect(notices).toHaveLength(1);
		const notice = notices[0];
		expect(notice?.role).toBe("user");
		const source = notice?.source as {
			kind: string;
			form?: string;
			summary?: string;
		};
		expect(source.kind).toBe("plugin");
		expect(source.form).toBe("notice");
		expect(source.summary).toContain("cortada");
		await dispose();
	});

	it("injects a notice for a remote (SaaS 429) block", async () => {
		clearAgentInjectSpies();
		const storeUrl = tmpStore("remote-block");
		// The plugin opens the same file store from config.storeUrl — seed the
		// remote block through a second handle before the step runs, so the
		// pre-step path engages the 429 branch without a live SaaS.
		const store = createLocalStore(storeUrl);
		await store.setRemoteBlock({
			rule: "budget_exceeded",
			resetAt: new Date(Date.now() + 60_000).toISOString(),
		});
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			budgets: [{ limitUsd: 100, window: "day" }],
			pricingTable: { m: { inputCentsPerM: 1e6, outputCentsPerM: 1e6 } },
		});
		const agent = fakeAgent("s1", { provider: "p", model: "m" });
		const decision = await preStep(ctx, {
			agent,
			messages: [{ role: "user", content: "a" }],
		});
		expect(decision).toEqual({ kind: "reject" });
		const notices = agentInjectSpies.get("s1") ?? [];
		expect(notices).toHaveLength(1);
		const source = notices[0]?.source as {
			kind: string;
			form?: string;
			summary?: string;
		};
		expect(source.form).toBe("notice");
		expect(source.summary).toContain("bloqueadas");
		await dispose();
	});

	it("denies a denylisted project", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "segredo-cliente",
			policies: { denylistedProjects: ["segredo-cliente"] },
		});
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
		});
		expect(decision).toEqual({ kind: "reject" });
		await dispose();
	});
});

describe("router — agent/request waterfall", () => {
	it("rewrites the model when policy denies the requested one", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			cascade: ["cheap/model", "dear/model"],
			policies: { allowedModels: ["cheap/model"] },
		});
		const result = await requestRoute(ctx, {
			agent: fakeAgent("s1"),
			config: { provider: "dear", model: "dear/model" },
		});
		expect(result.model).toBe("cheap/model");
		await dispose();
	});
});

describe("lifecycle", () => {
	it("flushes the meter when the plugin unloads (ctx.effect disposer)", async () => {
		const storeUrl = tmpStore("unload");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 1000, outputCentsPerM: 1000 } },
		});
		ctx.emit(
			"session/event",
			fakeSession("s1"),
			assistantMessageEvent({
				provider: "p",
				model: "m",
				usage: { inputTokens: 1_000_000, outputTokens: 0 },
			}),
		);
		// No turn/end: disposal itself must drain the queue.
		await dispose();

		const store = createLocalStore(storeUrl);
		const rows = await store.pendingSync();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.costUsd).toBeCloseTo(10, 6);
	});

	it("meters a resumed session that never logged a request header", async () => {
		const storeUrl = tmpStore("resume");
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 0, outputCentsPerM: 0 } },
		});
		const session = fakeSession("resumed");
		// No request/header at all: the provenance still identifies the call.
		ctx.emit(
			"session/event",
			session,
			assistantMessageEvent({
				provider: "p",
				model: "m",
				usage: { inputTokens: 5, outputTokens: 5 },
			}),
		);
		ctx.emit("session/event", session, turnEndEvent({}));
		const store = createLocalStore(storeUrl);
		await eventually(
			async () => (await store.pendingSync()).length > 0,
			"the metered row",
		);
		const [row] = await store.pendingSync();
		expect(row?.model).toBe("m");
		expect(row?.durationMs).toBeNull();
		await dispose();
	});
});

describe("reasoning cap through the harness route metadata", () => {
	it("ranks the cap against the adapter's own effort list", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			policies: { maxReasoningEffort: "medium" },
		});
		// The harness's llm service is optional, so the plugin probes it with
		// ctx.get instead of injecting it. Provide the documented shape: a route
		// whose adapter-owned ids are NOT the plugin's old hardcoded vocabulary.
		ctx.provide("llm", {
			resolveModelInfo: async () => ({
				reasoning: {
					efforts: [
						{ id: "none" },
						{ id: "low" },
						{ id: "medium" },
						{ id: "high" },
					],
				},
			}),
		});

		// The cheapest possible request must pass a `medium` cap.
		const cheap = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
			messages: [],
		});
		expect(cheap).toEqual({ kind: "enter", messages: [] });
		await dispose();
	});

	it("does not cut a call whose route publishes no reasoning metadata", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			policies: { maxReasoningEffort: "medium" },
		});
		ctx.provide("llm", { resolveModelInfo: async () => ({}) });
		const session = fakeSession("s1");
		ctx.emit(
			"session/event",
			session,
			requestHeaderEvent({
				provider: "p",
				model: "m",
				reasoningEffort: "high",
			}),
		);
		// The cap is reported as unenforceable, but the call is not blocked on a
		// guess: a false cut is worse than a visible gap.
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
			messages: [],
		});
		expect(decision).toEqual({ kind: "enter", messages: [] });
		await dispose();
	});
});

describe("panel → local fuse (GET /v1/policy)", () => {
	it("enforces a budget the panel published, not only the YAML's", async () => {
		const storeUrl = tmpStore("remote-policy");
		// Seed the store as a previous sync would have: a published org budget.
		const seed = createLocalStore(storeUrl);
		await seed.setRemotePolicy({
			budgets: [{ limitUsd: 0.000001, window: "day" }],
			updatedAt: new Date().toISOString(),
		});
		await seed.close();

		// The deployment's own config has NO budget: only the panel's is in force.
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 1000, outputCentsPerM: 1000 } },
		});
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
			messages: [{ role: "user", content: "x".repeat(4000) }],
		});
		expect(decision).toEqual({ kind: "reject" });
		await dispose();
	});

	it("falls back to the configured policy when nothing is published", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: ":memory:",
			project: "test",
			policies: { denylistedProjects: ["test"] },
		});
		const decision = await preStep(ctx, {
			agent: fakeAgent("s1", { provider: "p", model: "m" }),
		});
		expect(decision).toEqual({ kind: "reject" });
		await dispose();
	});
});

describe("scoped budgets and scoped 429 blocks (dsh review P0)", () => {
	const AGENT = fakeAgent("s1", { provider: "p", model: "m" });

	it("applies a project budget ONLY to its own project", async () => {
		const storeUrl = tmpStore("scoped-budget");
		const seed = createLocalStore(storeUrl);
		// The panel published a budget for a DIFFERENT project.
		await seed.setRemotePolicy({
			budgets: [
				{
					limitUsd: 0.000001,
					window: "day",
					scope: "project",
					reference: "outro-projeto",
				},
			],
			updatedAt: new Date().toISOString(),
		});
		await seed.close();

		// This deployment runs as project "test": the other project's budget
		// must not govern it (the old code applied every published budget
		// globally).
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 100000, outputCentsPerM: 100000 } },
		});
		const decision = await preStep(ctx, {
			agent: AGENT,
			messages: [{ role: "user", content: "x".repeat(4000) }],
		});
		expect(decision.kind).toBe("enter");
		await dispose();
	});

	it("applies a project budget to the project it names", async () => {
		const storeUrl = tmpStore("scoped-budget-match");
		const seed = createLocalStore(storeUrl);
		await seed.setRemotePolicy({
			budgets: [
				{
					limitUsd: 0.000001,
					window: "day",
					scope: "project",
					reference: "test",
				},
			],
			updatedAt: new Date().toISOString(),
		});
		await seed.close();

		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 100000, outputCentsPerM: 100000 } },
		});
		const decision = await preStep(ctx, {
			agent: AGENT,
			messages: [{ role: "user", content: "x".repeat(4000) }],
		});
		expect(decision).toEqual({ kind: "reject" });
		await dispose();
	});

	it("a project 429 block does not freeze a different project", async () => {
		const storeUrl = tmpStore("scoped-block");
		const seed = createLocalStore(storeUrl);
		await seed.setRemoteBlock({
			rule: "project_budget:b1",
			resetAt: new Date(Date.now() + 60_000).toISOString(),
			scope: "project",
			reference: "outro-projeto",
		});
		await seed.close();

		// Running as project "test" — another project's 429 must not stop it.
		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
		});
		expect(
			(await preStep(ctx, { agent: fakeAgent("s-budget-tool") })).kind,
		).toBe("enter");
		await dispose();
	});

	it("an org 429 block freezes every project", async () => {
		const storeUrl = tmpStore("org-block");
		const seed = createLocalStore(storeUrl);
		await seed.setRemoteBlock({
			rule: "org_budget:b1",
			resetAt: new Date(Date.now() + 60_000).toISOString(),
		});
		await seed.close();

		const { ctx, dispose } = await mountPlugin({
			storeUrl,
			project: "test",
			pricingTable: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
		});
		expect(await preStep(ctx, { agent: AGENT })).toEqual({ kind: "reject" });
		await dispose();
	});
});

describe("model-facing budget status tool", () => {
	/**
	 * A minimal `tools` service double: the plugin only calls `register`, and
	 * the double records what it was handed so the test can execute the real
	 * definition against the real store. The plugin reaches the service
	 * structurally via `ctx.get('tools')` (no `inject`), which is exactly what
	 * this stands in for — the docs' optional-service idiom.
	 */
	function toolsServiceDouble(): {
		service: ToolRuntime;
		registered: ToolDefinition[];
		unregistered: () => number;
	} {
		const registered: ToolDefinition[] = [];
		let unregistered = 0;
		return {
			service: {
				register: (definition: ToolDefinition) => {
					registered.push(definition);
					return () => {
						unregistered += 1;
					};
				},
			} as unknown as ToolRuntime,
			registered,
			unregistered: () => unregistered,
		};
	}

	function rawConfig(storeUrl: string) {
		return {
			storeUrl,
			project: "test",
			dev: "dev@x",
			pricingTable: { m: { inputCentsPerM: 1, outputCentsPerM: 1 } },
		};
	}

	it("registers the tool and reports the scoped enforcement state", async () => {
		const storeUrl = tmpStore("budget-tool-live");
		const seed = createLocalStore(storeUrl);
		await seed.setRemotePolicy({
			budgets: [
				{ limitUsd: 50, window: "month", scope: "org" },
				{ limitUsd: 5, window: "day", scope: "project", reference: "test" },
				// Another project's budget must never appear in this view.
				{ limitUsd: 9, window: "day", scope: "project", reference: "outro" },
			],
		});
		await seed.record({
			sessionId: "s1",
			project: "test",
			costUsd: 1.25,
			at: new Date().toISOString(),
			model: "m",
			provider: "p",
			reasoningEffort: "",
			inputTokens: 10,
			outputTokens: 5,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			durationMs: null,
			unpriced: false,
			eventId: "e1",
			tools: [],
		});
		await seed.close();

		// The service must be present at load — the real composition mounts
		// `dsh-tools` before the cost-policy layer.
		const ctx = new Context();
		const double = toolsServiceDouble();
		ctx.provide("tools", double.service);
		const fiber = ctx.plugin(
			{ name: "fuse", apply, Config },
			rawConfig(storeUrl) as Partial<DshPluginConfig>,
		);
		await fiber;

		expect(double.registered).toHaveLength(1);
		const tool = double.registered[0];
		const value = (await tool.execute({}, {} as never)) as { status: string };
		expect(value.status).toContain('project "test"');
		// Org + this project's day budget, with the store's actual spend.
		expect(value.status).toContain(
			"org (this machine) · month · $1.2500 / $50.00 (2.5% used)",
		);
		expect(value.status).toContain(
			'project "test" · day · $1.2500 / $5.00 (25.0% used)',
		);
		// Another project's budget is not part of this machine's view.
		expect(value.status).not.toContain("outro");
		expect(value.status).toContain("remote block: none");

		// The exact effect disposer from `register` is wired into ctx.effect:
		// unloading the plugin unregisters the tool.
		await fiber.dispose();
		expect(double.unregistered()).toBe(1);
	});

	it("registers nothing when the deployment disables the tool", async () => {
		const ctx = new Context();
		ctx.provide("tools", {
			register: () => {
				throw new Error("must not register when disabled");
			},
		} as unknown as ToolRuntime);
		const fiber = ctx.plugin(
			{
				name: "fuse",
				apply,
				Config,
			},
			{ ...rawConfig(tmpStore("budget-tool-off")), budgetStatusTool: false },
		);
		await fiber; // would reject if register() ran
		await fiber.dispose();
	});

	it("loads and enforces without a tools service (optional, never PENDING)", async () => {
		const { ctx, dispose } = await mountPlugin({
			storeUrl: tmpStore("budget-tool-absent"),
		});
		expect(
			(await preStep(ctx, { agent: fakeAgent("s-budget-tool") })).kind,
		).toBe("enter");
		await dispose();
	});
});

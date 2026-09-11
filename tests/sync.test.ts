import { describe, expect, it, vi } from "vitest";
import { fetchPolicy, parseRemotePolicy, syncBatch } from "../src/sync.js";

function stubFetch(impl: (url: string) => Response | Promise<Response>) {
	return vi.fn(async (url: string | URL) => impl(String(url)));
}

describe("syncBatch — the secondary gate", () => {
	it("surfaces the SaaS 429 as a block with the rule, and keeps the rows", async () => {
		const result = await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: stubFetch(
				() =>
					new Response(
						JSON.stringify({
							error: "BudgetExceeded",
							rule: "org_budget:x",
							reset_at: "2026-09-01T00:00:00Z",
						}),
						{ status: 429 },
					),
			) as unknown as typeof fetch,
		});
		expect(result.blocked).toBe(true);
		expect(result.blockedRule).toBe("org_budget:x");
		expect(result.delivered).toBe(false);
	});

	it("reports a delivered batch on 200", async () => {
		const result = await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: stubFetch(
				() =>
					new Response(JSON.stringify({ ok: true, accepted: 3 }), {
						status: 200,
					}),
			) as unknown as typeof fetch,
		});
		expect(result.accepted).toBe(3);
		expect(result.delivered).toBe(true);
	});

	it("does NOT treat a server error as delivered (the rows must survive)", async () => {
		const result = await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: stubFetch(
				() =>
					new Response(JSON.stringify({ error: "internal_error" }), {
						status: 500,
					}),
			) as unknown as typeof fetch,
		});
		expect(result.delivered).toBe(false);
		expect(result.blocked).toBe(false);
		expect(result.status).toBe(500);
		expect(result.accepted).toBe(0);
	});

	it("does not treat an HTML error page or a network failure as delivered", async () => {
		const html = await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: stubFetch(
				() => new Response("<html>502</html>", { status: 502 }),
			) as unknown as typeof fetch,
		});
		expect(html.delivered).toBe(false);

		const offline = await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: vi.fn(async () => {
				throw new Error("ENOTFOUND");
			}) as unknown as typeof fetch,
		});
		expect(offline.delivered).toBe(false);
		expect(offline.status).toBe(0);
	});

	it("signs the batch with the org key", async () => {
		const impl = vi.fn(async (_url: string | URL, init?: RequestInit) => {
			expect(new Headers(init?.headers).get("x-org-key")).toBe("k");
			return new Response(JSON.stringify({ ok: true, accepted: 0 }), {
				status: 200,
			});
		});
		await syncBatch({
			baseUrl: "https://x",
			orgKey: "k",
			events: [],
			fetchImpl: impl as unknown as typeof fetch,
		});
	});
});

describe("fetchPolicy — the panel as the local fuse's control plane", () => {
	it("parses a published policy into the fuse's vocabulary", async () => {
		const result = await fetchPolicy({
			baseUrl: "https://x",
			orgKey: "k",
			fetchImpl: stubFetch(
				() =>
					new Response(
						JSON.stringify({
							budgets: [
								{
									id: "b1",
									scope: "org",
									reference: "org",
									limitUsd: 50,
									window: "month",
								},
							],
							maxReasoningEffort: "medium",
							allowedModels: ["cheap/model"],
							denylistedProjects: ["segredo"],
							updatedAt: "2026-09-11T00:00:00Z",
						}),
						{ status: 200 },
					),
			) as unknown as typeof fetch,
		});
		expect(result.policy).toEqual({
			budgets: [
				{ limitUsd: 50, window: "month", scope: "org", reference: "org" },
			],
			maxReasoningEffort: "medium",
			allowedModels: ["cheap/model"],
			denylistedProjects: ["segredo"],
			updatedAt: "2026-09-11T00:00:00Z",
		});
	});

	it("requests the key-authed endpoint with the org key", async () => {
		const impl = vi.fn(async (url: string | URL, init?: RequestInit) => {
			expect(String(url)).toBe("https://x/v1/policy");
			expect(new Headers(init?.headers).get("x-org-key")).toBe("k");
			return new Response(JSON.stringify({ budgets: [] }), { status: 200 });
		});
		await fetchPolicy({
			baseUrl: "https://x",
			orgKey: "k",
			fetchImpl: impl as unknown as typeof fetch,
		});
	});

	it("returns an error (not a policy) on an unauthorized key", async () => {
		const result = await fetchPolicy({
			baseUrl: "https://x",
			orgKey: "bad",
			fetchImpl: stubFetch(
				() => new Response("{}", { status: 401 }),
			) as unknown as typeof fetch,
		});
		expect(result.policy).toBeNull();
		expect(result.error).toBe("unauthorized");
	});
});

describe("parseRemotePolicy — malformed input never half-applies", () => {
	it("drops a budget whose limit or window is unusable", () => {
		const policy = parseRemotePolicy({
			budgets: [
				{ limitUsd: "50", window: "month" },
				{ limitUsd: 10, window: "week" },
				{ limitUsd: -1, window: "day" },
				{ limitUsd: 25, window: "day" },
			],
		});
		expect(policy?.budgets).toEqual([
			{ limitUsd: 50, window: "month" },
			{ limitUsd: 25, window: "day" },
		]);
	});

	it("treats a non-array allowlist as unset instead of denying every model", () => {
		const policy = parseRemotePolicy({ allowedModels: "cheap/model" });
		expect(policy?.allowedModels).toBeUndefined();
	});

	it("ignores empty strings and non-strings in the lists", () => {
		const policy = parseRemotePolicy({
			allowedModels: ["a", "", 42, "b"],
			denylistedProjects: ["", "x"],
		});
		expect(policy?.allowedModels).toEqual(["a", "b"]);
		expect(policy?.denylistedProjects).toEqual(["x"]);
	});

	it("returns an empty policy for junk, never null-shaped garbage", () => {
		expect(parseRemotePolicy(null)).toBeNull();
		expect(parseRemotePolicy("nope")).toBeNull();
		expect(parseRemotePolicy({})).toEqual({});
	});
});

import { describe, expect, it, vi } from "vitest";
import {
	type BudgetStatus,
	budgetStatusText,
	createBudgetStatusTool,
} from "../src/budget-tool.js";

function status(partial: Partial<BudgetStatus> = {}): BudgetStatus {
	return {
		project: "openplan",
		dev: "dev@openplan.cc",
		at: "2026-09-11T12:00:00.000Z",
		budgets: [],
		block: null,
		...partial,
	};
}

describe("budgetStatusText", () => {
	it("states plainly when no budget is in force", () => {
		const text = budgetStatusText(status());
		expect(text).toContain('project "openplan"');
		expect(text).toContain("no budgets in force");
		expect(text).toContain("remote block: none");
	});

	it("labels each scope and shows spend against the limit", () => {
		const text = budgetStatusText(
			status({
				budgets: [
					{ scope: "org", window: "month", limitUsd: 50, spentUsd: 25 },
					{
						scope: "project",
						reference: "openplan",
						window: "day",
						limitUsd: 5,
						spentUsd: 5,
					},
				],
			}),
		);
		expect(text).toContain(
			"org (this machine) · month · $25.0000 / $50.00 (50.0% used)",
		);
		expect(text).toContain(
			'project "openplan" · day · $5.0000 / $5.00 (100.0% used)',
		);
	});

	it("surfaces the active remote block and its reset", () => {
		const text = budgetStatusText(
			status({
				block: { rule: "org_budget:b1", resetAt: "2026-09-12T00:00:00.000Z" },
			}),
		);
		expect(text).toContain(
			"remote block: org_budget:b1 until 2026-09-12T00:00:00.000Z",
		);
	});
});

describe("createBudgetStatusTool", () => {
	it("declares a no-argument tool whose output is the rendered status", async () => {
		const tool = createBudgetStatusTool(async () => status());
		expect(tool.name).toBe("dsh_budget_status");
		expect(tool.parameters).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
		});
		const value = (await tool.execute({}, {} as never)) as { status: string };
		expect(value.status).toContain("dsh budget status");
	});

	it("renders the canonical value as a single text block", () => {
		const tool = createBudgetStatusTool(async () => status());
		const blocks = tool.output.render({}, { status: "hello" });
		expect(blocks).toEqual([{ type: "text", text: "hello" }]);
	});

	it("is honest about a read failure instead of returning a blank page", async () => {
		const tool = createBudgetStatusTool(async () => {
			throw new Error("store closed");
		});
		await expect(tool.execute({}, {} as never)).rejects.toThrow("store closed");
		// The registry surfaces thrown bodies as tool errors; the important part
		// is that the tool never fabricates a "you have budget" answer.
		expect(tool.isConcurrencySafe?.({})).toBe(true);
	});

	it("reads live state per call (never caches a stale snapshot)", async () => {
		const read = vi
			.fn()
			.mockResolvedValueOnce(status({ budgets: [] }))
			.mockResolvedValueOnce(
				status({
					budgets: [{ scope: "org", window: "day", limitUsd: 1, spentUsd: 1 }],
				}),
			);
		const tool = createBudgetStatusTool(read);
		const first = (await tool.execute({}, {} as never)) as { status: string };
		const second = (await tool.execute({}, {} as never)) as { status: string };
		expect(first.status).toContain("no budgets in force");
		expect(second.status).toContain("100.0% used");
		expect(read).toHaveBeenCalledTimes(2);
	});
});

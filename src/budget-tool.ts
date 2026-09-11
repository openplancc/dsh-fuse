/**
 * The model-facing budget-status tool — the documented *"separate
 * model-facing ask tool"* that pairs with an enforcement gate.
 *
 * The harness extension cookbook prescribes the pair: a gate says *no* (the
 * plugin's `agent/pre-step` fuse), and a separate tool lets the AGENT itself
 * read the policy state — remaining budget per enforced scope, active remote
 * blocks and their reset, the project/dev labels in force. A hard cut is only
 * tolerable when the thing being cut understands it: the model can query this
 * before spending in a long task (or right after being cut) and adapt —
 * asking the user, stopping, or picking a cheaper route — instead of dying
 * blind. This is the mitigation the proposal's Fase-6 metric
 * ("falso-positivo de trava") needs.
 *
 * ## Status-only, never a decision
 *
 * The tool is deliberately inert as policy: it reads the same libsql store the
 * fuse enforces (`spentForWindow`, `remoteBlockFor`, the published policy) and
 * formats a view. It never gates, never rewrites, and its schema rides in the
 * model's toolset only when the deployment left it enabled
 * (`config.budgetStatusTool`). Registration is optional at load: it is skipped
 * when the composition mounts no `tools` service (`@deepseek-ai/dsh-tools`),
 * because the plugin declares no `inject` — an optional service must never
 * hold the fiber PENDING.
 *
 * Types are the REAL `@deepseek-ai/dsh-tools` declarations (the same rule as
 * the rest of the plugin): the object below is built as a literal so no
 * runtime import of `dsh-tools` is needed — the plugin stays distributable
 * standalone, and only the type surface is referenced.
 */

import type { ContentBlock } from "@deepseek-ai/dsh-llm";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";

/** One budget in force for this machine, with its governing scope. */
export interface ScopedBudgetStatus {
	scope: "org" | "project" | "dev";
	/** Project label / developer id for scoped entries. */
	reference?: string;
	window: "month" | "day";
	limitUsd: number;
	spentUsd: number;
}

/** The active remote 429 block governing this machine, if any. */
export interface RemoteBlockStatus {
	rule: string;
	resetAt: string;
}

/** The full model-facing view of the local policy state. */
export interface BudgetStatus {
	project: string;
	dev: string;
	/** ISO timestamp of the snapshot. */
	at: string;
	/** Budgets in force (no ordering guaranteed). */
	budgets: ScopedBudgetStatus[];
	block: RemoteBlockStatus | null;
}

/** Human-readable markdown-ish summary handed straight to the model. */
export function budgetStatusText(status: BudgetStatus): string {
	const lines: string[] = [
		`dsh budget status — project "${status.project}", dev "${status.dev}" (at ${status.at})`,
	];
	if (status.budgets.length === 0) {
		lines.push("  no budgets in force");
	} else {
		lines.push("  budgets in force:");
		for (const budget of status.budgets) {
			const label =
				budget.scope === "project"
					? `project "${budget.reference ?? status.project}"`
					: budget.scope === "dev"
						? `dev "${budget.reference ?? status.dev}"`
						: "org (this machine)";
			const used =
				budget.limitUsd > 0
					? `${((budget.spentUsd / budget.limitUsd) * 100).toFixed(1)}% used`
					: "no limit";
			lines.push(
				`  - ${label} · ${budget.window} · $${budget.spentUsd.toFixed(4)} / $${budget.limitUsd.toFixed(2)} (${used})`,
			);
		}
	}
	if (status.block) {
		lines.push(
			`  remote block: ${status.block.rule} until ${status.block.resetAt} (a SaaS 429 is engaging the local fuse)`,
		);
	} else {
		lines.push("  remote block: none");
	}
	lines.push(
		"  note: figures are what the local fuse enforces; unpriced calls count at $0.",
	);
	return lines.join("\n");
}

/**
 * Build the registry-ready tool definition. The status read is injected so the
 * module stays pure (unit-testable without the harness); the wiring in
 * `harness.ts` supplies the live read over the same store the fuse uses.
 *
 * @param readStatus - resolve the current policy state (store-backed).
 * @returns a `ToolDefinition` for `ctx.tools.register(...)`.
 */
export function createBudgetStatusTool(
	readStatus: () => Promise<BudgetStatus>,
): ToolDefinition {
	return {
		name: "dsh_budget_status",
		description:
			"Read the local dsh cost-policy status: remaining budget per enforced scope (org/project/dev), any active remote block and its reset time. Useful before spending in a long task or right after a step was cut by policy.",
		parameters: {
			type: "object",
			properties: {},
			additionalProperties: false,
		},
		output: {
			schema: {
				type: "object",
				properties: {
					status: {
						type: "string",
						description: "Human-readable policy status summary.",
					},
				},
				required: ["status"],
				additionalProperties: false,
			},
			render: (_args, value): ContentBlock[] => {
				const status = (value as { status?: unknown }).status;
				return [
					{
						type: "text",
						text: typeof status === "string" ? status : String(value),
					},
				];
			},
		},
		execute: async (): Promise<{ status: string }> => {
			const status = await readStatus();
			return { status: budgetStatusText(status) };
		},
		// Pure read of shared state; parallel sibling calls are safe.
		isConcurrencySafe: () => true,
	};
}

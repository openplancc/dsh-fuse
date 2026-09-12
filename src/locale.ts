/**
 * Notice strings for the in-session alerts, localized to the harness's own
 * locale (ADR-0020 polish): the notices live in the CONVERSATION, which
 * follows the harness UI language — not the panel's. The harness ships
 * `zh`/`en` only and falls back to `en` when no preference is stored and the
 * browser names no shipped language (its own `FALLBACK_LOCALE` rule).
 *
 * The locale is read structurally through `ctx.get("settings")` —
 * `settingsNamespace("locale")` → `{ preference?: "zh" | "en" }` — the same
 * optional-service probe the plugin uses for `tokenMeter`/`llm`, so an absent
 * settings service never blocks boot (it degrades to `en`).
 */

import type { Context } from "@deepseek-ai/cordis";

export type NoticeLocale = "en" | "zh";

/** Read the harness's stored locale preference; `en` when unavailable. */
export function harnessLocale(ctx: Context): NoticeLocale {
	try {
		const settings = ctx.get?.("settings") as
			| { get: (ns: unknown) => unknown }
			| undefined;
		if (!settings?.get) return "en";
		// SettingsNamespace is a compile-time brand over the raw id; the
		// registrations Map keys on the string at runtime.
		const section = settings.get("locale" as never) as
			| { preference?: unknown }
			| undefined;
		return section?.preference === "zh" ? "zh" : "en";
	} catch {
		return "en";
	}
}

/** The one-line collapsed summaries + expandable text, per locale. */
export interface NoticeStrings {
	/** Local budget cut (the fuse rejected the step). */
	cutSummary: string;
	cutDetail: string;
	/** Remote (SaaS 429) block. */
	blockSummary: string;
	blockDetail: string;
	/** Device-token revocation (session notice on next step). */
	revokedSummary: string;
	revokedDetail: string;
}

export function noticeStrings(locale: NoticeLocale): NoticeStrings {
	return locale === "zh"
		? {
				cutSummary: "fuse: 预算超限，已拦截本次调用",
				cutDetail:
					"fuse 在消耗 token 前拦截了本次调用（规则：budget_exceeded）。如需调整预算请修改 cordis.patch.yml，或用 dsh_budget_status 查看状态；限额会在窗口结束时重置。",
				blockSummary: "fuse: 控制面板已拦截调用（预算超限）",
				blockDetail:
					"控制面板已拦截此范围的调用（规则：${rule}）。限制持续到 ${resetAt}——本地 fuse 保持启用，期间不会产生 token 消耗。",
				revokedSummary: "fuse: 与控制面板的连接已撤销",
				revokedDetail:
					"设备令牌已在控制面板撤销——此 profile 已回到本地模式（不同步，fuse 保持启用）。如需重新连接，运行 `dsh plugin --profile <perfil> exec dsh-fuse-connect`。未同步的记录已保留。",
			}
		: {
				cutSummary: "fuse: call cut — budget reached",
				cutDetail:
					"The fuse blocked the call before spending tokens (rule: budget_exceeded). Adjust the budget in cordis.patch.yml or use dsh_budget_status to see the status; the limit resets at the end of the window.",
				blockSummary: "fuse: calls blocked (panel budget)",
				blockDetail:
					"The panel blocked calls in this scope (rule: ${rule}). The block lasts until ${resetAt} — the local fuse stays active and no tokens are spent meanwhile.",
				revokedSummary: "fuse: panel connection revoked",
				revokedDetail:
					"The device token was revoked in the panel — this profile is back to local-only (nothing syncs, the fuse stays active). Reconnect with `dsh plugin --profile <perfil> exec dsh-fuse-connect` when you want. Unsynced rows were retained.",
			};
}

/** Format a template containing `${name}` placeholders. */
export function format(template: string, vars: Record<string, string>): string {
	return template.replace(
		/\$\{(\w+)\}/g,
		(match, name: string) => vars[name] ?? match,
	);
}

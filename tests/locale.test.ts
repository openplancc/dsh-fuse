/**
 * Notice localization (ADR-0020 polish): the in-session notices follow the
 * harness UI language (zh/en, en fallback — the harness's own FALLBACK_LOCALE
 * rule), not the panel's. The strings must exist for both shipped locales and
 * degrade to `en` when no settings service / preference is present.
 */
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import { format, harnessLocale, noticeStrings } from "../src/locale.js";

describe("harnessLocale — read the conversation language", () => {
	it("defaults to en when no settings service is mounted", () => {
		const ctx = new Context(); // no settings provider
		expect(harnessLocale(ctx)).toBe("en");
	});

	it("reads an explicit zh preference", () => {
		const ctx = new Context();
		(ctx as unknown as { get: unknown }).get = (name: string) =>
			name === "settings" ? { get: () => ({ preference: "zh" }) } : undefined;
		expect(harnessLocale(ctx)).toBe("zh");
	});

	it("reads an explicit en preference", () => {
		const ctx = new Context();
		(ctx as unknown as { get: unknown }).get = (name: string) =>
			name === "settings" ? { get: () => ({ preference: "en" }) } : undefined;
		expect(harnessLocale(ctx)).toBe("en");
	});

	it("treats an absent preference as en (browser delegates, en fallback)", () => {
		const ctx = new Context();
		(ctx as unknown as { get: unknown }).get = (name: string) =>
			name === "settings" ? { get: () => ({}) } : undefined;
		expect(harnessLocale(ctx)).toBe("en");
	});
});

describe("noticeStrings — both shipped locales", () => {
	it("provides en strings for every notice kind", () => {
		const s = noticeStrings("en");
		expect(s.cutSummary).toContain("cut");
		expect(s.blockSummary).toContain("block");
		expect(s.revokedSummary).toContain("revok");
		expect(s.cutDetail.length).toBeGreaterThan(20);
		expect(s.blockDetail.length).toBeGreaterThan(20);
		expect(s.revokedDetail.length).toBeGreaterThan(20);
	});

	it("provides zh strings for every notice kind", () => {
		const s = noticeStrings("zh");
		expect(s.cutSummary).toContain("fuse");
		expect(s.blockSummary).toContain("fuse");
		expect(s.revokedSummary).toContain("fuse");
		expect(s.cutDetail.length).toBeGreaterThan(20);
		expect(s.blockDetail.length).toBeGreaterThan(20);
		expect(s.revokedDetail.length).toBeGreaterThan(20);
	});

	it("keeps the two locales' key sets identical (no missing keys either way)", () => {
		const en = noticeStrings("en");
		const zh = noticeStrings("zh");
		expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort());
	});
});

describe("format — ${name} placeholder substitution", () => {
	it("substitutes named placeholders", () => {
		expect(
			format("rule ${rule} until ${resetAt}", { rule: "x", resetAt: "y" }),
		).toBe("rule x until y");
	});

	it("leaves unknown placeholders intact", () => {
		expect(format("rule ${missing}", { rule: "x" })).toBe("rule ${missing}");
	});
});

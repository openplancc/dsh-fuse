/**
 * Credential storage (ADR-0020): the device token file the connect CLI writes
 * and the runtime reads. The file must round-trip, be 0600, and tolerate
 * absence/corruption (offline-first: a missing file is "local-only", never a
 * crash).
 */
import {
	existsSync,
	mkdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCredentials,
	credentialsFile,
	loadCredentials,
	saveCredentials,
} from "../src/credentials.js";

/** Point the store at a throwaway dir for the duration of each test. */
let home: string;
let originalHome: string | undefined;

beforeEach(() => {
	home = join(
		tmpdir(),
		`dsh-cred-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(home, { recursive: true });
	originalHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
});

afterEach(() => {
	if (originalHome === undefined) delete process.env.DSH_HOME;
	else process.env.DSH_HOME = originalHome;
	rmSync(home, { recursive: true, force: true });
});

describe("credentials — the device-token store", () => {
	it("round-trips a saved credential", () => {
		saveCredentials({
			baseUrl: "https://dsh-api.example.test",
			token: "dshd_token",
			connectedAt: "2026-09-12T00:00:00.000Z",
		});
		const loaded = loadCredentials();
		expect(loaded).toEqual({
			baseUrl: "https://dsh-api.example.test",
			token: "dshd_token",
			connectedAt: "2026-09-12T00:00:00.000Z",
		});
	});

	it("persists the file with 0600 permissions", () => {
		saveCredentials({
			baseUrl: "https://dsh-api.example.test",
			token: "dshd_token",
			connectedAt: "2026-09-12T00:00:00.000Z",
		});
		const mode = statSync(credentialsFile()).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("returns null when the file is absent (local-only is the default posture)", () => {
		expect(loadCredentials()).toBeNull();
	});

	it("returns null on a corrupt file instead of throwing", () => {
		mkdirSync(join(credentialsFile(), ".."), { recursive: true });
		writeFileSync(credentialsFile(), "{not json", { mode: 0o600 });
		expect(loadCredentials()).toBeNull();
	});

	it("clears the credential by moving it aside", () => {
		saveCredentials({
			baseUrl: "https://dsh-api.example.test",
			token: "dshd_token",
			connectedAt: "2026-09-12T00:00:00.000Z",
		});
		clearCredentials();
		expect(loadCredentials()).toBeNull();
		// The revoked copy survives for forensics.
		expect(existsSync(`${credentialsFile()}.revoked`)).toBe(true);
	});
});

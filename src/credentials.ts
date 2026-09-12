/**
 * Machine credentials for the SaaS (ADR-0020): the device token minted by
 * `dsh plugin connect`. Stored as a 0600 JSON file under the harness home —
 * the same directory that already owns the ledger (`local.db`) and the same
 * degradation gh uses when no OS keychain exists. An OS-keychain backend
 * (e.g. @napi-rs/keyring) is a documented future option; the plugin's
 * zero-native-build distribution promise is why the file store ships first.
 *
 * Resolution order in the runtime: credentials file → configured
 * `orgKey`/`baseUrl` (env or YAML) → local-only. The file wins because it is
 * the human-attached identity; the config pair stays the headless/CI path.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What the connect command persists after a successful device flow. */
export interface DeviceCredentials {
	baseUrl: string;
	token: string;
	/** Human-readable hint of who authorized (display only, from the API). */
	userHint?: string;
	connectedAt: string;
}

/** Resolve the harness home the same way the store does (DSH_HOME → ~/.dsh). */
export function dshHome(): string {
	const override = process.env.DSH_HOME?.trim();
	return override ? override : homedir();
}

/** The credentials file the plugin and the connect CLI both use. */
export function credentialsFile(): string {
	return join(dshHome(), ".dsh", "dsh-fuse", "credentials.json");
}

/** Read the machine credentials; `null` when absent or unreadable. */
export function loadCredentials(): DeviceCredentials | null {
	const file = credentialsFile();
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const { baseUrl, token } = parsed as Record<string, unknown>;
		if (typeof baseUrl !== "string" || !baseUrl) return null;
		if (typeof token !== "string" || !token) return null;
		const connectedAt =
			typeof (parsed as Record<string, unknown>).connectedAt === "string"
				? ((parsed as Record<string, unknown>).connectedAt as string)
				: new Date().toISOString();
		const userHint =
			typeof (parsed as Record<string, unknown>).userHint === "string"
				? ((parsed as Record<string, unknown>).userHint as string)
				: undefined;
		return { baseUrl, token, connectedAt, ...(userHint ? { userHint } : {}) };
	} catch {
		return null;
	}
}

/**
 * Persist machine credentials atomically (temp + rename) with 0600 perms —
 * the write path for `dsh plugin connect`.
 */
export function saveCredentials(input: DeviceCredentials): void {
	const file = credentialsFile();
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(input, null, 2)}\n`, {
		mode: 0o600,
	});
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
	// renameSync keeps the temp's mode, but re-assert for filesystems that
	// lose it on move.
	chmodSync(file, 0o600);
}

/** Clear the machine credentials — the `disconnect` command / 401 path. */
export function clearCredentials(): void {
	try {
		const file = credentialsFile();
		if (existsSync(file)) renameSync(file, `${file}.revoked`);
	} catch {
		// Nothing to do if the file (or dir) is gone.
	}
}

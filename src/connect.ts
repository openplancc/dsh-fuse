#!/usr/bin/env node
/**
 * `dsh plugin connect` — the RFC 8628 device-flow CLI (ADR-0020 default).
 *
 * Runs in the user's terminal, never on the boot path:
 *   1. calls `POST {base}/v1/device-auth` and prints the verification URI;
 *   2. polls `POST {base}/v1/device-auth/token` until the user approves in
 *      the browser (or the code expires/denies);
 *   3. persists the returned device token via `saveCredentials`
 *      (0600 file under ~/.dsh/dsh-fuse/, keychain documented as a future
 *      backend), so the plugin's next boot syncs with the SaaS.
 *
 * The org key (`orgKey` in config/env) remains the headless/CI path — this
 * command is the interactive default. Standard CLI hygiene: only prints the
 * verifiable URI + code, never the token; supports `--clipboard` to copy the
 * code (like `gh auth login -c`).
 */

import { spawnSync } from "node:child_process";
import { saveCredentials } from "./credentials.js";

const DEFAULT_BASE_URL = "https://dsh-api.openplan.cc";
const POLL_INTERVAL_MS = 5_000;

function usage(): never {
	console.error(
		[
			"usage: dsh plugin --profile <perfil> exec connect [options]",
			"",
			"options:",
			`  --base-url <url>   SaaS API base (default ${DEFAULT_BASE_URL})`,
			"  --clipboard        copy the device code to the clipboard",
			"  --help             show this help",
		].join("\n"),
	);
	process.exit(2);
}

function parseArgs(argv: string[]): { baseUrl: string; clipboard: boolean } {
	let baseUrl = DEFAULT_BASE_URL;
	let clipboard = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--base-url") {
			const value = argv[i + 1];
			if (!value || value.startsWith("-")) usage();
			baseUrl = value;
			i += 1;
		} else if (arg === "--clipboard") {
			clipboard = true;
		} else if (arg === "--help" || arg === "-h") {
			usage();
		} else {
			usage();
		}
	}
	return { baseUrl, clipboard };
}

async function copyToClipboard(text: string): Promise<boolean> {
	try {
		const command =
			process.platform === "darwin"
				? "pbcopy"
				: process.platform === "win32"
					? "clip"
					: "xclip";
		const result = spawnSync(command, [], {
			input: text,
			encoding: "utf8",
		});
		return result.status === 0;
	} catch {
		return false;
	}
}

/** Poll the token endpoint following RFC 8628 §3.3 until it yields. */
async function pollToken(
	baseUrl: string,
	deviceCode: string,
): Promise<{ token: string }> {
	for (;;) {
		const res = await fetch(`${baseUrl}/v1/device-auth/token`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ device_code: deviceCode }),
		});
		if (res.status === 200) {
			const body = (await res.json()) as { access_token?: string };
			if (!body.access_token) {
				throw new Error("token exchange returned no access_token");
			}
			return { token: body.access_token };
		}
		const body = (await res.json().catch(() => ({}))) as { error?: string };
		if (body.error === "authorization_pending") {
			await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
			continue;
		}
		if (body.error === "slow_down") {
			await new Promise((resolve) =>
				setTimeout(resolve, POLL_INTERVAL_MS + 5_000),
			);
			continue;
		}
		throw new Error(
			body.error === "expired"
				? "o código expirou — rode `dsh plugin connect` de novo"
				: body.error === "denied"
					? "autorização negada"
					: `falha na troca do código (${body.error ?? res.status})`,
		);
	}
}

async function main(argv: string[]): Promise<void> {
	const { baseUrl, clipboard } = parseArgs(argv);

	const issued = (await (
		await fetch(`${baseUrl}/v1/device-auth`, { method: "POST" })
	).json()) as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
	};
	if (!issued.device_code || !issued.user_code) {
		throw new Error("device-auth não retornou códigos — API compatível?");
	}

	process.stdout.write(
		[
			"",
			"┌────────────────────────────────────────────────────────┐",
			"│  Conecte esta máquina ao dsh.openplan.cc              │",
			"└────────────────────────────────────────────────────────┘",
			"",
			`  1. Abra no navegador:  ${issued.verification_uri_complete ?? issued.verification_uri}`,
			`  2. Confirme o código:   ${issued.user_code}`,
			"",
		].join("\n"),
	);
	if (clipboard) {
		const copied = await copyToClipboard(issued.user_code);
		process.stdout.write(
			copied
				? "  → código copiado para a área de transferência.\n\n"
				: "  → (clipboard indisponível — copie manualmente)\n\n",
		);
	}

	// Prove we're alive while the browser approval is pending (the harness
	// turn may be the terminal that runs this — dot feedback is friendlier).
	let dots = 0;
	const pulse = setInterval(() => {
		dots += 1;
		process.stdout.write(`  aguardando aprovação${".".repeat(dots)}\r`);
	}, POLL_INTERVAL_MS);

	try {
		const { token } = await pollToken(baseUrl, issued.device_code);
		clearInterval(pulse);
		process.stdout.write("\n  ✓ conectado — token salvo com segurança.\n\n");
		const userHint = undefined as string | undefined; // the API returns no name yet
		saveCredentials({
			baseUrl,
			token,
			connectedAt: new Date().toISOString(),
			...(userHint ? { userHint } : {}),
		});
	} finally {
		clearInterval(pulse);
	}
}

// Run only when executed directly (`node dist/connect.js` / the bin entry),
// never when the module is imported by the plugin or tests.
const isDirectRun =
	process.argv[1] !== undefined &&
	import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
	main(process.argv.slice(2)).catch((error: unknown) => {
		console.error(
			`conexão falhou: ${error instanceof Error ? error.message : String(error)}`,
		);
		process.exit(1);
	});
}

export { main };

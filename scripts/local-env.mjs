import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function loadLocalEnv() {
	const path = resolve(root, '.env');
	if (!existsSync(path)) return;
	const text = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
	for (const line of text.split(/\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;
		const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
		const eq = body.indexOf('=');
		if (eq < 1) continue;
		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		if (process.env[key]) continue;
		let value = body.slice(eq + 1).trim();
		const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
		if (quoted && value.length >= 2) value = value.slice(1, -1);
		process.env[key] = value;
	}
}

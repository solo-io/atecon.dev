const SECRET = /spreadsheets\/d\/|sessionize\.com|BEGIN (?:RSA |OPENSSH |EC |PGP )?PRIVATE KEY|"private_key"|service_account|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-|ghp_|github_pat_|ya29\./i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const ALLOWED_EMAILS = new Set(['agent-substrate-day-2026@atecon.dev']);

export function redactSecrets(text) {
	let out = String(text || '')
		.replace(/spreadsheets\/d\/[^/\s"'?#]+/gi, 'spreadsheets/d/[redacted]')
		.replace(/AIza[0-9A-Za-z_-]{20,}/g, '[redacted]')
		.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted key]')
		.replace(/\b(?:ya29\.|xox[baprs]-|ghp_|github_pat_)[A-Za-z0-9._-]+/g, '[redacted]');
	for (const key of ['GCP_PROJECT', 'GOOGLE_APPLICATION_CREDENTIALS', 'SCHEDULE_SHEET_URL', 'RETL_ROOT', 'SCHEDULE_RANGE', 'SCHEDULE_ACCEPT_COLUMN']) {
		const value = process.env[key];
		if (value && value.length > 3) out = out.split(value).join('[redacted]');
	}
	return out;
}

export function assertPublicText(text, label) {
	if (SECRET.test(String(text || ''))) {
		console.error(`${label} contains a source identifier or credential. It was not written.`);
		process.exit(1);
	}
	const emails = String(text || '').match(EMAIL) || [];
	const bad = emails.filter((email) => !ALLOWED_EMAILS.has(email.toLowerCase()));
	if (bad.length) {
		console.error(`${label} contains an email address. It was not written.`);
		process.exit(1);
	}
}

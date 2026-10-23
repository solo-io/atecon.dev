// Check that atecon.dev Cloud DNS still points at GitHub Pages, and that the
// repo's Pages build is using that domain.
//
//   node scripts/check-domain.mjs
//   node scripts/check-domain.mjs joshuaNjordan85/atecon.dev
//
// Set GOOGLE_APPLICATION_CREDENTIALS to read the Cloud DNS zone. Do not commit that key.

import { inspectDomain, parseRepo } from './domain-lib.mjs';

const arg = process.argv.slice(2).find((item) => !item.startsWith('--'));
if (process.argv.includes('--help') || (arg && !parseRepo(arg))) {
	console.log('Usage: node scripts/check-domain.mjs [owner/repo]');
	process.exit(arg ? 2 : 0);
}

const report = inspectDomain({ repo: arg ? parseRepo(arg) : null });
console.log(report.lines.join('\n'));
process.exit(report.failures ? 1 : 0);

// Point a GitHub repository's Pages build at the atecon.dev zone in Cloud DNS.
//
//   node scripts/connect-pages.mjs owner/repo
//   node scripts/connect-pages.mjs owner/repo --apply
//   node scripts/connect-pages.mjs owner/repo --apply --apply-dns
//
// Without --apply this only prints what would change.
// --apply turns on the workflow build and sets the Pages domain to atecon.dev.
// --apply-dns rewrites the apex A/AAAA records and the www CNAME in Cloud DNS.
// Push .github/workflows/pages.yml to the default branch before --apply.
// Set GOOGLE_APPLICATION_CREDENTIALS to change DNS. Do not commit that key.

import { spawnSync } from 'node:child_process';
import { applyCloudDns, DOMAIN, ghApi, inspectDomain, parseRepo } from './domain-lib.mjs';

const args = process.argv.slice(2);
const repoArg = args.find((item) => !item.startsWith('--'));
const apply = args.includes('--apply');
const applyDns = args.includes('--apply-dns');
const repo = parseRepo(repoArg);

if (!repo || args.includes('--help')) {
	console.log('Usage: node scripts/connect-pages.mjs owner/repo [--apply] [--apply-dns]');
	process.exit(repoArg ? 2 : 0);
}

const report = inspectDomain({ repo });
console.log(report.lines.join('\n'));

const repoMissing = report.lines.some((line) => line.includes('is not visible to gh'));
const workflowMissing = report.lines.some((line) => line.startsWith('fail  pages.yml is not'));
const dnsBroken = report.lines.some((line) => /^fail  (atecon\.dev A|www\.atecon\.dev)/.test(line));

if (apply && repoMissing) {
	console.error('\nThe repository is not visible to gh. Create it and push this folder before --apply.');
	process.exit(1);
}
if (apply && workflowMissing) {
	console.error('\nPush .github/workflows/pages.yml before --apply.');
	process.exit(1);
}

if (applyDns) {
	console.log(`\n${apply ? 'Updating' : 'Would update'} Cloud DNS for ${repo.owner}/${repo.name}.`);
	if (!apply) {
		console.log(`www.${DOMAIN} would become ${repo.owner.toLowerCase()}.github.io if it differs.`);
		console.log('Re-run with --apply --apply-dns to write Cloud DNS.');
	} else {
		const wrote = applyCloudDns(repo.owner);
		console.log(wrote.lines.join('\n'));
		if (!wrote.ok) {
			console.error(wrote.error);
			process.exit(1);
		}
	}
}

const pages = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/pages`]);
const missing = pages.http === 404 || pages.json?.message === 'Not Found';
const branch = ghApi(['repo', 'view', `${repo.owner}/${repo.name}`, '--json', 'defaultBranchRef'])
	.json?.defaultBranchRef?.name || 'main';
const body = {
	cname: DOMAIN,
	build_type: 'workflow',
	source: { branch, path: '/' },
};

console.log(`\n${apply ? 'Setting' : 'Would set'} Pages on ${repo.owner}/${repo.name} to ${JSON.stringify(body)}.`);
if (!apply) {
	console.log('Re-run with --apply after pages.yml is on the default branch.');
	process.exit(report.failures ? 1 : 0);
}
if (report.lines.some((line) => line.startsWith('fail  Cloud DNS'))) {
	console.error('\nCloud DNS could not be read, so the domain was not confirmed.');
	process.exit(1);
}
if (dnsBroken && !applyDns) {
	console.error('\nCloud DNS does not match this repo. Re-run with --apply --apply-dns, or fix the zone first.');
	process.exit(1);
}

if (missing) {
	const created = ghApi(
		['api', '--method', 'POST', '--include', `repos/${repo.owner}/${repo.name}/pages`, '--input', '-'],
		JSON.stringify({ build_type: 'workflow', source: body.source }),
	);
	if (created.status !== 0 && created.http !== 201 && created.http !== 409) {
		console.error(created.text);
		process.exit(1);
	}
}

const updated = ghApi(
	['api', '--method', 'PUT', '--include', `repos/${repo.owner}/${repo.name}/pages`, '--input', '-'],
	JSON.stringify(body),
);
if (updated.status !== 0 && updated.http !== 204) {
	console.error(updated.text);
	process.exit(1);
}

let confirmed = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/pages`]);
const cert = confirmed.json?.https_certificate?.state;
console.log(`Pages domain ${confirmed.json?.cname || 'unset'}, build ${confirmed.json?.build_type || 'unset'}, certificate ${cert || 'missing'}.`);
if (cert === 'issued' && confirmed.json?.https_enforced !== true) {
	const https = ghApi(
		['api', '--method', 'PUT', '--include', `repos/${repo.owner}/${repo.name}/pages`, '--input', '-'],
		JSON.stringify({ ...body, https_enforced: true }),
	);
	if (https.status !== 0 && https.http !== 204) console.error(https.text);
	else console.log('HTTPS is enforced.');
} else if (cert !== 'issued') {
	console.log('atecon.dev stays unreachable in browsers until GitHub issues the certificate. .dev requires HTTPS.');
	spawnSync('sleep', ['3']);
	const health = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/pages/health`]);
	if (health.http === 202) console.log('GitHub accepted the domain check and has not finished it yet.');
	else if (health.json?.domain?.reason) console.log(health.json.domain.reason);
}

process.exit(0);

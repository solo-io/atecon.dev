// Shared checks for atecon.dev Cloud DNS and the GitHub Pages build.
// GitHub Pages addresses: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './local-env.mjs';
import { redactSecrets } from './public-guard.mjs';

loadLocalEnv();

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const DOMAIN = 'atecon.dev';
export const PROJECT = process.env.GCP_PROJECT || '';
export const ZONE = process.env.DNS_ZONE || 'atecon-dev';
export const PAGES_A = [
	'185.199.108.153',
	'185.199.109.153',
	'185.199.110.153',
	'185.199.111.153',
];
export const PAGES_AAAA = [
	'2606:50c0:8000::153',
	'2606:50c0:8001::153',
	'2606:50c0:8002::153',
	'2606:50c0:8003::153',
];

export function host(value) {
	return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

export function parseRepo(value) {
	const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(String(value ?? '').trim());
	if (!match) return null;
	return { owner: match[1], name: match[2] };
}

export function pagesHost(owner) {
	return `${owner.toLowerCase()}.github.io`;
}

function canonList(groups) {
	const result = spawnSync('python3', ['-c', `
import ipaddress, json, sys
def one(value):
    text = str(value).strip().rstrip('.')
    try:
        return str(ipaddress.ip_address(text))
    except ValueError:
        return text.lower()
print(json.dumps([[one(item) for item in group] for group in json.loads(sys.argv[1])]))
`, JSON.stringify(groups)], { encoding: 'utf8' });
	if (result.status !== 0) {
		throw new Error((result.stderr || 'Could not compare addresses').slice(0, 300));
	}
	return JSON.parse(result.stdout);
}

export function sameAddresses(actual, expected) {
	const [left, right] = canonList([actual, expected]);
	const a = [...left].sort();
	const b = [...right].sort();
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function clip(text) {
	return redactSecrets(text).slice(0, 500);
}

function run(cmd, args, { input, env } = {}) {
	return spawnSync(cmd, args, {
		encoding: 'utf8',
		input,
		env,
		maxBuffer: 4_000_000,
	});
}

export function gcloudEnv() {
	const env = { ...process.env };
	if (!env.GOOGLE_APPLICATION_CREDENTIALS) return { env, cleanup() {} };
	const dir = mkdtempSync(join(tmpdir(), 'atecon-gcloud-'));
	env.CLOUDSDK_CONFIG = dir;
	const auth = run('gcloud', [
		'auth', 'activate-service-account',
		'--key-file', env.GOOGLE_APPLICATION_CREDENTIALS,
		'--quiet',
	], { env });
	if (auth.status !== 0) {
		rmSync(dir, { recursive: true, force: true });
		const detail = clip(auth.stderr || auth.stdout || auth.error?.message || 'gcloud auth failed');
		return { env: null, cleanup() {}, error: detail };
	}
	return {
		env,
		cleanup() { rmSync(dir, { recursive: true, force: true }); },
	};
}

export function cloudRecordSets() {
	if (!PROJECT || !ZONE) return { ok: false, error: 'Set GCP_PROJECT and DNS_ZONE in .env.' };
	const scoped = gcloudEnv();
	if (scoped.error) return { ok: false, error: scoped.error };
	const listed = run('gcloud', [
		'dns', 'record-sets', 'list',
		'--project', PROJECT,
		'--zone', ZONE,
		'--format=json',
	], { env: scoped.env });
	scoped.cleanup();
	if (listed.error) return { ok: false, error: clip(listed.error.message) };
	if (listed.status !== 0) {
		return { ok: false, error: clip(listed.stderr || listed.stdout || 'gcloud dns failed') };
	}
	try {
		return { ok: true, records: JSON.parse(listed.stdout) };
	} catch {
		return { ok: false, error: 'Cloud DNS returned unreadable JSON' };
	}
}

export function recordsOf(records, name, type) {
	const wanted = host(name);
	const row = (records || []).find((item) => host(item.name) === wanted && item.type === type);
	return row ? (row.rrdatas || []).map(host) : [];
}

export function recordTtl(records, name, type) {
	const wanted = host(name);
	const row = (records || []).find((item) => host(item.name) === wanted && item.type === type);
	return row?.ttl || 300;
}

function dig(name, type) {
	const result = run('dig', ['+time=2', '+tries=1', '+short', name, type, '@8.8.8.8']);
	if (result.error) return { ok: false, error: result.error.message };
	if (result.status !== 0) {
		return { ok: false, error: (result.stderr || result.stdout || 'dig failed').slice(0, 240) };
	}
	const values = result.stdout.split('\n').map((line) => host(line)).filter(Boolean);
	return { ok: true, values };
}

export function ghApi(args, body) {
	const result = run('gh', args, { input: body });
	if (result.error) return { status: 127, json: null, text: result.error.message };
	const text = `${result.stdout || ''}\n${result.stderr || ''}`;
	let json = null;
	const start = text.indexOf('{');
	const end = text.lastIndexOf('}');
	if (start >= 0 && end > start) {
		try { json = JSON.parse(text.slice(start, end + 1)); } catch { json = null; }
	}
	const statusLine = text.match(/HTTP\/[\d.]+ (\d{3})/);
	return {
		status: result.status ?? 1,
		http: statusLine ? Number(statusLine[1]) : null,
		json,
		text: text.trim().slice(0, 900),
	};
}

export function applyCloudDns(owner) {
	if (!PROJECT || !ZONE) return { ok: false, error: 'Set GCP_PROJECT and DNS_ZONE in .env.', lines: [] };
	const scoped = gcloudEnv();
	if (scoped.error) return { ok: false, error: scoped.error, lines: [] };
	const listed = run('gcloud', [
		'dns', 'record-sets', 'list',
		'--project', PROJECT,
		'--zone', ZONE,
		'--format=json',
	], { env: scoped.env });
	if (listed.status !== 0) {
		scoped.cleanup();
		return { ok: false, error: clip(listed.stderr || listed.stdout || 'gcloud dns failed'), lines: [] };
	}
	const records = JSON.parse(listed.stdout);
	const wanted = [
		{ name: `${DOMAIN}.`, type: 'A', rrdatas: PAGES_A },
		{ name: `${DOMAIN}.`, type: 'AAAA', rrdatas: PAGES_AAAA },
		{ name: `www.${DOMAIN}.`, type: 'CNAME', rrdatas: [`${pagesHost(owner)}.`] },
	];
	const lines = [];
	for (const row of wanted) {
		const current = recordsOf(records, row.name, row.type);
		const same = row.type === 'CNAME'
			? current.length === 1 && current[0] === host(row.rrdatas[0])
			: sameAddresses(current, row.rrdatas);
		if (same) {
			lines.push(`ok    ${host(row.name)} ${row.type} already matches`);
			continue;
		}
		const exists = current.length > 0;
		const args = [
			'dns', 'record-sets', exists ? 'update' : 'create', row.name,
			'--project', PROJECT,
			'--zone', ZONE,
			'--type', row.type,
			`--ttl=${recordTtl(records, row.name, row.type)}`,
			`--rrdatas=${row.rrdatas.join(',')}`,
		];
		const wrote = run('gcloud', args, { env: scoped.env });
		if (wrote.status !== 0) {
			scoped.cleanup();
			return {
				ok: false,
				error: clip(wrote.stderr || wrote.stdout || `could not write ${row.type}`),
				lines,
			};
		}
		lines.push(`ok    set ${host(row.name)} ${row.type} to ${row.rrdatas.map(host).join(', ')}`);
	}
	scoped.cleanup();
	return { ok: true, lines };
}

export function readCnameFile() {
	try {
		return readFileSync(join(root, 'CNAME'), 'utf8').trim();
	} catch {
		return '';
	}
}

export function inspectDomain({ repo } = {}) {
	const lines = [];
	let failures = 0;
	const bad = (message) => { failures += 1; lines.push(`fail  ${message}`); };
	const good = (message) => lines.push(`ok    ${message}`);
	const note = (message) => lines.push(`note  ${message}`);

	const cname = readCnameFile();
	if (cname === DOMAIN) good(`CNAME file is ${DOMAIN}`);
	else bad(`CNAME file is ${cname || 'missing'}; it must be ${DOMAIN}`);

	const workflow = join(root, '.github/workflows/pages.yml');
	try {
		readFileSync(workflow);
		good('Pages workflow is .github/workflows/pages.yml');
	} catch {
		bad('Pages workflow is missing at .github/workflows/pages.yml');
	}

	const cloud = cloudRecordSets();
	let cloudRecords = [];
	if (!cloud.ok) {
		bad(`Cloud DNS could not be read. ${cloud.error}`);
		note('Set GCP_PROJECT, DNS_ZONE, and GOOGLE_APPLICATION_CREDENTIALS in .env.');
	} else {
		cloudRecords = cloud.records;
		const a = recordsOf(cloudRecords, DOMAIN, 'A');
		const aaaa = recordsOf(cloudRecords, DOMAIN, 'AAAA');
		const www = recordsOf(cloudRecords, `www.${DOMAIN}`, 'CNAME');
		if (sameAddresses(a, PAGES_A)) good(`${DOMAIN} A records are the four GitHub Pages addresses`);
		else bad(`${DOMAIN} A records are ${a.join(', ') || 'missing'}`);
		if (sameAddresses(aaaa, PAGES_AAAA)) good(`${DOMAIN} AAAA records are the four GitHub Pages addresses`);
		else bad(`${DOMAIN} AAAA records are ${aaaa.join(', ') || 'missing'}`);
		const wwwTarget = www[0] || '';
		if (!wwwTarget.endsWith('.github.io')) bad(`www.${DOMAIN} CNAME is ${wwwTarget || 'missing'}`);
		else if (repo && wwwTarget !== pagesHost(repo.owner)) {
			bad(`www.${DOMAIN} CNAME is ${wwwTarget}; this repo needs ${pagesHost(repo.owner)}`);
		} else good(`www.${DOMAIN} CNAME is ${wwwTarget}`);
	}

	const publicA = dig(DOMAIN, 'A');
	const publicAaaa = dig(DOMAIN, 'AAAA');
	const publicWww = dig(`www.${DOMAIN}`, 'CNAME');
	if (!publicA.ok || !publicAaaa.ok || !publicWww.ok) {
		note(`Public DNS lookup failed (${[publicA, publicAaaa, publicWww].find((item) => !item.ok)?.error || 'dig'}).`);
	} else if (cloud.ok) {
		const cloudA = recordsOf(cloudRecords, DOMAIN, 'A');
		const cloudAaaa = recordsOf(cloudRecords, DOMAIN, 'AAAA');
		const cloudWww = recordsOf(cloudRecords, `www.${DOMAIN}`, 'CNAME');
		if (sameAddresses(publicA.values, cloudA) && sameAddresses(publicAaaa.values, cloudAaaa) && host(publicWww.values[0]) === host(cloudWww[0])) {
			good('Public resolvers match Cloud DNS');
		} else note('Public resolvers do not match Cloud DNS yet.');
	}

	let pages = null;
	if (!repo) {
		note('GitHub Pages was not checked. Pass owner/repo once the repository exists.');
	} else {
		const viewed = ghApi(['repo', 'view', `${repo.owner}/${repo.name}`, '--json', 'defaultBranchRef,url']);
		if (viewed.status !== 0 || !viewed.json?.defaultBranchRef?.name) {
			bad(`GitHub repo ${repo.owner}/${repo.name} is not visible to gh`);
		} else {
			const branch = viewed.json.defaultBranchRef.name;
			good(`GitHub repo ${repo.owner}/${repo.name} default branch is ${branch}`);
			if (branch !== 'main') note('The Pages workflow runs on main. The repo default branch is not main.');
			const remoteWorkflow = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/contents/.github/workflows/pages.yml?ref=${encodeURIComponent(branch)}`]);
			if (remoteWorkflow.http === 200 || (remoteWorkflow.status === 0 && remoteWorkflow.json?.path)) {
				good('pages.yml is on the default branch');
			} else bad('pages.yml is not on the default branch yet. Push this folder before connecting the build.');
			pages = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/pages`]);
			if (pages.http === 404 || pages.json?.message === 'Not Found') {
				bad('GitHub Pages is not enabled for this repo');
			} else if (pages.status !== 0 && pages.http !== 200) {
				bad(`GitHub Pages lookup failed: ${pages.text.slice(0, 240)}`);
			} else {
				const body = pages.json || {};
				if (body.cname === DOMAIN) good(`Pages custom domain is ${DOMAIN}`);
				else bad(`Pages custom domain is ${body.cname || 'unset'}; it must be ${DOMAIN}`);
				if (body.build_type === 'workflow') good('Pages build type is workflow');
				else bad(`Pages build type is ${body.build_type || 'unset'}; it must be workflow`);
				const cert = body.https_certificate?.state || 'missing';
				if (cert === 'issued') good(`Pages certificate is ${cert}`);
				else note(`Pages certificate is ${cert}. atecon.dev will not open in browsers until it is issued, because .dev requires HTTPS.`);
				const health = ghApi(['api', '--include', `repos/${repo.owner}/${repo.name}/pages/health`]);
				if (health.http === 202) note('GitHub is still checking the domain.');
				else if (health.json?.domain) {
					const domain = health.json.domain;
					if (domain.is_valid && domain.is_pointed_to_github_pages_ip) good('GitHub domain health says the apex points at Pages');
					else bad(`GitHub domain health: ${domain.reason || 'the apex is not pointed at Pages'}`);
				}
			}
		}
	}

	return { failures, lines, records: cloudRecords, pages };
}

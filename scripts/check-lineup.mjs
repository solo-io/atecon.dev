// Check announced sessions for portraits, companies, company homepages, and sheet abstracts.
// Also check that the rendered page, JSON-LD, and llms.txt carry those facts.
// Prints one gap per line. Exits 1 when a gap must be fixed before publishing.
// An empty abstract cell is reported and does not fail the run.

import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadLocalEnv } from './local-env.mjs';
import { redactSecrets } from './public-guard.mjs';
import { orgUrls } from './orgs.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const siteRoot = resolve(here, '..');
const lineupRoot = process.env.LINEUP_ROOT ? resolve(process.env.LINEUP_ROOT) : siteRoot;

loadLocalEnv();

function fail(message) {
	console.error(redactSecrets(message));
	process.exit(1);
}

function clockRange(start, end) {
	const parse = (value) => {
		const match = String(value || '').trim().match(/^(\d{1,2}:\d{2})\s*(AM|PM)$/i);
		if (!match) return null;
		return { clock: match[1], meridiem: match[2].toUpperCase() };
	};
	const from = parse(start);
	const to = parse(end);
	if (!from || !to) return '';
	if (from.meridiem === to.meridiem) return `${from.clock}–${to.clock} ${to.meridiem}`;
	return `${from.clock} ${from.meridiem}–${to.clock} ${to.meridiem}`;
}

function abstractText(value) {
	return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function plain(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function slug(name) {
	return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function isTalk(what) {
	return /^(lightning|short talk|standard talk|extended talk)\b/i.test(String(what || ''));
}

const schedulePath = resolve(lineupRoot, 'data/schedule.json');
const htmlPath = resolve(lineupRoot, 'index.html');
const llmsPath = resolve(lineupRoot, 'llms.txt');
if (!existsSync(schedulePath) || !existsSync(htmlPath) || !existsSync(llmsPath)) {
	fail('The lineup check needs data/schedule.json, index.html, and llms.txt. Render the page first.');
}

const schedule = JSON.parse(readFileSync(schedulePath, 'utf8'));
const html = readFileSync(htmlPath, 'utf8');
const llms = readFileSync(llmsPath, 'utf8');
const schemaMatch = html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
if (!schemaMatch) fail('The page has no JSON-LD event.');
let schema;
try {
	schema = JSON.parse(schemaMatch[1]);
} catch {
	fail('The page JSON-LD is not readable.');
}
const subEvents = Array.isArray(schema.subEvent) ? schema.subEvent : [];
const rendererPath = resolve(lineupRoot, 'scripts/render.mjs');
const renderer = existsSync(rendererPath) ? readFileSync(rendererPath, 'utf8') : '';
const shipsPortraits = renderer.includes('person.image');

const sheetUrl = process.env.SCHEDULE_SHEET_URL || '';
const range = process.env.SCHEDULE_RANGE || '';
const acceptColumn = process.env.SCHEDULE_ACCEPT_COLUMN || '';
const retlRoot = process.env.RETL_ROOT || '';
if (!sheetUrl || !range || !acceptColumn || !retlRoot) fail('Missing schedule pull settings in .env.');
process.env.CREDS_IS_PATH = 'true';
const require = createRequire(resolve(retlRoot, 'package.json'));
const { GoogleSheetsrETL } = require(resolve(retlRoot, 'src/GOOGLESHEETS.js'));

let pulled;
try {
	const retl = new GoogleSheetsrETL(sheetUrl, null, { exportRange: range });
	pulled = (await retl.pull(range)).map((row) => {
		const out = {};
		for (const [key, value] of Object.entries(row)) {
			if (key === 'ingested_at' || key === 'run_id' || key.startsWith('_airbyte')) continue;
			if (value == null || String(value).trim() === '') continue;
			out[key] = String(value).trim();
		}
		return out;
	});
} catch (error) {
	fail(`The lineup check could not read the sheet. ${error?.message || error}`);
}

function companyName(value) {
	const text = String(value || '').trim();
	if (!text || /^n\/a$/i.test(text)) return '';
	const key = text.toLowerCase();
	if (key === 'nvidia') return 'NVIDIA';
	if (key === 'solo.io') return 'Solo.io';
	if (key === 'google') return 'Google';
	return text;
}

const companies = new Map();
const rosterHeader = pulled.findIndex((row) => row.Start === 'Name' && row.End === 'Company');
if (rosterHeader >= 0) {
	for (const row of pulled.slice(rosterHeader + 1)) {
		const name = String(row.Start || '').trim();
		const company = companyName(row.End);
		if (name && company) companies.set(name.toLowerCase(), company);
	}
}
let editorialOrgs = {};
const editorialPath = resolve(siteRoot, 'data/private/editorial.json');
if (existsSync(editorialPath)) {
	try {
		editorialOrgs = JSON.parse(readFileSync(editorialPath, 'utf8')).orgs || {};
	} catch {
		editorialOrgs = {};
	}
}

const byTime = new Map((schedule.rows || []).map((row) => [row.time, row]));
const gaps = [];
const notes = [];
const callouts = [];
const speakerDir = resolve(lineupRoot, 'assets/speakers');
const portraits = new Map();
if (existsSync(speakerDir)) {
	for (const file of readdirSync(speakerDir)) {
		if (!/^[a-z0-9-]+\.(jpe?g|png|webp)$/i.test(file)) continue;
		portraits.set(file.replace(/\.[^.]+$/, '').toLowerCase(), file);
	}
}

for (const row of pulled) {
	const time = clockRange(row.Start, row.End);
	if (!time || /^transition$/i.test(String(row.What || '').trim())) continue;
	const talk = isTalk(row.What);
	const confirmed = /^true$/i.test(String(row[acceptColumn] || '').trim());
	const title = String(row.Title || '').trim();
	const sameTime = (schedule.rows || []).filter((item) => item.time === time);
	const pub = sameTime.find((item) => title && item.title === title) || sameTime.find((item) => item.tbd !== true) || sameTime[0];
	if (talk && !confirmed) {
		const leaked = sameTime.find((item) => title && item.title === title && (item.speaker || item.abstract));
		if (leaked) gaps.push(`column I did not confirm: ${time} ${title}`);
		continue;
	}
	if (!confirmed) continue;
	const sheetAbstract = abstractText(row.Abstract);
	if (!sheetAbstract) {
		if (talk) {
			callouts.push({
				kind: 'No abstract',
				time,
				speaker: pub?.speaker || String(row['Speaker(s)'] || '').trim(),
				title: pub?.title || title,
				org: pub?.org || '',
			});
		}
		continue;
	}
	if (!pub || pub.tbd === true || pub.abstract !== sheetAbstract) {
		gaps.push(`abstract mismatch: ${time}${title ? ` ${title}` : ''}`);
		continue;
	}
	const text = plain(sheetAbstract);
	const described = subEvents.some((item) => plain(item.description) === text);
	if (!described) gaps.push(`json-ld missing abstract: ${time}`);
	if (!llms.includes(text)) gaps.push(`llms.txt missing abstract: ${time}`);
}

for (const row of schedule.rows || []) {
	if (row.tbd === true || !row.speaker) continue;
	const names = String(row.speaker).split(',').map((part) => part.trim()).filter(Boolean);
	const orgs = String(row.org || '').split(',').map((part) => part.trim()).filter(Boolean);
	for (const name of names) {
		const expected = editorialOrgs[name] || companies.get(name.toLowerCase()) || '';
		if (!expected && !orgs.length) {
			callouts.push({ kind: 'No company', time: row.time, speaker: name, title: row.title || '', org: '' });
		}
		else if (expected && !orgs.includes(expected)) gaps.push(`company missing: ${row.time} ${name}`);
	}
	for (const org of orgs) {
		if (!orgUrls[org]) gaps.push(`company url missing: ${org}`);
	}
	for (const name of names) {
		const file = portraits.get(slug(name));
		if (!file) {
			callouts.push({ kind: 'No portrait', time: row.time, speaker: name, title: row.title || '', org: row.org || '' });
			continue;
		}
		const bytes = readFileSync(resolve(speakerDir, file));
		const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
		const png = bytes[0] === 0x89 && bytes[1] === 0x50;
		if (!jpeg && !png) gaps.push(`avatar unreadable: ${name}`);
		if (!shipsPortraits) continue;
		const person = subEvents.flatMap((item) => item.performer || []).find((item) => item.name === name);
		if (!person?.image || !String(person.image).endsWith(file)) gaps.push(`json-ld missing avatar: ${name}`);
	}
	if (shipsPortraits) {
		for (const org of orgs) {
			if (!orgUrls[org]) continue;
			const linked = subEvents.flatMap((item) => item.performer || []).some((person) => person.affiliation?.name === org && person.affiliation?.url === orgUrls[org]);
			if (!linked) gaps.push(`json-ld missing company url: ${org}`);
		}
	}
}

if (!shipsPortraits) {
	notes.push('The deploy checkout builds JSON-LD without portraits and company URLs. Merge scripts/render.mjs and scripts/orgs.mjs so the live page keeps them.');
}

function calloutLine(item) {
	const who = [item.speaker, item.org].filter(Boolean).join(', ');
	const what = [item.time, item.title].filter(Boolean).join(' — ');
	return `- ${[who, what].filter(Boolean).join(' — ')}`;
}

const unique = (items) => [...new Set(items)];
const kinds = ['No portrait', 'No abstract', 'No company'];
const sections = kinds.map((kind) => {
	const lines = callouts.filter((item) => item.kind === kind).map(calloutLine);
	return { kind, lines: unique(lines) };
}).filter((section) => section.lines.length);
const report = sections.length
	? ['# Schedule gaps', '', ...sections.flatMap((section) => [`## ${section.kind}`, '', ...section.lines, ''])].join('\n')
	: '# Schedule gaps\n\nNo missing portraits, abstracts, or companies.\n';
mkdirSync(resolve(siteRoot, 'data/private'), { recursive: true });
writeFileSync(resolve(siteRoot, 'data/private/lineup-callouts.md'), report);
console.log(report.trim());
for (const note of unique(notes)) console.log(note);
if (gaps.length) {
	for (const gap of unique(gaps)) console.error(gap);
	process.exit(1);
}
console.log('Lineup check passed.');

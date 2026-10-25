// Rebuild data/schedule.json from the local sheet settings in .env.
// The sheet URL, acceptance column, rETL path, and credentials stay out of git.
// Speaker aliases live in data/private/editorial.json, which is gitignored.
// { "speakers": { "raw name": "Public Name" }, "orgs": { "Public Name": "Org" } }

import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripPublishedImages } from './image-meta.mjs';
import { loadLocalEnv } from './local-env.mjs';
import { assertPublicText, redactSecrets } from './public-guard.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.env.LINEUP_ROOT
	? resolve(process.env.LINEUP_ROOT)
	: resolve(here, '..');
const schedulePath = resolve(root, 'data/schedule.json');
const speakersDir = resolve(root, 'assets/speakers');
const privateDir = resolve(root, 'data/private/speakers');
const portraitName = /^[a-z0-9-]+\.(jpe?g|png|webp)$/i;
const rowKeys = new Set(['time', 'what', 'tbd', 'speaker', 'org', 'title', 'abstract', 'photos']);

loadLocalEnv();

function fail(message) {
	console.error(redactSecrets(message));
	process.exit(1);
}

function publicWhat(value) {
	const text = String(value || '').trim();
	const key = text.toLowerCase();
	if (key === 'intro & logisitics') return 'Intro & logistics';
	if (/^lightning\b/.test(key)) return '5 min';
	if (/^short talk\b/.test(key)) return '10 min';
	if (/^standard talk\b/.test(key)) return '20 min';
	if (/^extended talk\b/.test(key)) return '30 min';
	if (/^wrap up\b/.test(key)) return 'Wrap up';
	return text;
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

function companyName(value) {
	const text = String(value || '').trim();
	if (!text || /^n\/a$/i.test(text)) return '';
	const key = text.toLowerCase();
	if (key === 'nvidia') return 'NVIDIA';
	if (key === 'solo.io') return 'Solo.io';
	if (key === 'google') return 'Google';
	return text;
}

function speakerName(value, editorial) {
	const text = String(value || '').trim();
	if (!text) return '';
	const whole = editorial.speakers[text.toLowerCase()];
	if (whole) return whole;
	return text.split(',').map((part) => {
		const trimmed = part.trim();
		return editorial.speakers[trimmed.toLowerCase()] || trimmed;
	}).filter(Boolean).join(', ');
}

function abstractText(value) {
	return String(value || '').replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function companiesFrom(rows) {
	const header = rows.findIndex((row) => row.Start === 'Name' && row.End === 'Company');
	const map = new Map();
	if (header < 0) return map;
	for (const row of rows.slice(header + 1)) {
		const name = String(row.Start || '').trim();
		const company = companyName(row.End);
		if (!name || !company) continue;
		map.set(name.toLowerCase(), company);
	}
	return map;
}

function orgFor(speaker, companies, editorial) {
	const override = editorial.orgs[speaker];
	if (override) return override;
	const direct = companies.get(String(speaker || '').trim().toLowerCase());
	if (direct) return direct;
	const parts = String(speaker || '').split(',').map((part) => part.trim()).filter(Boolean);
	const orgs = [];
	for (const part of parts) {
		const org = companies.get(part.toLowerCase());
		if (org && !orgs.includes(org)) orgs.push(org);
	}
	return orgs.join(', ');
}

function slug(name) {
	return String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function portraitsIn(dir) {
	const found = new Map();
	let names = [];
	try {
		names = await readdir(dir);
	} catch {
		return found;
	}
	for (const file of names) {
		if (!portraitName.test(file)) continue;
		found.set(file.replace(/\.[^.]+$/, '').toLowerCase(), file);
	}
	return found;
}

async function photosFor(speaker) {
	const photos = [];
	const published = await portraitsIn(speakersDir);
	const held = await portraitsIn(privateDir);
	for (const part of String(speaker || '').split(',')) {
		const name = part.trim();
		const key = slug(name);
		if (!key) continue;
		const file = published.get(key) || held.get(key);
		if (!file) continue;
		if (!published.has(key)) {
			await mkdir(speakersDir, { recursive: true });
			await copyFile(resolve(privateDir, file), resolve(speakersDir, file));
		}
		const src = `assets/speakers/${file}`;
		if (!photos.some((photo) => photo.src === src)) photos.push({ name, src });
	}
	return photos;
}

async function shelveUnreferenced(rows) {
	const used = new Set();
	for (const row of rows) {
		for (const photo of row.photos || []) {
			const base = String(photo?.src || '').split('/').pop();
			if (portraitName.test(base || '')) used.add(base);
		}
	}
	await mkdir(privateDir, { recursive: true });
	let moved = 0;
	for (const [key, file] of await portraitsIn(speakersDir)) {
		if (used.has(file)) continue;
		await rename(resolve(speakersDir, file), resolve(privateDir, file));
		moved += 1;
		void key;
	}
	return moved;
}

function publicRow(row) {
	const next = {};
	for (const key of rowKeys) {
		if (row[key] != null && row[key] !== '') next[key] = row[key];
	}
	if (next.tbd === true) return { time: next.time, what: publicWhat(next.what), tbd: true };
	next.what = publicWhat(next.what);
	if (Array.isArray(row.photos)) {
		next.photos = row.photos.filter((photo) => portraitName.test(String(photo?.src || '').split('/').pop() || '') && String(photo.src).startsWith('assets/speakers/') && !String(photo.src).includes('..'));
		if (!next.photos.length) delete next.photos;
	}
	return next;
}

async function loadEditorial() {
	try {
		const data = JSON.parse(await readFile(resolve(root, 'data/private/editorial.json'), 'utf8'));
		const speakers = {};
		for (const [key, value] of Object.entries(data.speakers || {})) {
			const name = String(value || '').trim();
			if (name) speakers[String(key).trim().toLowerCase()] = name;
		}
		const orgs = {};
		for (const [key, value] of Object.entries(data.orgs || {})) {
			const name = String(value || '').trim();
			if (name) orgs[String(key).trim()] = name;
		}
		return { speakers, orgs };
	} catch {
		return { speakers: {}, orgs: {} };
	}
}

async function readSchedule() {
	try {
		const data = JSON.parse(await readFile(schedulePath, 'utf8'));
		return Array.isArray(data.rows) ? data.rows.map(publicRow) : [];
	} catch {
		return [];
	}
}

function writeSchedule(rows) {
	const payload = { pulled_at: new Date().toISOString(), rows };
	const text = JSON.stringify(payload, null, 2) + '\n';
	assertPublicText(text, 'data/schedule.json');
	return writeFile(schedulePath, text);
}

const ignore = existsSync(resolve(root, '.gitignore')) ? await readFile(resolve(root, '.gitignore'), 'utf8') : '';
if (!/(^|\n)\.env(\n|$)/.test(ignore) || !ignore.includes('data/private/')) {
	fail('Refusing to pull until .gitignore excludes .env and data/private/.');
}

const sheetUrl = process.env.SCHEDULE_SHEET_URL || '';
const range = process.env.SCHEDULE_RANGE || '';
const acceptColumn = process.env.SCHEDULE_ACCEPT_COLUMN || '';
const retlRoot = process.env.RETL_ROOT || '';
const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS || '';
if (!sheetUrl || !range || !acceptColumn || !retlRoot || !creds) {
	fail('Missing schedule pull settings in .env. Copy .env.example and fill it in locally.');
}
if (creds.trim().startsWith('{')) fail('GOOGLE_APPLICATION_CREDENTIALS must be a file path, not inline JSON.');
if (!/\/spreadsheets\/d\/[^/]+/.test(sheetUrl)) fail('SCHEDULE_SHEET_URL must be a Google Sheet URL.');
if (!existsSync(creds) || !existsSync(retlRoot)) fail('A path in .env does not exist on this machine.');

const editorial = await loadEditorial();
const kept = await readSchedule();
await mkdir(resolve(root, 'data'), { recursive: true });
await writeSchedule(kept);
const shelvedFirst = await shelveUnreferenced(kept);
const strippedFirst = await stripPublishedImages(root);

process.env.CREDS_IS_PATH = 'true';
const require = createRequire(resolve(retlRoot, 'package.json'));
const { GoogleSheetsrETL } = require(resolve(retlRoot, 'src/GOOGLESHEETS.js'));

function clean(row) {
	const out = {};
	for (const [key, value] of Object.entries(row)) {
		if (key === 'ingested_at' || key === 'run_id' || key.startsWith('_airbyte')) continue;
		if (value == null || String(value).trim() === '') continue;
		out[key] = String(value).trim();
	}
	return out;
}

let pulled;
try {
	const retl = new GoogleSheetsrETL(sheetUrl, null, { exportRange: range });
	pulled = (await retl.pull(range)).map(clean).filter((row) => Object.keys(row).length > 0);
} catch (error) {
	fail(`The schedule pull failed. The public schedule was left in place. ${error?.message || error}`);
}

if (!pulled.some((row) => Object.prototype.hasOwnProperty.call(row, acceptColumn))) {
	fail('The acceptance column was not in the sheet. The public schedule was left in place.');
}

function isTalk(what) {
	return /^(lightning|short talk|standard talk|extended talk)\b/i.test(what);
}

const rows = [];
let held = 0;
for (const row of pulled) {
	const time = clockRange(row.Start, row.End);
	if (!time) continue;
	const what = publicWhat(row.What);
	if (/^transition$/i.test(String(row.What || '').trim())) continue;
	// Column I gates talks only. Intro, wrap, breaks, lunch, and the panel stay
	// even when that cell is blank. Their speakers still come from the sheet.
	if (isTalk(row.What) && !/^true$/i.test(String(row[acceptColumn] || '').trim())) {
		rows.push({ time, what, tbd: true });
		held += 1;
		continue;
	}
	const rawSpeaker = String(row['Speaker(s)'] || '').trim();
	const speaker = speakerName(rawSpeaker, editorial);
	const org = orgFor(rawSpeaker, companiesFrom(pulled), editorial) || orgFor(speaker, companiesFrom(pulled), editorial);
	const title = String(row.Title || '').trim();
	const abstract = abstractText(row.Abstract);
	const next = { time, what };
	if (speaker) next.speaker = speaker;
	if (org) next.org = org;
	if (title) next.title = title;
	if (abstract) next.abstract = abstract;
	const photos = await photosFor(speaker);
	if (photos.length) next.photos = photos;
	rows.push(next);
}

if (rows.length < 10) {
	fail(`Refusing to overwrite the public schedule. The sheet produced ${rows.length} public sessions.`);
}

await writeSchedule(rows);
const shelved = await shelveUnreferenced(rows);
const stripped = await stripPublishedImages(root);
console.log(`Wrote ${rows.length} sessions to data/schedule.json (${held} held as TBD, ${shelvedFirst + shelved} portraits held back, ${strippedFirst + stripped} images stripped of metadata)`);

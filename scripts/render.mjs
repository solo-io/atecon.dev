import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPublicText } from './public-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scheduleText = await readFile(resolve(root, 'data/schedule.json'), 'utf8');
assertPublicText(scheduleText, 'data/schedule.json');
const schedule = JSON.parse(scheduleText);
const rows = Array.isArray(schedule.rows) ? schedule.rows : [];

// The page stays out of search until the lineup is approved. Schema and llms.txt
// are still generated so the public facts are ready to be discovered.
const discoverable = false;
const siteUrl = 'https://atecon.dev/';
const registerUrl = 'https://luma.com/48hh3jo5';

const aliases = {
	time: ['time', 'start', 'start time', 'slot', 'when', 'session time'],
	speaker: ['speaker', 'name', 'speaker name', 'presenter'],
	role: ['role', 'job title', 'position', 'speaker title'],
	org: ['organization', 'org', 'company', 'affiliation', 'employer'],
	talk: ['talk', 'talk title', 'session title', 'session', 'abstract title', 'title'],
	abstract: ['abstract', 'description', 'details', 'subtitle', 'summary'],
	link: ['link', 'url', 'slides', 'recording', 'session link'],
	photo: ['photo', 'headshot', 'image', 'avatar', 'picture', 'photo url'],
};

function esc(value) {
	return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
		'&': '&amp;',
		'<': '&lt;',
		'>': '&gt;',
		'"': '&quot;',
		"'": '&#39;',
	}[ch]));
}

function safeUrl(value) {
	try {
		const url = new URL(String(value).trim());
		if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
	} catch {
		return '';
	}
	return '';
}

function take(row, names, used) {
	const keys = Object.keys(row);
	for (const name of names) {
		const key = keys.find((candidate) => candidate.trim().toLowerCase() === name && !used.has(candidate));
		if (!key) continue;
		const value = String(row[key] || '').trim();
		if (!value) continue;
		used.add(key);
		return value;
	}
	return '';
}

function portraitList(row, single, speaker) {
	const fromRow = Array.isArray(row.photos) ? row.photos : [];
	const items = fromRow.length
		? fromRow
		: (single ? [{ src: single, name: speaker || '' }] : []);
	return items.filter((item) => {
		const src = String(item?.src || '');
		return src.startsWith('assets/speakers/') && !src.includes('..');
	});
}

function publicFormat(what) {
	const key = String(what || '').trim().toLowerCase();
	if (/^lightning\b/.test(key)) return '5 min';
	if (/^short talk\b/.test(key)) return '10 min';
	if (/^standard talk\b/.test(key)) return '20 min';
	if (/^extended talk\b/.test(key)) return '30 min';
	if (/^wrap up\b/.test(key)) return 'Wrap up';
	return String(what || '').trim();
}

function abstractHtml(text) {
	const parts = String(text || '').replace(/\r\n/g, '\n').split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
	if (!parts.length) return '';
	const body = parts.map((part) => `<p>${esc(part).replace(/\n/g, '<br>')}</p>`).join('');
	return `<details class="abstract"><summary>Abstract</summary>${body}</details>`;
}

function sessionIso(time) {
	const same = String(time || '').match(/^(\d{1,2}:\d{2})–(\d{1,2}:\d{2})\s*(AM|PM)$/i);
	const split = String(time || '').match(/^(\d{1,2}:\d{2})\s*(AM|PM)–(\d{1,2}:\d{2})\s*(AM|PM)$/i);
	const stamp = (clock, meridiem) => {
		let [hour, minute] = clock.split(':').map(Number);
		const half = meridiem.toUpperCase();
		if (half === 'PM' && hour !== 12) hour += 12;
		if (half === 'AM' && hour === 12) hour = 0;
		return `2026-11-09T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-07:00`;
	};
	if (same) return [stamp(same[1], same[3]), stamp(same[2], same[3])];
	if (split) return [stamp(split[1], split[2]), stamp(split[3], split[4])];
	return [null, null];
}

function plain(value) {
	return String(value || '').replace(/\s+/g, ' ').trim();
}

function eventSchema() {
	const place = {
		'@type': 'Place',
		name: 'Sky SLC',
		address: {
			'@type': 'PostalAddress',
			streetAddress: '149 Pierpont Ave',
			addressLocality: 'Salt Lake City',
			addressRegion: 'UT',
			postalCode: '84101',
			addressCountry: 'US',
		},
	};
	const subEvent = rows.map((row, index) => {
		const [startDate, endDate] = sessionIso(row.time);
		const format = publicFormat(row.what || '');
		const item = {
			'@type': 'Event',
			'@id': `${siteUrl}#s-${index + 1}`,
			url: `${siteUrl}#s-${index + 1}`,
			eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
			eventStatus: 'https://schema.org/EventScheduled',
			location: place,
		};
		if (startDate) item.startDate = startDate;
		if (endDate) item.endDate = endDate;
		if (row.tbd === true) {
			item.name = 'TBD';
			item.description = format ? `${format}. Speaker to be announced.` : 'Speaker to be announced.';
			return item;
		}
		item.name = row.title || row.speaker || row.what || 'Session';
		if (row.abstract) item.description = plain(row.abstract);
		if (row.speaker) {
			const sharedOrg = row.org && !row.org.includes(',') ? row.org : '';
			item.performer = row.speaker.split(',').map((name) => ({
				'@type': 'Person',
				name: name.trim(),
				...(sharedOrg ? { affiliation: { '@type': 'Organization', name: sharedOrg } } : {}),
			})).filter((person) => person.name);
		}
		return item;
	});
	return {
		'@context': 'https://schema.org',
		'@type': 'Event',
		'@id': `${siteUrl}#event`,
		name: 'Agent Substrate Day',
		description: 'The community gathering for engineers building infrastructure for AI agents on Kubernetes, from Google, Solo.io, and the Agent Substrate community.',
		url: siteUrl,
		image: `${siteUrl}assets/sky-slc.jpg`,
		startDate: '2026-11-09T09:00:00-07:00',
		endDate: '2026-11-09T17:00:00-07:00',
		eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
		eventStatus: 'https://schema.org/EventScheduled',
		inLanguage: 'en',
		location: place,
		organizer: [
			{ '@type': 'Organization', name: 'Google', url: 'https://www.google.com/' },
			{ '@type': 'Organization', name: 'Solo.io' },
			{ '@type': 'Organization', name: 'Agent Substrate', url: 'https://github.com/agent-substrate/substrate' },
		],
		offers: {
			'@type': 'Offer',
			url: registerUrl,
			availability: 'https://schema.org/InStock',
		},
		subEvent,
	};
}

function llmsText() {
	const lines = [
		'# Agent Substrate Day',
		'',
		'> One-room community gathering for engineers building infrastructure for AI agents on Kubernetes. Monday, November 9, 2026, 9:00am–5:00pm America/Denver, at Sky SLC in Salt Lake City.',
		'',
	];
	if (!discoverable) {
		lines.push('The event page currently sends noindex, nofollow. This file is the public description prepared for when that changes. Talk slots marked TBD do not have an announced speaker.');
		lines.push('');
	}
	lines.push(
		'Hosted with Google, Solo.io, and the Agent Substrate community. One track, in one room.',
		'',
		'## Event',
		'',
		'- [Agent Substrate Day](https://atecon.dev/): the event page',
		'- [Register on Luma](https://luma.com/48hh3jo5): registration for the Monday event. Tuesday night details stay on the same page',
		'- Place: Sky SLC, 149 Pierpont Ave, Salt Lake City, UT 84101',
		'- Time: 9:00am–5:00pm America/Denver (MST, UTC−7)',
		'',
		'## Schedule',
		'',
	);
	for (const [index, row] of rows.entries()) {
		const href = `https://atecon.dev/#s-${index + 1}`;
		const format = publicFormat(row.what || '');
		if (row.tbd === true) {
			lines.push(`- [${row.time} — TBD${format ? `, ${format}` : ''}](${href})`);
			continue;
		}
		const title = row.title || (row.speaker ? '' : row.what);
		const label = [row.time, row.speaker, title].filter(Boolean).join(' — ');
		const detail = [row.org, plain(row.abstract)].filter(Boolean).join('. ');
		lines.push(`- [${label}](${href})${detail ? `: ${detail}` : ''}`);
	}
	lines.push(
		'',
		'## Project',
		'',
		'- [Agent Substrate](https://github.com/agent-substrate/substrate): the open source project',
		'- [CNCF Slack #substrate-users](https://cloud-native.slack.com/archives/C0B6RCAJULW): the community channel',
		'- [ate-dev](https://groups.google.com/g/ate-dev): the mailing list',
		'',
	);
	return lines.join('\n');
}

function sessionHtml(row, index) {
	const id = `s-${index + 1}`;
	if (row.tbd === true) {
		const format = publicFormat(row.what || '');
		return `<article class="session tbd" id="${id}">
        <p class="when">${esc(row.time || '')}</p>
        <div class="session-copy">
          ${format ? `<p class="format">${esc(format)}</p>` : ''}
          <div class="session-head"><h3>TBD</h3></div>
        </div>
      </article>`;
	}
	const used = new Set();
	const time = take(row, aliases.time, used);
	const speaker = take(row, aliases.speaker, used);
	const role = take(row, aliases.role, used);
	const org = take(row, aliases.org, used);
	const talk = take(row, aliases.talk, used);
	const abstract = take(row, aliases.abstract, used);
	const link = safeUrl(take(row, aliases.link, used));
	const photo = safeUrl(take(row, aliases.photo, used));
	const what = take(row, ['what', 'format', 'kind'], used);
	const roleLine = [role, org].filter(Boolean).join(', ');
	const hidden = new Set(['kind', 'sessionize', 'confirmed', 'duration', 'photos', 'tbd', 'what']);
	const extras = Object.entries(row).filter(([key, value]) => !used.has(key) && !hidden.has(key.trim().toLowerCase()) && (typeof value === 'string' || typeof value === 'number'));
	const marker = /^(break|lunch|transition)$/i.test(what) || (!speaker && !talk);
	const format = publicFormat(what);
	const heading = speaker || talk || what || 'Session';
	const photos = portraitList(row, photo, speaker);
	const photoHtml = photos.length
		? `<div class="portraits">${photos.map((item) => `<img class="portrait" src="${esc(item.src)}" alt="${esc(item.name)}">`).join('')}</div>`
		: '';
	const extraHtml = extras.map(([key, value]) => {
		const href = safeUrl(value);
		const body = href ? `<a href="${esc(href)}">${esc(value)}</a>` : esc(value);
		return `<p class="extra"><span>${esc(key)}</span> ${body}</p>`;
	}).join('');
	return `<article class="session${marker ? ' marker' : ''}" id="${id}">
        ${time ? `<p class="when">${esc(time)}</p>` : '<p class="when"></p>'}
        <div class="session-copy">
          ${format && format !== heading ? `<p class="format">${esc(format)}</p>` : ''}
          <div class="session-head">
            ${photoHtml}
            <h3>${esc(heading)}</h3>
          </div>
          ${roleLine ? `<p class="role">${esc(roleLine)}</p>` : ''}
          ${talk && talk !== heading ? `<p class="talk">${esc(talk)}</p>` : ''}
          ${abstractHtml(abstract)}
          ${link ? `<p class="session-link"><a href="${esc(link)}">Session link</a></p>` : ''}
          ${extraHtml}
        </div>
      </article>`;
}

const sessions = rows.length
	? rows.map(sessionHtml).join('\n')
	: '<p class="empty">Sessions, abstracts, and links will be listed here.</p>';
const jsonLd = JSON.stringify(eventSchema()).replace(/</g, '\\u003c');
const robots = discoverable ? '' : '  <meta name="robots" content="noindex, nofollow">\n';

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
${robots}  <title>Agent Substrate Day</title>
  <meta name="description" content="Agent Substrate Day, November 9, 2026, at Sky SLC in Salt Lake City. One room, one schedule, with the people building agent infrastructure on Kubernetes.">
  <script type="application/ld+json">${jsonLd}</script>
  <link rel="icon" href="assets/ate-logo-with-border.svg" type="image/svg+xml">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="styles.css?v=11">
  <script>
    window.HIVEMIND_ATTRIBUTION = {
      propertyKey: 'pk_5dc4bcfa84b8c0fb6e3875770fa7c385',
      apiBase: 'https://hivemind.solo.io',
      source: 'atecon'
    };
  </script>
  <script src="https://hivemind.solo.io/hivemind-attribution.js"></script>
</head>
<body>
  <header class="top">
    <p class="wordmark">Agent Substrate Day</p>
    <nav class="top-actions" aria-label="Links">
      <a class="icon-link" href="https://github.com/agent-substrate/substrate" aria-label="Agent Substrate on GitHub">
        <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
      <a class="icon-link" href="https://cloud-native.slack.com/archives/C0B6RCAJULW" aria-label="CNCF Slack, #substrate-users">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M6 15a2 2 0 0 1-2 2 2 2 0 0 1-2-2 2 2 0 0 1 2-2h2v2zm1 0a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-5zM9 6a2 2 0 0 1-2-2 2 2 0 0 1 2-2 2 2 0 0 1 2 2v2H9zm0 1a2 2 0 0 1 2 2 2 2 0 0 1-2 2H4a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5zm9 2a2 2 0 0 1 2-2 2 2 0 0 1 2 2 2 2 0 0 1-2 2h-2V9zm-1 0a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2 2 2 0 0 1 2 2v5zm-2 9a2 2 0 0 1 2 2 2 2 0 0 1-2 2 2 2 0 0 1-2-2v-2h2zm0-1a2 2 0 0 1-2-2 2 2 0 0 1 2-2h5a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-5z"/></svg>
      </a>
      <a class="icon-link" href="https://groups.google.com/g/ate-dev" aria-label="ate-dev mailing list">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path fill="none" stroke="currentColor" stroke-width="1.8" d="M4 7l8 6 8-6"/></svg>
      </a>
      <a class="register" href="https://luma.com/48hh3jo5">Register</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <div class="hero-copy">
        <p class="kicker">Monday, November 9, 2026</p>
        <h1>One room. One schedule.</h1>
        <p class="lede">The community gathering for engineers building infrastructure for AI agents on Kubernetes, from Google, Solo.io, and the Agent Substrate community.</p>
        <p class="facts">9:00am–5:00pm <span>·</span> Sky SLC, Salt Lake City</p>
        <p class="calendar"><span class="cal-label">Add to calendar</span> <a href="https://calendar.google.com/calendar/render?action=TEMPLATE&amp;text=Agent%20Substrate%20Day&amp;dates=20261109T160000Z/20261110T000000Z&amp;ctz=America/Denver&amp;location=Sky%20SLC%2C%20149%20Pierpont%20Ave%2C%20Salt%20Lake%20City%2C%20UT%2084101&amp;details=One%20room.%20One%20schedule.%20Register%3A%20https%3A%2F%2Fluma.com%2F48hh3jo5">Google</a> <a href="https://outlook.office.com/calendar/0/deeplink/compose?rru=addevent&amp;subject=Agent%20Substrate%20Day&amp;startdt=2026-11-09T16%3A00%3A00Z&amp;enddt=2026-11-10T00%3A00%3A00Z&amp;location=Sky%20SLC%2C%20149%20Pierpont%20Ave%2C%20Salt%20Lake%20City%2C%20UT%2084101&amp;body=One%20room.%20One%20schedule.%20Register%3A%20https%3A%2F%2Fluma.com%2F48hh3jo5">Outlook</a> <a href="agent-substrate-day.ics">Apple</a></p>
        <a class="register large" href="https://luma.com/48hh3jo5">Register on Luma</a>
      </div>
      <img class="yolo" src="assets/ate-logo-with-border.svg" alt="Yolo, the Agent Substrate octopus">
    </section>
    <section class="expect">
      <h2>What to expect</h2>
      <ul>
        <li>A single track. Nothing else is happening in another room.</li>
        <li>Talks from teams running agentic workloads on Kubernetes in production.</li>
        <li>Time with Agent Substrate and kagent maintainers.</li>
        <li>An update on project direction and roadmap.</li>
      </ul>
    </section>
    <section class="schedule" id="schedule">
      <h2>Sessions</h2>
      ${sessions}
    </section>
    <section class="cream">
      <p>More agents. Less overhead.</p>
    </section>
    <section class="place">
      <div class="place-copy">
        <h2>Sky SLC</h2>
        <p>149 Pierpont Ave<br>Salt Lake City, UT 84101</p>
        <p class="party">Tuesday night, after KubeCrawl + CloudNativeFest, the same community keeps going. Details stay on the Luma page.</p>
        <a href="https://luma.com/48hh3jo5">Luma page</a>
      </div>
    </section>
  </main>
  <footer>
    <p>Agent Substrate Day is hosted with Google, Solo.io, and the Agent Substrate community.</p>
  </footer>
</body>
</html>
`;

const llms = llmsText();
assertPublicText(html, 'index.html');
assertPublicText(llms, 'llms.txt');
await writeFile(resolve(root, 'index.html'), html);
await writeFile(resolve(root, 'llms.txt'), llms);
console.log(`Rendered index.html and llms.txt with ${rows.length} sessions`);

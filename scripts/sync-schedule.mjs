// Publish a clean sheet pull as a pull request into main.
// main is protected, so this never pushes that branch directly.
// The checkout you are editing is left alone.
// Stops with no commit and no pull request unless every check passes.

import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, symlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicTextProblem, redactSecrets } from './public-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const publishRoot = resolve(root, '../atecon.dev-publish');
const allowedExact = new Set(['data/schedule.json', 'index.html', 'llms.txt']);

function fail(message) {
	console.error(redactSecrets(message));
	process.exit(1);
}

function git(cwd, args) {
	const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
	if (result.error) fail(result.error.message);
	return result;
}

function gitOk(cwd, args) {
	const result = git(cwd, args);
	if (result.status !== 0) fail(result.stderr || result.stdout || `git ${args[0]} failed`);
	return result.stdout;
}

function porcelainPaths(text) {
	const paths = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		const path = line.slice(3).trim();
		if (path.includes(' -> ')) fail('Refusing to publish a renamed file.');
		paths.push(path);
	}
	return paths;
}

function namePaths(text) {
	return text.split('\n').map((line) => line.trim()).filter(Boolean);
}

function allowed(path) {
	return allowedExact.has(path) || path.startsWith('assets/speakers/');
}

function localOnly(path) {
	return path === '.env' || path === 'data/private' || path.startsWith('data/private/');
}

function gh(args) {
	return spawnSync('gh', args, { cwd: publishRoot, encoding: 'utf8' });
}

function openPullRequest() {
	const day = new Date().toISOString().slice(0, 10);
	let branch = `schedule/${day}`;
	let pushed = git(publishRoot, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
	if (pushed.status !== 0) {
		branch = `schedule/${day}-${Date.now()}`;
		pushed = git(publishRoot, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
		if (pushed.status !== 0) fail(`The schedule branch was not pushed. ${pushed.stderr || pushed.stdout || ''}`);
	}
	const listed = gh(['pr', 'list', '--repo', 'solo-io/atecon.dev', '--head', branch, '--base', 'main', '--state', 'open', '--json', 'url']);
	if (listed.status !== 0) fail(listed.stderr || listed.stdout || 'Could not check for an open schedule pull request.');
	const existing = JSON.parse(listed.stdout || '[]');
	if (existing[0]?.url) {
		console.log(existing[0].url);
		return;
	}
	const created = gh([
		'pr', 'create',
		'--repo', 'solo-io/atecon.dev',
		'--base', 'main',
		'--head', branch,
		'--title', 'Update the public schedule',
		'--body', 'The sheet pull passed the public-file checks.',
	]);
	if (created.status !== 0) fail(created.stderr || created.stdout || 'The pull request was not opened.');
	console.log(created.stdout.trim());
}

function restore() {
	git(publishRoot, ['restore', '--staged', '--worktree', '--', 'data/schedule.json', 'index.html', 'llms.txt', 'assets/speakers']);
	git(publishRoot, ['clean', '-fd', '--', 'assets/speakers']);
}

function linkLocal(name) {
	const source = resolve(root, name);
	const target = resolve(publishRoot, name);
	if (!existsSync(source)) fail(`Missing local ${name}.`);
	if (existsSync(target)) {
		if (lstatSync(target).isSymbolicLink()) return;
		fail(`The publish checkout has its own ${name}.`);
	}
	symlinkSync(source, target);
}

const remote = gitOk(root, ['remote', 'get-url', 'origin']).trim();
if (!remote.includes('atecon.dev')) fail('Refusing to publish because origin is not the atecon.dev repository.');

gitOk(root, ['fetch', 'origin', 'main']);
if (!existsSync(resolve(publishRoot, '.git'))) {
	const added = git(root, ['worktree', 'add', '--detach', publishRoot, 'origin/main']);
	if (added.status !== 0) fail(added.stderr || added.stdout || 'Could not prepare the publish checkout.');
}

linkLocal('.env');
linkLocal('data/private');

const dirty = porcelainPaths(gitOk(publishRoot, ['status', '--porcelain'])).filter((path) => !localOnly(path));
if (dirty.length) fail('Refusing to publish because the publish checkout has local changes.');

const unpushed = namePaths(gitOk(publishRoot, ['diff', '--name-only', 'origin/main...HEAD']));
if (unpushed.length) {
	if (unpushed.some((path) => !allowed(path))) {
		fail('Refusing to publish because unpushed commits include files outside the public schedule.');
	}
	openPullRequest();
}

gitOk(publishRoot, ['checkout', '--detach', 'origin/main']);
const pulled = spawnSync(process.execPath, [resolve(publishRoot, 'scripts/pull-schedule.mjs')], {
	cwd: publishRoot,
	encoding: 'utf8',
});
if (pulled.status !== 0) fail(pulled.stderr || pulled.stdout || 'The schedule pull failed.');
const rendered = spawnSync(process.execPath, [resolve(publishRoot, 'scripts/render.mjs')], {
	cwd: publishRoot,
	encoding: 'utf8',
});
if (rendered.status !== 0) {
	restore();
	fail(rendered.stderr || rendered.stdout || 'The page render failed.');
}

const changed = porcelainPaths(gitOk(publishRoot, ['status', '--porcelain'])).filter((path) => !localOnly(path));
if (!changed.length) {
	console.log('No public schedule changes.');
	process.exit(0);
}
if (changed.length === 1 && changed[0] === 'data/schedule.json') {
	const previous = gitOk(publishRoot, ['show', 'HEAD:data/schedule.json']);
	const next = readFileSync(resolve(publishRoot, 'data/schedule.json'), 'utf8');
	const rowsOf = (text) => JSON.stringify(JSON.parse(text).rows);
	if (rowsOf(previous) === rowsOf(next)) {
		restore();
		console.log('No public schedule changes.');
		process.exit(0);
	}
}
if (changed.some((path) => !allowed(path))) {
	restore();
	fail('Refusing to publish because the sheet changed files outside the public schedule.');
}

let schedule;
try {
	schedule = JSON.parse(readFileSync(resolve(publishRoot, 'data/schedule.json'), 'utf8'));
} catch {
	restore();
	fail('Refusing to publish because the public schedule is not readable JSON.');
}
const referenced = new Set();
for (const row of schedule.rows || []) {
	if (row.tbd === true && (row.speaker || row.title || row.abstract || row.photos)) {
		restore();
		fail('Refusing to publish because an unannounced slot still has speaker details.');
	}
	for (const photo of row.photos || []) {
		const base = String(photo?.src || '').split('/').pop();
		if (base) referenced.add(base);
	}
}
for (const path of changed) {
	if (!path.startsWith('assets/speakers/')) continue;
	const code = gitOk(publishRoot, ['status', '--porcelain', '--', path]).slice(0, 2);
	if (code.includes('D')) continue;
	if (!referenced.has(path.split('/').pop())) {
		restore();
		fail('Refusing to publish a portrait that is not on the public schedule.');
	}
	const problem = publicTextProblem(readFileSync(resolve(publishRoot, path)).toString('latin1'), path);
	if (problem && /source identifier|credential/.test(problem)) {
		restore();
		fail(problem);
	}
}
for (const path of ['data/schedule.json', 'index.html', 'llms.txt']) {
	if (!changed.includes(path)) continue;
	const problem = publicTextProblem(readFileSync(resolve(publishRoot, path), 'utf8'), path);
	if (problem) {
		restore();
		fail(problem);
	}
}

gitOk(publishRoot, ['add', '--', 'data/schedule.json', 'index.html', 'llms.txt', 'assets/speakers']);
const staged = namePaths(gitOk(publishRoot, ['diff', '--cached', '--name-only']));
if (staged.some((path) => !allowed(path))) {
	restore();
	fail('Refusing to publish because the commit would include a file outside the public schedule.');
}

const committed = git(publishRoot, ['commit', '-m', 'Update the public schedule from the sheet.']);
if (committed.status !== 0) {
	restore();
	fail(committed.stderr || committed.stdout || 'The commit was not created.');
}
openPullRequest();
console.log(`Opened a pull request with ${staged.length} public schedule files.`);

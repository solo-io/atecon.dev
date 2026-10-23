import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const PNG_DROP = new Set(['tEXt', 'iTXt', 'zTXt', 'eXIf', 'tIME']);

function stripJpeg(buffer) {
	if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer;
	const parts = [buffer.subarray(0, 2)];
	let i = 2;
	while (i + 1 < buffer.length) {
		if (buffer[i] !== 0xff) return buffer;
		const marker = buffer[i + 1];
		if (marker === 0xd9 || marker === 0xda) {
			parts.push(buffer.subarray(i));
			return Buffer.concat(parts);
		}
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
			parts.push(buffer.subarray(i, i + 2));
			i += 2;
			continue;
		}
		if (i + 4 > buffer.length) return buffer;
		const length = buffer.readUInt16BE(i + 2);
		if (length < 2 || i + 2 + length > buffer.length) return buffer;
		const end = i + 2 + length;
		const metadata = marker === 0xfe || (marker >= 0xe0 && marker <= 0xef);
		if (!metadata) parts.push(buffer.subarray(i, end));
		i = end;
	}
	return buffer;
}

function stripPng(buffer) {
	if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIG)) return buffer;
	const parts = [PNG_SIG];
	let i = 8;
	while (i + 12 <= buffer.length) {
		const length = buffer.readUInt32BE(i);
		const type = buffer.subarray(i + 4, i + 8).toString('ascii');
		const end = i + 12 + length;
		if (end > buffer.length) return buffer;
		if (!PNG_DROP.has(type)) parts.push(buffer.subarray(i, end));
		i = end;
		if (type === 'IEND') break;
	}
	return Buffer.concat(parts);
}

export function stripImageMeta(buffer) {
	if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return stripJpeg(buffer);
	if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIG)) return stripPng(buffer);
	return buffer;
}

export async function stripImageFile(path) {
	const before = await readFile(path);
	const after = stripImageMeta(before);
	if (after.length === before.length && after.equals(before)) return false;
	if (after.length < 32) return false;
	await writeFile(path, after);
	return true;
}

export async function stripPublishedImages(root) {
	const paths = [join(root, 'assets/sky-slc.jpg')];
	try {
		const names = await readdir(join(root, 'assets/speakers'));
		for (const name of names) {
			if (/^[a-z0-9-]+\.(jpe?g|png|webp)$/i.test(name)) paths.push(join(root, 'assets/speakers', name));
		}
	} catch {
		// The portraits folder is created when a speaker photo is published.
	}
	let stripped = 0;
	for (const path of paths) {
		try {
			if (await stripImageFile(path)) stripped += 1;
		} catch {
			// A missing venue photo should not abort the schedule pull.
		}
	}
	return stripped;
}

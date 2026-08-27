import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every colour and type value in a component resolves from a --mk-* token: no hex, no font
// family literal. The vendored tokens file is the one place hex lives, so it is skipped.
const srcRoot = join(import.meta.dirname, '..', '..');
const vendored = join(srcRoot, 'lib', 'styles', 'tokens.css');
const checked = /\.(svelte|css|ts|html)$/;

const walk = (dir: string): string[] =>
	readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		return statSync(path).isDirectory() ? walk(path) : [path];
	});

const hex = /#[0-9a-fA-F]{3,8}\b/g;
const fontFamily = /font-family:\s*([^;]+);/g;

const offences = (file: string): string[] => {
	const text = readFileSync(file, 'utf8');
	const hits = [...text.matchAll(hex)].map((m) => `hex colour ${m[0]}`);
	for (const m of text.matchAll(fontFamily)) {
		if (!m[1].trim().startsWith('var(--mk-')) hits.push(`font-family literal ${m[1].trim()}`);
	}
	return hits.map((h) => `${relative(srcRoot, file)}: ${h}`);
};

describe('components use tokens only', () => {
	const files = walk(srcRoot).filter(
		(f) => checked.test(f) && f !== vendored && f !== import.meta.filename
	);

	it('scans the component sources', () => {
		expect(files.length).toBeGreaterThan(0);
	});

	it('finds no hex colour and no font family literal', () => {
		expect(files.flatMap(offences)).toEqual([]);
	});
});

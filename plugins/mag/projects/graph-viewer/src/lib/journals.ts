import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JournalFile } from './stats';

/** Where the run records live: `$MAG_GRAPH_ROOT`, else `~/.claude/graph`. */
export const graphRoot = (env: NodeJS.ProcessEnv = process.env): string =>
	env.MAG_GRAPH_ROOT ?? join(homedir(), '.claude', 'graph');

/** Every `journal.jsonl` under the root, read once. A root that is not there reads as no runs. */
export const readJournals = (root: string): ReadonlyArray<JournalFile> => {
	const files: JournalFile[] = [];
	const walk = (dir: string, prefix: string) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const relativePath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
			if (entry.isDirectory()) walk(join(dir, entry.name), relativePath);
			else if (entry.name === 'journal.jsonl')
				files.push({ relativePath, text: readFileSync(join(dir, entry.name), 'utf8') });
		}
	};
	walk(root, '');
	return files;
};

import { describe, expect, it } from 'vitest';
import { emptyHome, homeSections } from './home';

describe('homeSections', () => {
	it('lists Graphs then Runs, both empty for an empty state', () => {
		const sections = homeSections(emptyHome);
		expect(sections.map((s) => s.title)).toEqual(['Graphs', 'Runs']);
		expect(sections.map((s) => s.count)).toEqual([0, 0]);
	});

	it('counts what the state holds', () => {
		const sections = homeSections({ graphs: [{ name: 'develop-graph' }], runs: [] });
		expect(sections[0].count).toBe(1);
		expect(sections[1].count).toBe(0);
	});
});

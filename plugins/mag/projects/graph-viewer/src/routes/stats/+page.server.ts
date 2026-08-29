import { graphRoot, readJournals } from '$lib/journals';
import { buildStats } from '$lib/stats';
import type { PageServerLoad } from './$types';

// The journals are read here and nowhere else: the browser never touches the filesystem, and the
// viewer never writes.
export const load: PageServerLoad = () => {
	const root = graphRoot();
	return { root, stats: buildStats(readJournals(root), Date.now()) };
};

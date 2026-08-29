// The stats page is a function of the loaded stats: every tile and every bar on it is derived
// here, so the page itself only lays them out.
import type { Bar } from './components/chart/bars';
import { formatDuration, formatMoment, formatUsd, type RunOutcome, type Stats } from './stats';

export type Tile = {
	readonly label: string;
	readonly value: string;
	readonly tone?: RunOutcome;
};

/** The headline row: what the machine has run, what it cost, and how the runs ended. */
export const headline = (stats: Stats): ReadonlyArray<Tile> => [
	{ label: 'runs', value: String(stats.runs) },
	{ label: 'graphs', value: String(stats.graphs) },
	{ label: 'tickets', value: String(stats.tickets) },
	{ label: 'projects', value: String(stats.projects) },
	{ label: 'node runs', value: String(stats.totalExecutions) },
	{ label: 'cost', value: formatUsd(stats.totalCostUsd) },
	{ label: 'wall time', value: formatDuration(stats.totalWallMs) },
	...stats.outcomes.map((entry) => ({
		label: `runs ${entry.outcome}`,
		value: String(entry.runs),
		tone: entry.outcome
	}))
];

/** Total time per node, longest first: a composite is drawn in the marker colour. */
export const nodeTimeBars = (stats: Stats): ReadonlyArray<Bar> =>
	stats.nodes.map((node) => ({
		label: node.node,
		value: node.totalMs,
		display: formatDuration(node.totalMs),
		tone: node.composites > 0 ? ('alt' as const) : ('primary' as const)
	}));

/** Total cost per node, dearest first. A node that never paid anything is not a bar. */
export const nodeCostBars = (stats: Stats): ReadonlyArray<Bar> =>
	stats.nodes
		.filter((node) => node.totalCostUsd > 0)
		.slice()
		.sort((a, b) => b.totalCostUsd - a.totalCostUsd)
		.map((node) => ({
			label: node.node,
			value: node.totalCostUsd,
			display: formatUsd(node.totalCostUsd),
			tone: 'alt' as const
		}));

/** One bar per run, newest at the top, coloured by how the run ended. */
export const runBars = (stats: Stats): ReadonlyArray<Bar> =>
	stats.runList.map((run) => ({
		label: `${run.ticket} ${formatMoment(run.startedAt)}`,
		value: run.durationMs,
		display: formatDuration(run.durationMs),
		tone: run.outcome
	}));

/** How often each failure tag ended a node run. */
export const failureBars = (stats: Stats): ReadonlyArray<Bar> =>
	stats.failureTags.map((entry) => ({
		label: entry.tag,
		value: entry.count,
		display: String(entry.count),
		tone: 'fail' as const
	}));

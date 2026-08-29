import { describe, expect, it } from 'vitest';
import {
	buildStats,
	executionsOf,
	formatDuration,
	formatMoment,
	formatUsd,
	locate,
	openStarts,
	parseJournal,
	share,
	summarise,
	type JournalFile
} from './stats';

// A hand-written journal, in the shape the pipeline writes: `graph/journal@3` rows, a start and an
// end per node run. `wrap` encloses `build` and reports its session, so it re-sums `build`'s cost;
// `sibling` merely runs in parallel with `wrap` and pays its own way.
const runOne = [
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"develop-graph","attempt":1,"timestamp":"2026-08-01T10:00:00.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"checkout","attempt":1,"timestamp":"2026-08-01T10:00:01.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"checkout","attempt":1,"timestamp":"2026-08-01T10:00:03.000Z","replayed":false,"input":{},"outcome":"ok","success":{"branch":"feat/x"}}`,
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"wrap","attempt":1,"timestamp":"2026-08-01T10:00:04.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"sibling","attempt":1,"timestamp":"2026-08-01T10:00:04.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"build","attempt":1,"timestamp":"2026-08-01T10:00:05.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"sibling","attempt":1,"timestamp":"2026-08-01T10:00:06.000Z","replayed":false,"input":{},"outcome":"ok","success":{"sessions":["s-sibling"],"costUsd":1}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"build","attempt":1,"timestamp":"2026-08-01T10:00:09.000Z","replayed":false,"input":{},"outcome":"ok","success":{"sessions":["s-build"],"costUsd":2.5}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"wrap","attempt":1,"timestamp":"2026-08-01T10:00:10.000Z","replayed":false,"input":{},"outcome":"ok","success":{"sessions":["s-build"],"costUsd":2.5}}`,
	`{"schema":"graph/journal@3","event":"start","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"cached","attempt":1,"timestamp":"2026-08-01T10:00:11.000Z","input":{}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"cached","attempt":1,"timestamp":"2026-08-01T10:00:12.000Z","replayed":true,"input":{},"outcome":"ok","success":{"sessions":["s-cached"],"costUsd":99}}`,
	`not json at all`,
	`{"schema":"graph/journal@1","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","node":"legacy","attempt":1,"replayed":false,"input":{},"startedAt":"2026-08-01T10:00:00.000Z","endedAt":"2026-08-01T10:00:01.000Z","outcome":"ok","success":{}}`,
	`{"schema":"graph/journal@3","event":"end","runId":"run-1","ticket":"GH-1","graph":"develop-graph","repoRoot":"/repo","sha":"a1","pipelineSha":"p1","node":"develop-graph","attempt":1,"timestamp":"2026-08-01T10:00:20.000Z","replayed":false,"input":{},"outcome":"ok","success":{"costUsd":3.5}}`
].join('\n');

// `graph/journal@2`: no `pipelineSha`, and the run dies on a tagged failure.
const runTwo = [
	`{"schema":"graph/journal@2","event":"start","runId":"run-2","ticket":"GH-2","graph":"develop-graph","repoRoot":"/repo","sha":"a2","node":"build","attempt":1,"timestamp":"2026-08-02T09:00:00.000Z","input":{}}`,
	`{"schema":"graph/journal@2","event":"end","runId":"run-2","ticket":"GH-2","graph":"develop-graph","repoRoot":"/repo","sha":"a2","node":"build","attempt":1,"timestamp":"2026-08-02T09:00:30.000Z","replayed":false,"input":{},"outcome":"ok","success":{"sessions":["s-b2"],"costUsd":null}}`,
	`{"schema":"graph/journal@2","event":"start","runId":"run-2","ticket":"GH-2","graph":"develop-graph","repoRoot":"/repo","sha":"a2","node":"review-diff","attempt":1,"timestamp":"2026-08-02T09:00:31.000Z","input":{}}`,
	`{"schema":"graph/journal@2","event":"end","runId":"run-2","ticket":"GH-2","graph":"develop-graph","repoRoot":"/repo","sha":"a2","node":"review-diff","attempt":1,"timestamp":"2026-08-02T09:01:31.000Z","replayed":false,"input":{},"outcome":"fail","tag":"REVIEW_BLOCKED"}`
].join('\n');

// A node that started and never ended: the run was killed mid-node.
const runThree = [
	`{"schema":"graph/journal@3","event":"start","runId":"run-3","ticket":"GH-3","graph":"envision","repoRoot":"/repo","sha":"a3","pipelineSha":"p3","node":"envision-notation","attempt":1,"timestamp":"2026-08-03T08:00:00.000Z","input":{}}`
].join('\n');

const files: ReadonlyArray<JournalFile> = [
	{ relativePath: 'proj-a/GH-1/run-1/journal.jsonl', text: runOne },
	{ relativePath: 'proj-b/GH-2/run-2/journal.jsonl', text: runTwo },
	{ relativePath: 'proj-b/GH-3/run-3/journal.jsonl', text: runThree }
];

// Ten minutes after run-3's only row, so it is still in flight rather than abandoned.
const shortlyAfter = Date.parse('2026-08-03T08:10:00.000Z');
const muchLater = Date.parse('2026-09-01T00:00:00.000Z');

describe('parseJournal', () => {
	it('keeps start and end rows and skips a line it cannot use', () => {
		const rows = parseJournal(runOne);
		expect(rows.filter((row) => row.event === 'start')).toHaveLength(6);
		// The unparsable line and the @1 row carrying no event are both gone.
		expect(rows.some((row) => row.node === 'legacy')).toBe(false);
	});

	it('reads cost, sessions and the failure tag off an end row', () => {
		const rows = parseJournal(runTwo);
		const build = rows.find((row) => row.node === 'build' && row.event === 'end');
		expect(build?.costUsd).toBeNull();
		expect(build?.sessions).toEqual(['s-b2']);
		expect(rows.find((row) => row.tag !== null)?.tag).toBe('REVIEW_BLOCKED');
	});
});

describe('executionsOf', () => {
	const executions = executionsOf(parseJournal(runOne));
	const of = (node: string) => executions.find((execution) => execution.node === node);

	it('pairs a start with its end and subtracts the timestamps', () => {
		expect(of('build')?.durationMs).toBe(4000);
	});

	it('calls the node re-reporting an enclosed session a container', () => {
		expect(of('wrap')?.container).toBe(true);
	});

	it('leaves a node that merely encloses a parallel sibling alone', () => {
		// `sibling` and `build` both start inside `wrap`, and neither is `sibling`'s child.
		expect(of('sibling')?.container).toBe(false);
		expect(of('build')?.container).toBe(false);
	});

	it('marks a replayed end row', () => {
		expect(of('cached')?.replayed).toBe(true);
	});
});

describe('openStarts', () => {
	it('counts a node that started and never ended', () => {
		expect(openStarts(parseJournal(runThree))).toBe(1);
		expect(openStarts(parseJournal(runOne))).toBe(0);
	});
});

describe('summarise', () => {
	it('sums the cost of the nodes that paid it, once', () => {
		const summary = summarise(files[0], muchLater);
		// build 2.5 plus sibling 1: the container, the replay and the graph row are all out, and
		// checkout carries no cost at all.
		expect(summary?.run.costUsd).toBe(3.5);
		expect(summary?.run.executions).toBe(5);
	});

	it('takes the run row as the run outcome', () => {
		expect(summarise(files[0], muchLater)?.run.outcome).toBe('ok');
	});

	it('takes a tagged last failure as the run outcome when there is no run row', () => {
		const summary = summarise(files[1], muchLater);
		expect(summary?.run.outcome).toBe('fail');
		expect(summary?.run.tag).toBe('REVIEW_BLOCKED');
	});

	it('reads a run with a node still open as unfinished, and as abandoned once it is stale', () => {
		expect(summarise(files[2], shortlyAfter)?.run.outcome).toBe('unfinished');
		expect(summarise(files[2], muchLater)?.run.outcome).toBe('abandoned');
	});

	it('measures the run from its first start to its last end', () => {
		expect(summarise(files[0], muchLater)?.run.durationMs).toBe(20_000);
	});

	it('takes the project key from the path and the ticket from the rows', () => {
		const summary = summarise(files[1], muchLater);
		expect(summary?.run.projectKey).toBe('proj-b');
		expect(summary?.run.ticket).toBe('GH-2');
	});

	it('reports no run for a journal holding nothing it can read', () => {
		expect(summarise({ relativePath: 'x/y/z/journal.jsonl', text: 'garbage\n' }, muchLater)).toBeNull();
	});
});

describe('buildStats', () => {
	const stats = buildStats(files, shortlyAfter);

	it('counts the runs, graphs, tickets and projects', () => {
		expect(stats.runs).toBe(3);
		expect(stats.graphs).toBe(2);
		expect(stats.tickets).toBe(3);
		expect(stats.projects).toBe(2);
	});

	it('totals the cost and the wall time across runs', () => {
		expect(stats.totalCostUsd).toBe(3.5);
		expect(stats.totalWallMs).toBe(20_000 + 91_000);
	});

	it('counts the runs by outcome', () => {
		expect(stats.outcomes).toEqual([
			{ outcome: 'ok', runs: 1 },
			{ outcome: 'fail', runs: 1 },
			{ outcome: 'unfinished', runs: 1 }
		]);
	});

	it('aggregates per node, longest total first, without the graph row', () => {
		expect(stats.nodes.map((node) => node.node)).toEqual([
			'review-diff',
			'build',
			'wrap',
			'checkout',
			'sibling'
		]);
		const build = stats.nodes[1];
		expect(build.executions).toBe(2);
		expect(build.minMs).toBe(4000);
		expect(build.maxMs).toBe(30_000);
		expect(build.avgMs).toBe(17_000);
		expect(build.totalCostUsd).toBe(2.5);
		expect(build.composites).toBe(0);
	});

	it('keeps a container out of the cost columns and names it a composite', () => {
		const wrap = stats.nodes.find((node) => node.node === 'wrap');
		expect(wrap?.composites).toBe(1);
		expect(wrap?.totalCostUsd).toBe(0);
	});

	it('counts a failing execution against its node', () => {
		expect(stats.nodes.find((node) => node.node === 'review-diff')?.fails).toBe(1);
	});

	it('aggregates per graph, busiest first', () => {
		expect(stats.graphList.map((graph) => graph.graph)).toEqual(['develop-graph', 'envision']);
		const develop = stats.graphList[0];
		expect(develop.runs).toBe(2);
		expect(develop.totalCostUsd).toBe(3.5);
		expect(develop.outcomes).toEqual([
			{ outcome: 'ok', runs: 1 },
			{ outcome: 'fail', runs: 1 }
		]);
	});

	it('lists the runs newest first', () => {
		expect(stats.runList.map((run) => run.ticket)).toEqual(['GH-3', 'GH-2', 'GH-1']);
	});

	it('counts the failure tags', () => {
		expect(stats.failureTags).toEqual([{ tag: 'REVIEW_BLOCKED', count: 1 }]);
	});

	it('reports a journal it could read nothing from rather than dropping it silently', () => {
		const withGarbage = buildStats([...files, { relativePath: 'p/t/r/journal.jsonl', text: '' }], shortlyAfter);
		expect(withGarbage.skippedJournals).toBe(1);
		expect(withGarbage.runs).toBe(3);
	});
});

describe('formatting', () => {
	it('writes an hour as `1h 02m` and a minute as `4m 12s`', () => {
		expect(formatDuration(3_720_000)).toBe('1h 02m');
		expect(formatDuration(252_000)).toBe('4m 12s');
		expect(formatDuration(9000)).toBe('9s');
		expect(formatDuration(120)).toBe('120ms');
		expect(formatDuration(-1)).toBe('-');
	});

	it('writes money with two decimals', () => {
		expect(formatUsd(12.3449)).toBe('$12.34');
		expect(formatUsd(0)).toBe('$0.00');
	});

	it('writes a moment as a UTC minute', () => {
		expect(formatMoment(Date.parse('2026-08-01T10:00:20.000Z'))).toBe('2026-08-01 10:00');
	});

	it('scales a bar against the largest value in its chart', () => {
		expect(share(5, 10)).toBe(50);
		expect(share(5, 0)).toBe(0);
	});
});

describe('locate', () => {
	it('splits the run path into project, ticket and run', () => {
		expect(locate('mag-1234/GH-9/20260829-abcd/journal.jsonl')).toEqual({
			projectKey: 'mag-1234',
			ticket: 'GH-9',
			runId: '20260829-abcd'
		});
	});
});

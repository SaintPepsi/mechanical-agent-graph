<script lang="ts">
	import { Chart } from '$lib/components/chart';
	import { Section } from '$lib/components/section';
	import { Text } from '$lib/components/text';
	import { formatDuration, formatMoment, formatUsd } from '$lib/stats';
	import { failureBars, headline, nodeCostBars, nodeTimeBars, runBars } from '$lib/stats-view';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
	let stats = $derived(data.stats);
	let tiles = $derived(headline(stats));
	let timeBars = $derived(nodeTimeBars(stats));
	let costBars = $derived(nodeCostBars(stats));
	let timeline = $derived(runBars(stats));
	let failures = $derived(failureBars(stats));
</script>

<svelte:head><title>graph viewer: stats</title></svelte:head>

<main class="page">
	<header class="masthead">
		<Text.Heading level={1}>run stats</Text.Heading>
		<p class="root">
			<a class="home" href="/">home</a>
			<span class="path">{data.root}</span>
			<span class="note">
				{stats.runs} runs read{stats.skippedJournals > 0
					? `, ${stats.skippedJournals} journals skipped (no start or end rows)`
					: ''}
			</span>
		</p>
	</header>

	<Section.Root>
		<Section.Header title="Totals" />
		<Section.Body empty="No runs on this machine.">
			{#if stats.runs > 0}
				<ul class="tiles">
					{#each tiles as tile (tile.label)}
						<li class="tile tone-{tile.tone ?? 'plain'}">
							<span class="tile-label">{tile.label}</span>
							<span class="tile-value">{tile.value}</span>
						</li>
					{/each}
				</ul>
			{/if}
		</Section.Body>
	</Section.Root>

	<Section.Root>
		<Section.Header title="Nodes" />
		<Section.Body empty="No node runs recorded.">
			{#if stats.nodes.length > 0}
				<div class="stack">
					<Text.Body muted>
						Nodes run in parallel and a composite wraps its children, so node time sums past run
						wall time. A composite's cost belongs to the node it wrapped and is not counted again
						here.
					</Text.Body>
					<div class="scroll">
						<table>
							<thead>
								<tr>
									<th scope="col">node</th>
									<th scope="col" class="num">runs</th>
									<th scope="col" class="num">min</th>
									<th scope="col" class="num">avg</th>
									<th scope="col" class="num">max</th>
									<th scope="col" class="num">total</th>
									<th scope="col" class="num">avg cost</th>
									<th scope="col" class="num">total cost</th>
									<th scope="col" class="num">fails</th>
								</tr>
							</thead>
							<tbody>
								{#each stats.nodes as node (node.node)}
									<tr>
										<th scope="row">
											{node.node}{#if node.composites > 0}<span class="mark">composite</span>{/if}
										</th>
										<td class="num">{node.executions}</td>
										<td class="num">{formatDuration(node.minMs)}</td>
										<td class="num">{formatDuration(node.avgMs)}</td>
										<td class="num">{formatDuration(node.maxMs)}</td>
										<td class="num">{formatDuration(node.totalMs)}</td>
										<td class="num">{formatUsd(node.avgCostUsd)}</td>
										<td class="num">{formatUsd(node.totalCostUsd)}</td>
										<td class="num" class:bad={node.fails > 0}>{node.fails}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<div class="charts">
						<Chart.Bars bars={timeBars} caption="total time per node" />
						<Chart.Bars bars={costBars} caption="total cost per node" />
					</div>
				</div>
			{/if}
		</Section.Body>
	</Section.Root>

	<Section.Root>
		<Section.Header title="Graphs" />
		<Section.Body empty="No graphs run yet.">
			{#if stats.graphList.length > 0}
				<div class="scroll">
					<table>
						<thead>
							<tr>
								<th scope="col">graph</th>
								<th scope="col" class="num">runs</th>
								<th scope="col" class="num">min</th>
								<th scope="col" class="num">avg</th>
								<th scope="col" class="num">max</th>
								<th scope="col" class="num">avg cost</th>
								<th scope="col" class="num">total cost</th>
								<th scope="col">outcomes</th>
							</tr>
						</thead>
						<tbody>
							{#each stats.graphList as graph (graph.graph)}
								<tr>
									<th scope="row">{graph.graph}</th>
									<td class="num">{graph.runs}</td>
									<td class="num">{formatDuration(graph.minMs)}</td>
									<td class="num">{formatDuration(graph.avgMs)}</td>
									<td class="num">{formatDuration(graph.maxMs)}</td>
									<td class="num">{formatUsd(graph.avgCostUsd)}</td>
									<td class="num">{formatUsd(graph.totalCostUsd)}</td>
									<td>
										{#each graph.outcomes as outcome (outcome.outcome)}
											<span class="pill tone-{outcome.outcome}">{outcome.runs} {outcome.outcome}</span>
										{/each}
									</td>
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			{/if}
		</Section.Body>
	</Section.Root>

	<Section.Root>
		<Section.Header title="Runs" />
		<Section.Body empty="No runs on this machine.">
			{#if stats.runList.length > 0}
				<div class="stack">
					<div class="scroll">
						<table>
							<thead>
								<tr>
									<th scope="col">ticket</th>
									<th scope="col">graph</th>
									<th scope="col">project</th>
									<th scope="col">started</th>
									<th scope="col" class="num">duration</th>
									<th scope="col" class="num">cost</th>
									<th scope="col">outcome</th>
									<th scope="col" class="num">node runs</th>
								</tr>
							</thead>
							<tbody>
								{#each stats.runList as run (run.projectKey + run.runId)}
									<tr>
										<th scope="row">{run.ticket}</th>
										<td>{run.graph}</td>
										<td class="dim">{run.projectKey}</td>
										<td class="num">{formatMoment(run.startedAt)}</td>
										<td class="num">{formatDuration(run.durationMs)}</td>
										<td class="num">{formatUsd(run.costUsd)}</td>
										<td>
											<span class="pill tone-{run.outcome}">{run.tag ?? run.outcome}</span>
										</td>
										<td class="num">{run.executions}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					</div>
					<Chart.Bars bars={timeline} caption="run duration, newest first" />
				</div>
			{/if}
		</Section.Body>
	</Section.Root>

	<Section.Root>
		<Section.Header title="Failure tags" />
		<Section.Body empty="No node run has failed.">
			{#if failures.length > 0}
				<Chart.Bars bars={failures} caption="node runs ended by tag" />
			{/if}
		</Section.Body>
	</Section.Root>
</main>

<style>
	.page {
		display: flex;
		flex-direction: column;
		gap: var(--mk-gutter);
		max-width: var(--mk-container-max);
		margin: 0 auto;
		padding: var(--mk-space-5) var(--mk-page-margin);
	}
	.masthead {
		display: flex;
		flex-direction: column;
		gap: var(--mk-space-2);
	}
	.root {
		margin: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--mk-space-3);
		font-size: var(--mk-fs-label);
		color: var(--mk-muted);
	}
	.home {
		color: var(--mk-accent);
	}
	.path {
		color: var(--mk-text);
	}
	.stack {
		display: flex;
		flex-direction: column;
		gap: var(--mk-space-4);
	}
	.charts {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: var(--mk-space-5);
	}
	.tiles {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
		gap: var(--mk-space-3);
	}
	.tile {
		display: flex;
		flex-direction: column;
		gap: var(--mk-space-1);
		padding: var(--mk-space-3);
		background: var(--mk-surface-raised);
		border: 1px solid var(--mk-border);
		border-radius: var(--mk-radius);
	}
	.tile-label {
		font-size: var(--mk-fs-label);
		letter-spacing: var(--mk-tracking-label);
		text-transform: uppercase;
		color: var(--mk-muted);
	}
	.tile-value {
		font-family: var(--mk-font-display);
		font-size: var(--mk-fs-h2);
		font-variant-numeric: tabular-nums;
		color: currentColor;
	}
	.scroll {
		overflow-x: auto;
	}
	table {
		width: 100%;
		border-collapse: collapse;
		font-size: var(--mk-fs-label);
		font-variant-numeric: tabular-nums;
	}
	th,
	td {
		padding: var(--mk-space-2) var(--mk-space-3);
		text-align: left;
		white-space: nowrap;
		border-bottom: 1px solid var(--mk-border);
	}
	thead th {
		position: sticky;
		top: 0;
		background: var(--mk-surface);
		color: var(--mk-muted);
		letter-spacing: var(--mk-tracking-label);
		text-transform: uppercase;
		font-weight: 400;
	}
	tbody th {
		font-weight: 600;
		color: var(--mk-text);
	}
	.num {
		text-align: right;
	}
	.dim {
		color: var(--mk-muted);
	}
	.bad {
		color: var(--mk-error-fg);
	}
	.mark {
		margin-left: var(--mk-space-2);
		font-size: var(--mk-fs-label);
		font-weight: 400;
		color: var(--mk-marker-2);
	}
	.pill {
		display: inline-block;
		margin-right: var(--mk-space-1);
		padding: 0 var(--mk-space-2);
		border: 1px solid currentColor;
		border-radius: var(--mk-radius);
	}
	.tone-plain {
		color: var(--mk-text);
	}
	.tone-ok {
		color: var(--mk-success-fg);
	}
	.tone-fail {
		color: var(--mk-error-fg);
	}
	.tone-unfinished {
		color: var(--mk-info-fg);
	}
	.tone-abandoned {
		color: var(--mk-warning-fg);
	}
</style>

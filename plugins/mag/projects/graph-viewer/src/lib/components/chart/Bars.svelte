<script lang="ts">
	import { share } from '$lib/stats';
	import type { Bar } from './bars';

	let { bars, caption }: { bars: ReadonlyArray<Bar>; caption?: string } = $props();
	let max = $derived(Math.max(0, ...bars.map((bar) => bar.value)));
</script>

<figure class="chart">
	{#if caption}<figcaption>{caption}</figcaption>{/if}
	<ol class="bars">
		{#each bars as bar, index (index)}
			<li class="row tone-{bar.tone ?? 'primary'}">
				<span class="label" title={bar.label}>{bar.label}</span>
				<!-- The bar is drawn, not measured: the viewBox is stretched to the row's width, so
				     only the rect's width carries meaning and the stroke stays 1px either way. -->
				<svg class="track" viewBox="0 0 100 8" preserveAspectRatio="none" aria-hidden="true">
					<rect class="fill" x="0" y="0" height="8" width={share(bar.value, max)} vector-effect="non-scaling-stroke" />
				</svg>
				<span class="value">{bar.display}</span>
			</li>
		{/each}
	</ol>
</figure>

<style>
	.chart {
		margin: 0;
		display: flex;
		flex-direction: column;
		gap: var(--mk-space-2);
	}
	figcaption {
		font-size: var(--mk-fs-label);
		letter-spacing: var(--mk-tracking-label);
		text-transform: uppercase;
		color: var(--mk-muted);
	}
	.bars {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: var(--mk-space-1);
	}
	.row {
		display: grid;
		grid-template-columns: minmax(6rem, 14rem) 1fr minmax(4rem, auto);
		align-items: center;
		gap: var(--mk-space-3);
		font-size: var(--mk-fs-label);
	}
	.label {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--mk-muted);
	}
	.track {
		width: 100%;
		height: 8px;
		display: block;
		background: var(--mk-surface-raised);
		border: 1px solid var(--mk-border);
	}
	.fill {
		fill: currentColor;
		stroke: currentColor;
	}
	.value {
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: var(--mk-text);
	}
	.tone-primary {
		color: var(--mk-marker-1);
	}
	.tone-alt {
		color: var(--mk-marker-2);
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

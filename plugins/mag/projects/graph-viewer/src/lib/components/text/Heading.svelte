<script lang="ts">
	import type { Snippet } from 'svelte';

	let { level = 2, children }: { level?: 1 | 2 | 3; children: Snippet } = $props();
</script>

<svelte:element this={`h${level}`} class="heading level-{level}">
	{@render children()}
</svelte:element>

<style>
	.heading {
		margin: 0;
		font-family: var(--mk-font-display);
		font-weight: 600;
		letter-spacing: var(--mk-tracking-tight);
		color: var(--mk-text);
	}
	.level-1 {
		font-size: var(--mk-fs-h1);
	}
	.level-2 {
		font-size: var(--mk-fs-h2);
	}
	.level-3 {
		font-size: var(--mk-fs-body-lg);
	}
</style>

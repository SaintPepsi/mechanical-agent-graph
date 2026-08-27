<script lang="ts">
	import type { Snippet } from 'svelte';

	let { muted = false, children }: { muted?: boolean; children: Snippet } = $props();
</script>

<p class="body" class:muted>
	{@render children()}
</p>

<style>
	.body {
		margin: 0;
		font: var(--mk-font);
		color: var(--mk-text);
	}
	.muted {
		color: var(--mk-muted);
	}
</style>

<script lang="ts">
	import type { Snippet } from 'svelte';

	let { children }: { children: Snippet } = $props();
</script>

<section class="root">
	{@render children()}
</section>

<style>
	.root {
		display: flex;
		flex-direction: column;
		background: var(--mk-surface);
		border: 1px solid var(--mk-border);
		border-radius: var(--mk-radius);
	}
</style>

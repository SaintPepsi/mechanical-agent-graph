<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Text } from '$lib/components/text';

	let { empty, children }: { empty: string; children?: Snippet } = $props();
</script>

<div class="body">
	{#if children}
		{@render children()}
	{:else}
		<Text.Body muted>{empty}</Text.Body>
	{/if}
</div>

<style>
	.body {
		padding: var(--mk-space-4);
	}
</style>

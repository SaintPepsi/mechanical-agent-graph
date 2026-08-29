<script lang="ts">
	import type { Snippet } from 'svelte';
	import { Text } from '$lib/components/text';

	// A section with content renders it; one with nothing to show says so.
	let { empty, children }: { empty?: string; children?: Snippet } = $props();
</script>

<div class="body">
	{#if children}
		{@render children()}
	{:else if empty}
		<Text.Body muted>{empty}</Text.Body>
	{/if}
</div>

<style>
	.body {
		padding: var(--mk-space-4);
	}
</style>

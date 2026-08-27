<script lang="ts">
	import { Text } from '$lib/components/text';

	let { title }: { title: string } = $props();
</script>

<header class="header">
	<Text.Heading level={2}>{title}</Text.Heading>
</header>

<style>
	.header {
		padding: var(--mk-space-3) var(--mk-space-4);
		border-bottom: 1px solid var(--mk-border);
	}
</style>

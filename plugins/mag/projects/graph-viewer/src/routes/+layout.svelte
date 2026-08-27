<script lang="ts">
	import '$lib/styles/tokens.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>graph viewer</title>
</svelte:head>

{@render children()}

<style>
	:global(body) {
		margin: 0;
		background: var(--mk-bg);
		color: var(--mk-text);
		font: var(--mk-font);
	}
</style>

<script lang="ts">
	import { Section } from '$lib/components/section';
	import { Text } from '$lib/components/text';
	import { emptyHome, homeSections, type HomeState } from '$lib/home';

	let home = $state<HomeState>(emptyHome);
	let sections = $derived(homeSections(home));
</script>

<main class="page">
	<Text.Heading level={1}>graph viewer</Text.Heading>
	<p class="links"><a href="/stats">run stats</a></p>
	{#each sections as section (section.title)}
		<Section.Root>
			<Section.Header title={section.title} />
			<Section.Body empty={section.empty} />
		</Section.Root>
	{/each}
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
	.links {
		margin: 0;
		font-size: var(--mk-fs-label);
	}
	.links a {
		color: var(--mk-accent);
	}
</style>

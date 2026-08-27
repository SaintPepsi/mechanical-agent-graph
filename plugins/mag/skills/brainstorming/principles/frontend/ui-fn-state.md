# UI = fn(state)

> **Derived From:** [Separation of Concerns](../core/separation-of-concerns.md)

**Rule:** Components receive all data via props. Components emit events, never mutate state directly. Parent gates rendering — components don't check "should I render?"

**Why this works:** Pure components are predictable. Same props, same output. No hidden state, no surprising side effects. Testing is trivial: pass props, check output.

## Examples

```svelte
<!-- BAD: Logic in component -->
<script>
  import { gameState } from '$lib/stores';

  function handleClick() {
    if (gameState.player.health < 10) {
      gameState.heal();
    } else if (gameState.canAttack) {
      gameState.attack();
    }
  }
</script>

{#if gameState.player.health > 0}
  <button onclick={handleClick}>Act</button>
{/if}

<!-- GOOD: Component just renders -->
<script>
  let { label, onAction, disabled }: Props = $props();
</script>

<button onclick={onAction} {disabled}>{label}</button>
```

## When This Doesn't Apply

- **Container components** — Components that wire stores to presentational components necessarily access state. Keep them thin; push logic into stores.
- **Local UI state** — Hover states, animation states, input focus — these are UI concerns that belong in the component, not the store.


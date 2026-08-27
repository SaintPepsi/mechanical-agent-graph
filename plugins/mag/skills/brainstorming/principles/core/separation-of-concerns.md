# Separation of Concerns

**Rule:** UI renders state. Stores manage state. Pure functions compute. Don't mix responsibilities.

**Why this works:** When concerns are separated, you can change how something looks without touching how it works. You can change the algorithm without touching the UI. Changes are surgical, not exploratory.

## Examples

```svelte
<!-- BAD: Logic in component -->
<script>
  function handleClick() {
    if (player.health < 10) heal();
    else if (canAttack) attack();
    else if (enemy.isStunned) criticalHit();
  }
</script>
<button onclick={handleClick}>Act</button>

<!-- GOOD: Component just renders -->
<script>
  let { action, onAction }: Props = $props();
</script>
<button onclick={onAction}>{action.label}</button>
```

## When This Doesn't Apply

- **Prototyping** — Early exploration benefits from keeping things together. Extract once the design stabilizes.
- **Tiny components** — A 10-line component with one `if` statement doesn't need three files. Separation has overhead; apply it when complexity justifies it.


# Stable Layout / No Layout Shift

> **Derived From:** [Separation of Concerns](../core/separation-of-concerns.md)

**Rule:** Transient or conditional UI must not push existing elements around. Take it out of flow (absolute/fixed overlay) or reserve its space; never let a state toggle relayout an unrelated region. A control that appears must not move the thing the user is about to click.

**Why this works:** Layout shift breaks spatial memory and causes misclicks (a button slides under the cursor mid-click). It reads as jank and erodes trust. It is a Core Web Vital (Cumulative Layout Shift, https://web.dev/articles/cls) precisely because stability is a baseline quality bar, not a nicety. Things staying where the user last saw them is respect for their attention.

## Examples

```svelte
<!-- BAD: a conditional block in normal flow shoves the arena down when it toggles -->
{#if following}
  <div class="following-bar">Following {name} <button>Unfollow</button></div>
{/if}
<div class="arena">…</div>

<!-- GOOD: float it over the arena; toggling it moves nothing else -->
<div class="arena">
  {#if following}
    <div class="follow-badge">Following {name} <button>Unfollow</button></div>
  {/if}
  …
</div>
<style>
  .follow-badge { position: absolute; top: 10px; right: 12px; }
</style>
```

## When This Doesn't Apply

- **User-initiated expansion** — an accordion the user clicked, a form they opened. Reflow the user explicitly asked for is not a shift.
- **First render of a region that was always going to occupy that space** — reserve its height to avoid the load-time shift, but a one-time layout on navigation is expected.


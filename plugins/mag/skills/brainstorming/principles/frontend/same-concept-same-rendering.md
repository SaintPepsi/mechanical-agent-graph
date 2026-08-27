# Same Concept, Same Rendering

> **Derived From:** [Single Source of Truth](../core/single-source-of-truth.md)

**Rule:** A concept's appearance is part of its single source of truth: what it looks like lives in exactly one component. Any surface that shows the concept composes that component. When part of the component doesn't fit the new surface (interactivity, size, layout), decompose it into a presentational core plus wrappers — never write a parallel renderer with a divergent look. A capability difference (interactive vs read-only, full-size vs scaled) does **not** make it a different concept; the test is the product's view — is the user looking at the same thing?

**Why this works:** Users learn what a thing looks like once; every surface that shows it trades on that recognition. A second renderer drifts — colors, labels, affordances — and silently changes the product: the new surface shows a *different thing* while claiming to show the same one. This is also where scope-narrowing hides: "the ticket didn't mention the name label" quietly becomes an unasked product decision to drop it. Decomposing instead of forking keeps identity in one place and turns capability differences into composition (the new surface skips the wrapper, not the identity).

## Examples

```svelte
<!-- BAD: a second surface draws its own cursor markers — same data, new look.
     Glyph, color, and name drift from the arena's cursors; the product now has
     two visual languages for one concept, and "no names here" was never asked for. -->
<span class="marker" style="left: {c.x * 100}%; top: {c.y * 100}%; color: {c.color}"></span>

<!-- GOOD: one presentational <Cursor> owns the look (glyph + color + name label).
     The arena composes it inside its interactive follow wrapper; the read-only
     surface renders it bare, scaled by its container. Same cursor everywhere. -->

<!-- arena -->
<button class="follow" onclick={() => onFollow(c.key)} aria-pressed={followed}>
  <Cursor cursor={c} />
</button>

<!-- overview tile -->
<Cursor cursor={c} />
```

## When This Doesn't Apply

- **Deliberate product divergence** — the user explicitly asked the new surface to look different (a minimap that reduces players to dots, a compact list that shows initials). The divergence must be in the requirements as written, never inferred from their silence.
- **Genuinely different concept, same fields** — see the "false sharing" bullet in [Unify Shared Interfaces](../core/unify-shared-interfaces.md): if it isn't the same thing from the product's view, this rule doesn't chain them together. But be honest about the direction of that test: "the same cursor, seen from another page" is the same concept; "health bar and progress bar both have current/max" is not.

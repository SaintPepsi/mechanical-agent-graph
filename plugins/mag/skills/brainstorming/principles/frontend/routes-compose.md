# Routes Compose, Components Render

> **Derived From:** [Separation of Concerns](../core/separation-of-concerns.md)

**Rule:** A route file (`+page.svelte`, `+layout.svelte`) is wiring and layout only: it connects stores, derives view state in one-liners, and composes named components. Every named visual region is its own component — region markup never lives inline in the route. A route shell stays composition-only and under ~100 lines.

**Why this works:** Top-down generation makes "build the page" emit one file; splitting is a decision that must exist *before* code is written, and afterwards it degrades into optional refactoring that gets rationalized away. Routes are also where features accumulate, so every region written inline compounds into the next 400-line monolith. Worse, structure is contagious: the existing route is the stencil every new route copies, so one inline wiring block verbatim-copied into a new route's design is enough to make the pattern the house style. When the shell only composes, the first code on disk is the good structure, and the props/events edge of every region gets drawn at its boundary instead of dissolving into shared component scope.

## Examples

```svelte
<!-- BAD: the route renders every region inline; 400+ lines of markup,
     wiring, handlers, and CSS in one file -->
<main>
  <header>…status pill markup…</header>
  <div class="name-row">…input + multi-phase button + SVGs…</div>
  {#if mine}
    <section class="room">…roster chips, arena, cursor layer…</section>
  {:else}
    <section class="lobby">…create row, room list, online roster…</section>
  {/if}
</main>

<!-- GOOD: the route wires stores and composes named regions; each region
     is a component receiving props and emitting events -->
<main>
  <PartyHeader status={connection.status} />
  <NameEditor {presence} />
  {#if mine}
    <RoomView room={mine} cursors={roomCursors} {follow} onMove={onArenaMove} />
  {:else}
    <LobbyList {lobby} {presence} {myKey} />
  {/if}
</main>
```

## When This Doesn't Apply

- **Trivial single-region routes** — an error page or redirect stub whose entire content is one small region doesn't need a component wrapped around nothing.
- **Layout glue** — the few elements that exist purely to arrange components (a wrapping `<main>`, a header row, grid/flex containers) live in the shell; don't extract a component whose only content is layout CSS for its children.

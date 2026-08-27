# Svelte UI components — envisioning

An ideal imagination exercise: before building, picture the ideal markup as if from nothing — what exists today has no vote. Picture it as compound parts, not one block: what needs its own name, what reuses an existing primitive underneath, and whether content gets pushed as data or as components. Without this you get raw HTML standing in for a component that already exists, and one giant file with everything inlined — both mean the same fix has to be repeated everywhere it was copied.

## Notation

```svelte
<Card.Root>
  <Card.Header>
    <Text.Heading>Title</Text.Heading>
  </Card.Header>
  <Card.Body>
    <Text.Body>...</Text.Body>
  </Card.Body>
  <Card.Actions>
    <Button variant="primary">Confirm</Button>
  </Card.Actions>
</Card.Root>
```

For a component that gets created at runtime (a toaster, a modal stack, anything pushed to a store), two shapes depending on the content:

```ts
// backend-driven, fixed shape → config object
Store.push({ message, variant })

// reactive to UI state, open-ended shape → function returning compound components
Store.add((id) => <Compound.Root><Compound.Success>...</Compound.Success></Compound.Root>)
```

## What counts as one part

Granularity, not size. If you'd picture it as a separate visual or behavioral chunk rather than detail inside its parent, it gets its own `.Xyz` name (`Toast.Wrapper`, `Toast.CloseButton`, `Toast.Icon`). A part can wrap a different underlying component to keep its variants pinned down (`Toast.Icon` restricts to a fixed set of the primary `Icon` component's variants) instead of allowing anything through.

## Do this

- Before writing a raw element (`p`, `h2`, `div` with hand-rolled classes), check whether a primitive component already covers it (`Text`, `Text.Heading`, `Button`, ...) and use that instead. Hand-coding something that already exists elsewhere means the next change has two places to happen and they drift apart.
- Split a component into compound parts by granularity, not by size. One giant file with everything inlined is the same failure as raw HTML replacing a primitive: both mean a change has to be found and repeated instead of made once.
- Name siblings by behavior, not symmetry: a slot that carries behavior of its own (an extra state, a pinned variant set) earns a compound name; its structurally-parallel sibling that adds nothing over the primitive stays the bare primitive. Identical names for unequal slots hide the asymmetry.
- Inside a component, don't reach for `$effect` unless there is no other way. Derive updates from the events that cause them (a click, a function being called) and from `$state` and `$derived`, which cover almost everything. An `$effect` hides the cause of a change behind a subscription; an event handler names it.
- When a component is created at runtime, decide the push shape by content volatility: fixed, backend-driven content is a config object (`push({...})`); content that reacts to UI state or needs an open-ended shape is a function returning actual compound components (`add(fn)`).

## Worked example

```svelte
<Toast.Wrapper>
  <Toast.Icon variant="success" />
  <Toast.Body>
    <Text.Heading>Saved</Text.Heading>
    <Text.Body>Your changes were saved.</Text.Body>
  </Toast.Body>
  <Toast.CloseButton />
</Toast.Wrapper>
```

Instantiation split on the same component:

```ts
// a backend confirmation message — fixed shape
Toaster.push({ message: "Saved", variant: "success" })

// a toast that needs to react to live UI state — open-ended shape
Toaster.add((id) => (
  <Toast.Wrapper>
    <Toast.Success>...</Toast.Success>
  </Toast.Wrapper>
))
```

## Done when

- [ ] No raw HTML element stands in for a primitive component that already exists — reject the PR if it does.
- [ ] Nothing is one undivided component where compound parts should exist — reject on bad granularity the same as on raw HTML.
- [ ] No `$effect` where an event handler, `$state` or `$derived` would do; each remaining `$effect` says in one line why nothing else could.
- [ ] A runtime-created component's push shape matches its content: config object for fixed content, a function returning components for anything reactive.

# Static Class Namespacing

> **Derived From:** [Single Source of Truth](single-source-of-truth.md)

**Rule:** Group related functions under static classes. Import reads as `Domain.action()`.

**Why this works:** `Perlin.noise2D(x, y)` tells you where the function comes from. `noise2D(x, y)` could be anything. Namespaces make code self-documenting and prevent collisions.

## Examples

```typescript
// BAD: Raw exports
export function noise2D(x: number, y: number) { ... }
export function octave(x: number, y: number, octaves: number) { ... }

// Usage: noise2D(x, y) — unclear origin, collision risk

// GOOD: Namespaced
export class Perlin {
  static noise2D(x: number, y: number) { ... }
  static octave(x: number, y: number, octaves: number) { ... }
}

// Usage: Perlin.noise2D(x, y) — clear origin
```

## When This Doesn't Apply

- **Single-purpose modules** — A module that exports exactly one thing (`export function hash()`) doesn't need a class wrapper. The module path is the namespace.
- **Framework conventions** — Some frameworks expect specific export shapes (default exports, named exports). Follow framework conventions.


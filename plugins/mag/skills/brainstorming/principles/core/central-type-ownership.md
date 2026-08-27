# Central Type Ownership

> **Derived From:** [Single Source of Truth](single-source-of-truth.md)

**Rule:** Types live in `src/lib/types/` or domain folders. UI components import types, never define them.

**Why this works:** When a type is defined in a component, it's invisible to the rest of the codebase. Central types are discoverable, importable, and evolvable.

## Examples

```typescript
// BAD: Type defined in component
// src/lib/components/HitNumber.svelte
type HitType = 'normal' | 'crit' | 'poison' | 'fire';

// GOOD: Central definition
// src/lib/types/combat.ts
export type HitType = 'normal' | 'crit' | 'poison' | 'fire';
export const HitTypeColors: Record<HitType, string> = { ... };

// Component imports from central source
import { type HitType, HitTypeColors } from '$lib/types/combat';
```

## When This Doesn't Apply

- **Component-internal types** — A type used only within one component (like internal state shape) can stay local. Centralize when used in 2+ files.


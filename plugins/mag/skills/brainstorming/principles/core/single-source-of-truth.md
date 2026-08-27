# Single Source of Truth

**Rule:** Types, constants, and definitions live in one place. Everything else imports from there.

**Why this works:** When truth is scattered, changes require finding all copies. Copies drift out of sync. Bugs hide in the cracks. One source means one place to update, one place to verify.

## Examples

```typescript
// BAD: Type defined in component
// src/lib/components/HitNumber.svelte
type HitType = 'normal' | 'crit' | 'poison' | 'fire';

// Same type redefined elsewhere
// src/lib/components/DamageLog.svelte
type DamageType = 'normal' | 'critical' | 'poison' | 'fire'; // Already drifted!

// GOOD: Central definition
// src/lib/types/combat.ts
export type HitType = 'normal' | 'crit' | 'poison' | 'fire';
export const HitTypeColors: Record<HitType, string> = {
	normal: '#ffffff',
	crit: '#ff0000',
	poison: '#00ff00',
	fire: '#ff6600'
};

// Components import from central source
import { type HitType, HitTypeColors } from '$lib/types/combat';
```

Semantic conditions are definitions too. "Which situation is this?" has one authoritative home: an explicit signal designated to carry that meaning. Inferring the answer from incidental data shape (a field's presence, a list's length, a narrowed type) creates a second copy of that truth — one that silently drifts the moment anything else changes the shape.

## When This Doesn't Apply

- **Derived values** — Computed values that depend on the source of truth don't violate this principle. `fullName = firstName + lastName` isn't duplication; it's derivation.
- **Local scope** — A type used only within one file doesn't need to be centralized. Centralize when it's used in 2+ files.


# Functional Programming for Testability

> **Derived From:** [Pure Functions for Testability](pure-functions.md)

**Rule:** Extract calculation logic from stores/components into pure functions. Stores orchestrate; they don't compute.

**Why this works:** A 100-line store method is untestable without mocking everything. Ten 10-line pure functions are trivially testable — each is just input/output.

## Examples

```typescript
// BAD: Logic buried in store
class AbilityStore {
  use(id: string) {
    const ability = this.abilities[id];
    if (ability.cooldown > 0) return;
    ability.cooldown = ability.maxCooldown;
    // 50 more lines of effects, damage, etc.
  }
}

// GOOD: Pure functions, store just orchestrates
// ability/use.ts
export function canUse(ability: Ability): boolean {
  return ability.cooldown === 0;
}
export function calculateDamage(ability: Ability, stats: Stats): number {
  return ability.baseDamage * (1 + stats.power / 100);
}
export function applyCooldown(ability: Ability): Ability {
  return { ...ability, cooldown: ability.maxCooldown };
}

// store just composes
use(id: string) {
  const ability = this.abilities[id];
  if (!canUse(ability)) return;
  const damage = calculateDamage(ability, this.stats);
  this.abilities[id] = applyCooldown(ability);
  this.applyDamage(damage);
}
```

## When This Doesn't Apply

- **Trivial operations** — `x + 1` doesn't need its own function. Extract when logic is complex enough to warrant a name and tests.


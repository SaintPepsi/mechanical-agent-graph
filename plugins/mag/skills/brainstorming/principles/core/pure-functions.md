# Pure Functions for Testability

**Rule:** Extract computation into pure functions. Functions take inputs, return outputs, have no side effects.

**Why this works:** Pure functions are deterministic — same input always produces same output. No setup, no teardown, no mocking dependencies. Tests become trivial: call function, check result.

## Examples

```typescript
// BAD: Logic buried in store method
class AbilityStore {
  use(id: string) {
    const ability = this.abilities[id];
    if (ability.cooldown > 0) return;
    ability.cooldown = ability.maxCooldown;
    const damage = ability.baseDamage * (1 + this.stats.power / 100);
    this.enemy.health -= damage;
  }
}

// GOOD: Pure functions, store orchestrates
function canUse(ability: Ability): boolean {
  return ability.cooldown === 0;
}

function calculateDamage(ability: Ability, stats: Stats): number {
  return ability.baseDamage * (1 + stats.power / 100);
}

// Store just composes
use(id: string) {
  const ability = this.abilities[id];
  if (!canUse(ability)) return;
  const damage = calculateDamage(ability, this.stats);
  this.applyDamage(damage);
}
```

## When This Doesn't Apply

- **Glue code** — The orchestration layer (stores, controllers) that calls pure functions doesn't need to be pure itself. Its job is to wire things together and manage state.
- **I/O boundaries** — Functions that read files, make API calls, or interact with databases are inherently impure. Isolate them at the edges; don't try to make them pure.


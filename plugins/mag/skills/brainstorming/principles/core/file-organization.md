# File Organization

> **Derived From:** [Single Source of Truth](single-source-of-truth.md)

**Rule:** Files over ~300 lines probably need splitting. One concept per file. `index.ts` re-exports the public API.

**Why this works:** Large files hide complexity. You can't see the structure. Folders make architecture visible. Each file has one job, one reason to change.

## Examples

```
// BAD: Monolithic file
src/lib/modes/offline/engine/ability.ts (800 lines)

// GOOD: Organized folder
src/lib/modes/offline/engine/ability/
├── index.ts          # Re-exports public API
├── types.ts          # Ability types
├── use.ts            # Using abilities
├── cooldown.ts       # Cooldown logic
├── damage.ts         # Damage calculations
└── effects/          # Per-effect implementations
    ├── fireball.ts
    └── heal.ts
```

## When This Doesn't Apply

- **Cohesive small files** — A 400-line file where everything is tightly related may be better than 8 tiny files. Split when you see natural boundaries, not arbitrary line counts.
- **Test files** — Test files can be longer than source files. A comprehensive test suite for one module belongs in one test file.


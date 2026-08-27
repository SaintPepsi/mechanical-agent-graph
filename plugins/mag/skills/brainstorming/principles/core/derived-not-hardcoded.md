# Derived, Not Hardcoded

> **Derived From:** [Data Drives Behavior](data-drives-behavior.md)

**Rule:** Don't write `if (type === 'burn')`. Read behavior from the type's configuration.

**Why this works:** Hardcoded checks become stale. Someone adds a new type, forgets to update the check, behavior is wrong. Data-driven config makes the type self-describing.

## Examples

```typescript
// BAD: Hardcoded stackable effects
const STACKABLE = ['burn', 'poison', 'bleed'];
function isStackable(type: string) {
	return STACKABLE.includes(type);
}

// GOOD: Derived from effect definition
function isStackable(effect: Effect) {
	return effect.config.stackable === true;
}
```

## When This Doesn't Apply

- **Truly unique cases** — If exactly one type needs special handling and it's genuinely unique (not a pattern), an explicit check may be clearer than a config flag read by nothing else.


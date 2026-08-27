# Data Drives Behavior

**Rule:** Behavior is configured via data structures, not `if` statements that check for specific types or names.

**Why this works:** When behavior lives in data, adding a new variant means adding a row to a table, not touching code. No risk of breaking existing variants. No merge conflicts with other features.

## Examples

```typescript
// BAD: Hardcoded behavior
const STACKABLE = ['burn', 'poison', 'bleed'];
function isStackable(type: string) {
	return STACKABLE.includes(type);
}

// Every new stackable effect requires code change
if (type === 'burn') applyBurnEffect();
else if (type === 'poison') applyPoisonEffect();

// GOOD: Behavior in data
interface EffectConfig {
	stackable: boolean;
	onApply: (target: Entity) => void;
}

const EFFECTS: Record<string, EffectConfig> = {
	burn: { stackable: true, onApply: applyBurn },
	poison: { stackable: true, onApply: applyPoison },
	shield: { stackable: false, onApply: applyShield }
};

// Same code works for any effect
function applyEffect(type: string, target: Entity) {
	const config = EFFECTS[type];
	config.onApply(target);
}
```

## When This Doesn't Apply

- **Genuinely unique behavior** — If two things share no structure, forcing them into a data-driven pattern adds complexity. Three completely different systems don't need a generic "system runner."
- **Performance-critical paths** — Data-driven dispatch has overhead (lookups, indirection). In hot loops where every microsecond matters, explicit code may be faster.


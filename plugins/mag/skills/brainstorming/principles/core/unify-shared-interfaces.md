# Unify Shared Interfaces

> **Derived From:** [Data Drives Behavior](data-drives-behavior.md)

**Rule:** Extract shared structure into a common interface. Systems implement the interface; logic operates on the interface.

**Why this works:** Unified interfaces enable code reuse. Health logic works on any entity. Cooldown logic works on any ability. Write once, use everywhere.

## Examples

```typescript
// BAD: Separate player health
// playerHealth.svelte.ts
let playerHealth = $state(100);
let playerMaxHealth = $state(100);

// enemyHealth.svelte.ts
let enemyHealth = $state(50);
let enemyMaxHealth = $state(50);

// GOOD: Unified entity interface
interface Entity {
	id: string;
	health: number;
	maxHealth: number;
}

// Player is just an entity
const player: Entity = { id: 'player', health: 100, maxHealth: 100 };
const enemy: Entity = { id: 'goblin', health: 50, maxHealth: 50 };

// Same health logic works for both
function applyDamage(entity: Entity, damage: number): Entity {
	return { ...entity, health: Math.max(0, entity.health - damage) };
}
```

## When This Doesn't Apply

- **False sharing** — If two things happen to have the same fields but represent different concepts, forcing them into a shared interface couples unrelated systems. Player health and progress bar percentage both have `current/max`, but they're not the same concept.


# Stores Orchestrate, Don't Compute

> **Derived From:** [Pure Functions for Testability](../core/pure-functions.md)

**Rule:** Store methods read state, call pure functions, write state. No business logic inline.

**Why this works:** Stores are hard to test (they have state, lifecycle, reactivity). Pure functions are easy to test. Push complexity into the testable layer.

## Examples

```typescript
// BAD: Store does computation
class GameStore {
	attack() {
		const damage = this.weapon.base * (1 + this.stats.power / 100);
		const isCrit = Math.random() < this.stats.critChance;
		const finalDamage = isCrit ? damage * 2 : damage;
		this.enemy.health -= finalDamage;
		if (this.enemy.health <= 0) {
			this.gold += this.enemy.goldReward;
			this.xp += this.enemy.xpReward;
		}
	}
}

// GOOD: Store orchestrates
class GameStore {
	attack() {
		const result = Combat.calculateAttack(this.weapon, this.stats);
		this.enemy.health = Combat.applyDamage(this.enemy.health, result.damage);
		if (this.enemy.health <= 0) {
			const rewards = Rewards.calculate(this.enemy);
			this.gold += rewards.gold;
			this.xp += rewards.xp;
		}
	}
}
```

## When This Doesn't Apply

- **Glue logic** — Simple state updates (`this.count++`) don't need extraction. Extract when there's actual computation.


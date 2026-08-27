/**
 * A composite's whole spend, folded pass by pass because the journal cannot keep all of it: a
 * failed pass records its tag and no payload, and cost lives only in success payloads. `null`
 * poisons the total: one unpriced pass makes the whole figure unpriced, never silently zero.
 * Promoted from `build-under-review`'s own locals once `red-green`, `adversarial-review` and
 * `tdd-build` needed the same fold; a sibling's private helper is promoted, never copied.
 */
export interface Spend {
  readonly costUsd: number | null
  readonly sessions: readonly string[]
}

export const NO_SPEND: Spend = { costUsd: 0, sessions: [] }

export const charge = (spend: Spend, sessions: readonly string[], costUsd: number | null): Spend => ({
  costUsd: spend.costUsd === null || costUsd === null ? null : spend.costUsd + costUsd,
  sessions: [...spend.sessions, ...sessions]
})
